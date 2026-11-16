-- UNINSTALLED, READ-ONLY CANDIDATE. One-source, all-site gross illustration.
-- Nothing is saved or posted; this is not a project total, transfer or proof
-- of payment. It must not be added to per-project review totals. Existing
-- corrected project reviews continue to block unlinked corrections.
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
DO $preflight$ BEGIN
 IF to_regprocedure('public.project_cost_correction_original_context(text,uuid)') IS NULL OR to_regprocedure('public.project_cost_correction_attribution(text,uuid,integer)') IS NULL OR to_regprocedure('public.is_founder()') IS NULL OR to_regprocedure('public.session_assurance_satisfied()') IS NULL OR to_regprocedure('auth.uid()') IS NULL THEN RAISE EXCEPTION 'Cross-site preview prerequisites missing'; END IF;
 IF to_regprocedure('public.project_cost_cross_site_evidence(text,uuid)') IS NOT NULL OR to_regprocedure('public.project_cost_cross_site_preview(text,uuid,jsonb,boolean)') IS NOT NULL THEN RAISE EXCEPTION 'Cross-site preview name collision'; END IF;
END $preflight$;
CREATE FUNCTION public.project_cost_cross_site_evidence(p_kind text,p_case uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_original jsonb;v_correction jsonb;v_result jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance required' USING ERRCODE='42501'; END IF;
 IF p_kind IS NULL OR p_kind NOT IN ('voucher','external_worker') OR p_case IS NULL THEN RAISE EXCEPTION 'Invalid cross-site evidence request' USING ERRCODE='22023'; END IF;
 -- Both STABLE readers share this statement snapshot. They do not lock later
 -- writers or prove the evidence is complete in the real world.
 v_original:=public.project_cost_correction_original_context(p_kind,p_case);
 v_correction:=public.project_cost_correction_attribution(p_kind,p_case,NULL);
 IF v_original->>'source_kind' IS DISTINCT FROM p_kind OR v_original->>'case_id' IS DISTINCT FROM p_case::text OR v_correction->>'source_kind' IS DISTINCT FROM p_kind OR v_correction->>'case_id' IS DISTINCT FROM p_case::text OR v_original->'case_snapshot' IS DISTINCT FROM v_correction->'case' THEN RAISE EXCEPTION 'Cross-site case evidence differs' USING ERRCODE='22023'; END IF;
 v_result:=jsonb_build_object('source_kind',p_kind,'case_id',p_case,'original',v_original,'correction',v_correction);
 IF octet_length(v_result::text)>262144 THEN RAISE EXCEPTION 'Cross-site evidence too large' USING ERRCODE='54000'; END IF;
 RETURN v_result;
END $$;

CREATE FUNCTION public.project_cost_cross_site_preview(p_kind text,p_case uuid,p_expected jsonb,p_ack boolean) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_now jsonb;v_original jsonb;v_correction jsonb;v_case jsonb;v_attribution jsonb;v_sites jsonb;v_split jsonb;v_row record;v_initial numeric;v_change numeric;v_sum_initial numeric:=0;v_sum_change numeric:=0;v_gross numeric;v_total numeric;v_result jsonb;v_items jsonb:='[]'::jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance required' USING ERRCODE='42501'; END IF;
 IF p_kind IS NULL OR p_kind NOT IN ('voucher','external_worker') OR p_case IS NULL OR p_ack IS DISTINCT FROM true OR jsonb_typeof(p_expected) IS DISTINCT FROM 'object' OR octet_length(p_expected::text)>262144 THEN RAISE EXCEPTION 'Invalid cross-site review' USING ERRCODE='22023'; END IF;
 v_now:=public.project_cost_cross_site_evidence(p_kind,p_case);
 IF v_now IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'Cross-site evidence changed; reload and review' USING ERRCODE='40001'; END IF;
 v_original:=v_now->'original';v_correction:=v_now->'correction';v_case:=v_correction->'case';v_attribution:=v_correction->'attribution';v_sites:=v_original->'sites';
 IF jsonb_typeof(v_attribution) IS DISTINCT FROM 'object' OR (v_attribution->>'case_changed')::boolean IS DISTINCT FROM false OR v_attribution->'case_snapshot' IS DISTINCT FROM v_case OR coalesce(v_case->>'status','') NOT IN ('settled_external','no_transfer') OR jsonb_typeof(v_case->'related_cases') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Current resolved correction evidence required' USING ERRCODE='22023'; END IF;
 -- Until a reviewed multi-case cross-site protocol exists, do not silently
 -- ignore any sibling case even if it is resolved or has a zero split.
 IF jsonb_array_length(v_case->'related_cases')<>1 OR v_case->'related_cases'->0->>'id' IS DISTINCT FROM p_case::text OR v_case->'related_cases'->0->>'status' IS DISTINCT FROM v_case->>'status' THEN RAISE EXCEPTION 'Cross-site review requires exactly one original-period case' USING ERRCODE='22023'; END IF;
 v_split:=v_attribution->'split';
 IF jsonb_typeof(v_sites) IS DISTINCT FROM 'array' OR jsonb_array_length(v_sites) NOT BETWEEN 1 AND 50 OR jsonb_typeof(v_split) IS DISTINCT FROM 'array' OR jsonb_array_length(v_split)>50 THEN RAISE EXCEPTION 'Cross-site split unavailable or too large' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_sites) s WHERE jsonb_typeof(s) IS DISTINCT FROM 'object' OR jsonb_typeof(s->'project_id') IS DISTINCT FROM 'string' OR (s->>'project_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR jsonb_typeof(s->'gross') IS DISTINCT FROM 'string' OR (s->>'gross') !~ '^(0|[1-9][0-9]{0,9})\.[0-9]{2}$') OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_split) s WHERE jsonb_typeof(s) IS DISTINCT FROM 'object' OR jsonb_typeof(s->'project_id') IS DISTINCT FROM 'string' OR (s->>'project_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR jsonb_typeof(s->'gross_change') IS DISTINCT FROM 'string' OR (s->>'gross_change') !~ '^-?(0|[1-9][0-9]{0,9})\.[0-9]{2}$' OR (s->>'gross_change')::numeric=0) THEN RAISE EXCEPTION 'Invalid cross-site amount or identity' USING ERRCODE='22023'; END IF;
 IF jsonb_array_length(v_sites)<>(SELECT count(DISTINCT s->>'project_id') FROM jsonb_array_elements(v_sites) s) OR jsonb_array_length(v_split)<>(SELECT count(DISTINCT s->>'project_id') FROM jsonb_array_elements(v_split) s) THEN RAISE EXCEPTION 'Duplicate or missing cross-site identity' USING ERRCODE='22023'; END IF;
 IF jsonb_typeof(v_original->'original_gross') IS DISTINCT FROM 'string' OR (v_original->>'original_gross') !~ '^(0|[1-9][0-9]{0,9})\.[0-9]{2}$' OR jsonb_typeof(v_attribution->'gross_change') IS DISTINCT FROM 'string' OR (v_attribution->>'gross_change') !~ '^-?(0|[1-9][0-9]{0,9})\.[0-9]{2}$' THEN RAISE EXCEPTION 'Invalid source amounts' USING ERRCODE='22023'; END IF;
 v_gross:=(v_original->>'original_gross')::numeric;v_total:=(v_attribution->>'gross_change')::numeric;
 IF v_gross IS NULL OR v_gross='NaN'::numeric OR v_gross<0 OR v_gross<>round(v_gross,2) OR v_gross>=10000000000 OR v_total IS NULL OR v_total='NaN'::numeric OR abs(v_total)>=10000000000 OR v_total<>round(v_total,2) THEN RAISE EXCEPTION 'Invalid source amounts' USING ERRCODE='22023'; END IF;
 FOR v_row IN SELECT project_id FROM (
  SELECT (s->>'project_id')::uuid project_id FROM jsonb_array_elements(v_sites) s
  UNION SELECT (s->>'project_id')::uuid FROM jsonb_array_elements(v_split) s
 ) ids ORDER BY project_id LOOP
  IF v_row.project_id IS NULL THEN RAISE EXCEPTION 'Missing site identity' USING ERRCODE='22023'; END IF;
  SELECT (s->>'gross')::numeric INTO v_initial FROM jsonb_array_elements(v_sites) s WHERE (s->>'project_id')::uuid=v_row.project_id;
  SELECT (s->>'gross_change')::numeric INTO v_change FROM jsonb_array_elements(v_split) s WHERE (s->>'project_id')::uuid=v_row.project_id;
  -- Zero here is permitted only because both complete validated arrays were
  -- present; missing evidence is rejected, not substituted with zero.
  v_initial:=coalesce(v_initial,0);v_change:=coalesce(v_change,0);
  IF v_initial='NaN'::numeric OR v_change='NaN'::numeric OR v_initial<0 OR v_initial>=10000000000 OR abs(v_change)>=10000000000 OR v_initial<>round(v_initial,2) OR v_change<>round(v_change,2) OR v_initial+v_change<0 THEN RAISE EXCEPTION 'Correction exceeds or invalidates original site cost' USING ERRCODE='22023'; END IF;
  v_sum_initial:=v_sum_initial+v_initial;v_sum_change:=v_sum_change+v_change;
  v_items:=v_items||jsonb_build_array(jsonb_build_object('project_id',v_row.project_id,'original_gross',v_initial::numeric(12,2)::text,'gross_change',v_change::numeric(12,2)::text,'corrected_gross',(v_initial+v_change)::numeric(13,2)::text));
 END LOOP;
 IF v_sum_initial IS DISTINCT FROM v_gross OR v_sum_change IS DISTINCT FROM v_total OR v_gross+v_total<0 THEN RAISE EXCEPTION 'Cross-site totals differ from reviewed source evidence' USING ERRCODE='22023'; END IF;
 v_result:=jsonb_build_object('source_kind',p_kind,'case_id',p_case,'source_id',v_original->>'source_id','original_gross',v_gross::numeric(12,2)::text,'gross_change',v_total::numeric(12,2)::text,'corrected_gross',(v_gross+v_total)::numeric(13,2)::text,'sites',v_items,'incomplete',true);
 RETURN v_result;
END $$;
REVOKE ALL ON FUNCTION public.project_cost_cross_site_evidence(text,uuid),public.project_cost_cross_site_preview(text,uuid,jsonb,boolean) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.project_cost_cross_site_evidence(text,uuid),public.project_cost_cross_site_preview(text,uuid,jsonb,boolean) TO authenticated;
DO $postflight$ DECLARE r text; BEGIN
 FOREACH r IN ARRAY ARRAY['public.project_cost_cross_site_evidence(text,uuid)','public.project_cost_cross_site_preview(text,uuid,jsonb,boolean)'] LOOP
  IF has_function_privilege('anon',r,'EXECUTE') OR has_function_privilege('service_role',r,'EXECUTE') OR NOT has_function_privilege('authenticated',r,'EXECUTE') OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure(r) AND prosecdef AND provolatile='s' AND proconfig @> ARRAY['search_path=""']) THEN RAISE EXCEPTION 'Unexpected cross-site preview privileges'; END IF;
 END LOOP;
END $postflight$;
