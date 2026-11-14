-- UNINSTALLED, READ-ONLY CANDIDATE. Collect original site evidence for a
-- correction whose reviewed split may point to another site. This is NOT a
-- cross-site posting, a decision to include any original, proof of payment, or
-- a complete project cost. The existing site review must still block unlinked
-- corrections until an independently reviewed integration is implemented.
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
DO $preflight$ BEGIN
 IF to_regprocedure('app_private.project_cost_correction_case(text,uuid)') IS NULL OR to_regprocedure('public.project_cost_historical_review(uuid)') IS NULL OR to_regclass('public.weekly_worker_paid_allocations') IS NULL OR to_regclass('public.historical_worker_attributions') IS NULL OR to_regclass('public.historical_worker_attribution_sites') IS NULL OR to_regprocedure('public.is_founder()') IS NULL OR to_regprocedure('public.session_assurance_satisfied()') IS NULL OR to_regprocedure('auth.uid()') IS NULL THEN RAISE EXCEPTION 'Original-site context prerequisites missing'; END IF;
 IF to_regprocedure('public.project_cost_correction_original_context(text,uuid)') IS NOT NULL THEN RAISE EXCEPTION 'Original-site context name collision'; END IF;
END $preflight$;
CREATE FUNCTION public.project_cost_correction_original_context(p_kind text,p_case uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_case jsonb;v_original jsonb;v_source uuid;v_worker uuid;v_start date;v_end date;v_paid date;v_gross numeric;v_sites uuid[];v_site uuid;v_history jsonb;v_rows jsonb;v_row jsonb;v_value numeric;v_sum numeric:=0;v_items jsonb:='[]'::jsonb;v_result jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance required' USING ERRCODE='42501'; END IF;
 IF p_kind IS NULL OR p_kind NOT IN ('voucher','external_worker') OR p_case IS NULL THEN RAISE EXCEPTION 'Invalid original-site context request' USING ERRCODE='22023'; END IF;
 -- This verified case reader refuses missing/changed source or sibling evidence.
 v_case:=app_private.project_cost_correction_case(p_kind,p_case);
 IF jsonb_typeof(v_case) IS DISTINCT FROM 'object' OR jsonb_typeof(v_case->'related_cases') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Original case evidence unavailable' USING ERRCODE='22023'; END IF;
 IF p_kind='voucher' THEN
  v_original:=v_case->'original_voucher';v_source:=(v_case->>'payroll_id')::uuid;v_worker:=(v_case->>'worker_id')::uuid;
  v_start:=(v_original->>'period_start')::date;v_end:=(v_original->>'period_end')::date;v_gross:=(v_original->>'gross_pay')::numeric;
  IF v_original->>'id' IS DISTINCT FROM v_source::text OR v_original->>'worker_id' IS DISTINCT FROM v_worker::text OR v_original->>'status' IS DISTINCT FROM 'paid' THEN RAISE EXCEPTION 'Original voucher identity differs' USING ERRCODE='22023'; END IF;
  SELECT array_agg(project_id ORDER BY project_id) INTO v_sites FROM (SELECT project_id FROM public.weekly_worker_paid_allocations WHERE payroll_id=v_source ORDER BY project_id LIMIT 51) s;
 ELSE
  v_original:=v_case->'original_snapshot';v_source:=(v_case->>'external_worker_id')::uuid;v_worker:=(v_original->>'person_id')::uuid;
  v_start:=(v_original->>'start')::date;v_end:=(v_original->>'end')::date;v_paid:=(v_original->>'paid_on')::date;v_gross:=(v_original->>'gross')::numeric;
  IF v_case->>'source_kind' IS DISTINCT FROM 'external_worker' OR v_original->>'kind' IS DISTINCT FROM 'external_worker' OR v_original->>'id' IS DISTINCT FROM v_source::text THEN RAISE EXCEPTION 'Original historical identity differs' USING ERRCODE='22023'; END IF;
  SELECT array_agg(project_id ORDER BY project_id) INTO v_sites FROM (SELECT s.project_id FROM public.historical_worker_attributions a JOIN public.historical_worker_attribution_sites s ON s.attribution_id=a.request_id WHERE a.source_id=v_source ORDER BY s.project_id LIMIT 51) x;
 END IF;
 IF v_source IS NULL OR v_worker IS NULL OR v_start IS NULL OR v_end IS NULL OR NOT isfinite(v_start) OR NOT isfinite(v_end) OR v_start>v_end OR v_gross IS NULL OR v_gross='NaN'::numeric OR v_gross<0 OR v_gross<>round(v_gross,2) OR v_gross>=10000000000 OR (p_kind='external_worker' AND (v_paid IS NULL OR NOT isfinite(v_paid))) THEN RAISE EXCEPTION 'Original source evidence invalid' USING ERRCODE='22023'; END IF;
 IF coalesce(cardinality(v_sites),0) NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION 'Original site allocation unavailable or exceeds 50 sites' USING ERRCODE='54000'; END IF;
 IF (SELECT count(DISTINCT x) FROM unnest(v_sites) x)<>cardinality(v_sites) OR array_position(v_sites,NULL) IS NOT NULL THEN RAISE EXCEPTION 'Original sites are duplicated or unavailable' USING ERRCODE='22023'; END IF;
 FOREACH v_site IN ARRAY v_sites LOOP
  -- The existing bounded site reader validates allocation and historical split
  -- integrity. Oversized or inconsistent sites fail the entire context closed.
  v_history:=public.project_cost_historical_review(v_site);
  IF v_history->>'project_id' IS DISTINCT FROM v_site::text THEN RAISE EXCEPTION 'Original site identity differs' USING ERRCODE='22023'; END IF;
  v_rows:=CASE WHEN p_kind='voucher' THEN v_history->'base'->'paid_allocations' ELSE v_history->'historical' END;
  IF jsonb_typeof(v_rows) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Original site evidence unavailable' USING ERRCODE='22023'; END IF;
  SELECT jsonb_agg(x) INTO v_row FROM jsonb_array_elements(v_rows) x WHERE CASE WHEN p_kind='voucher' THEN x->>'payroll_id'=v_source::text ELSE x->>'source_id'=v_source::text END;
  IF coalesce(jsonb_array_length(v_row),0)<>1 THEN RAISE EXCEPTION 'Original site source missing or ambiguous' USING ERRCODE='22023'; END IF;
  v_row:=v_row->0;
  IF v_row->>'worker_id' IS DISTINCT FROM v_worker::text OR v_row->>'period_start' IS DISTINCT FROM v_start::text OR v_row->>'period_end' IS DISTINCT FROM v_end::text THEN RAISE EXCEPTION 'Original site source identity differs' USING ERRCODE='22023'; END IF;
  IF p_kind='voucher' THEN
   IF (v_row->>'voucher_gross')::numeric IS DISTINCT FROM v_gross THEN RAISE EXCEPTION 'Original voucher gross differs' USING ERRCODE='22023'; END IF;
   v_value:=(v_row->>'gross')::numeric;
  ELSE
   IF (v_row->>'original_gross')::numeric IS DISTINCT FROM v_gross OR (v_row->>'paid_on')::date IS DISTINCT FROM v_paid OR (v_row->>'overlapping_vouchers')::bigint IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'Original historical evidence or voucher overlap requires review' USING ERRCODE='22023'; END IF;
   v_value:=(v_row->>'site_gross')::numeric;
  END IF;
  IF v_value IS NULL OR v_value='NaN'::numeric OR v_value<0 OR v_value<>round(v_value,2) OR v_value>=10000000000 THEN RAISE EXCEPTION 'Original site amount invalid' USING ERRCODE='22023'; END IF;
  v_sum:=v_sum+v_value;v_items:=v_items||jsonb_build_array(jsonb_build_object('project_id',v_site,'gross',v_value::numeric(12,2)::text));
 END LOOP;
 IF v_sum IS DISTINCT FROM v_gross THEN RAISE EXCEPTION 'Original site total differs from source' USING ERRCODE='22023'; END IF;
 -- The fingerprint ties this context to the entire verified case and sibling
 -- snapshot. It is a freshness signal, not proof of correctness or payment.
 v_result:=jsonb_build_object('source_kind',p_kind,'case_id',p_case,'source_id',v_source,'worker_id',v_worker,'period_start',v_start,'period_end',v_end,'original_gross',v_gross::numeric(12,2)::text,'case_fingerprint',encode(sha256(convert_to(v_case::text,'UTF8')),'hex'),'sites',v_items);
 IF octet_length(v_result::text)>16384 THEN RAISE EXCEPTION 'Original site context too large' USING ERRCODE='54000'; END IF;
 RETURN v_result;
END $$;
REVOKE ALL ON FUNCTION public.project_cost_correction_original_context(text,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.project_cost_correction_original_context(text,uuid) TO authenticated;
DO $postflight$ BEGIN
 IF has_function_privilege('anon','public.project_cost_correction_original_context(text,uuid)','EXECUTE') OR has_function_privilege('service_role','public.project_cost_correction_original_context(text,uuid)','EXECUTE') OR NOT has_function_privilege('authenticated','public.project_cost_correction_original_context(text,uuid)','EXECUTE') OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.project_cost_correction_original_context(text,uuid)'::regprocedure AND prosecdef AND provolatile='s' AND proconfig @> ARRAY['search_path=""']) THEN RAISE EXCEPTION 'Unexpected original-site context privileges'; END IF;
END $postflight$;
