-- DRAFT ONLY. Founder-reviewed, bounded, read-only corrected cost illustration.
-- This is not a posting, payment, complete ledger, or a saved review. Existing
-- saved reviews remain immutable and exclude corrections. Inclusion of a
-- correction requires the corresponding original source in this site snapshot.
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
DO $preflight$ BEGIN
 IF to_regprocedure('public.project_cost_correction_inventory(uuid)') IS NULL OR to_regprocedure('public.is_founder()') IS NULL OR to_regprocedure('public.session_assurance_satisfied()') IS NULL OR to_regprocedure('auth.uid()') IS NULL THEN RAISE EXCEPTION 'Corrected preview prerequisites missing'; END IF;
 IF to_regprocedure('public.project_cost_corrected_preview(uuid,jsonb,jsonb,boolean)') IS NOT NULL THEN RAISE EXCEPTION 'Corrected preview name collision'; END IF;
END $preflight$;
CREATE FUNCTION public.project_cost_corrected_preview(p_project uuid,p_snapshot jsonb,p_choices jsonb,p_ack boolean) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_now jsonb;v_base jsonb;v_history jsonb;v_cases jsonb;v_group text;v_choices jsonb;v_row jsonb;v_choice jsonb;v_case jsonb;v_evidence jsonb;v_key text;v_source text;v_original numeric;v_effect numeric;v_exp numeric:=0;v_excluded_exp numeric:=0;v_paid numeric:=0;v_hist numeric:=0;v_excluded_hist numeric:=0;v_correction numeric:=0;v_excluded_cases integer:=0;v_total numeric;v_seen_sources text[]:='{}';
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance required' USING ERRCODE='42501'; END IF;
 IF p_project IS NULL OR p_ack IS DISTINCT FROM true OR jsonb_typeof(p_snapshot) IS DISTINCT FROM 'object' OR octet_length(p_snapshot::text)>2097152 OR jsonb_typeof(p_choices) IS DISTINCT FROM 'object' OR octet_length(p_choices::text)>500000 OR (SELECT count(*) FROM jsonb_object_keys(p_choices))<>3 OR NOT(p_choices ?& ARRAY['expenses','historical','corrections']) THEN RAISE EXCEPTION 'Invalid corrected review input' USING ERRCODE='22023'; END IF;
 -- Compare the server's statement snapshot with the full reviewed inventory.
 -- Capture time alone is not financial evidence. A later change still requires
 -- a new read: this preview neither locks writers nor closes a period.
 v_now:=public.project_cost_correction_inventory(p_project);
 IF v_now #- '{historical_review,base,captured_at}' IS DISTINCT FROM p_snapshot #- '{historical_review,base,captured_at}' THEN RAISE EXCEPTION 'Project evidence changed; reload and review' USING ERRCODE='40001'; END IF;
 v_base:=v_now->'historical_review'->'base';v_history:=v_now->'historical_review'->'historical';v_cases:=v_now->'corrections';
 -- Do not let duplicate or missing identities make an incomplete decision map
 -- look complete. Every historical case signal must appear in the inventory.
 IF jsonb_array_length(v_base->'expenses')<>(SELECT count(DISTINCT e->>'id') FROM jsonb_array_elements(v_base->'expenses') e) OR jsonb_array_length(v_base->'paid_allocations')<>(SELECT count(DISTINCT a->>'payroll_id') FROM jsonb_array_elements(v_base->'paid_allocations') a) OR jsonb_array_length(v_history)<>(SELECT count(DISTINCT h->>'request_id') FROM jsonb_array_elements(v_history) h) OR jsonb_array_length(v_history)<>(SELECT count(DISTINCT h->>'source_id') FROM jsonb_array_elements(v_history) h) OR jsonb_array_length(v_cases)<>(SELECT count(DISTINCT (c->>'kind')||':'||(c->>'case_id')) FROM jsonb_array_elements(v_cases) c) OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_history) h WHERE (h->>'case_count')::bigint IS DISTINCT FROM (SELECT count(*) FROM jsonb_array_elements(v_cases) c WHERE c->>'kind'='external_worker' AND (c->>'source_in_snapshot')::boolean AND c->'evidence'->'case'->>'external_worker_id'=h->>'source_id')) OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_base->'adjustment_cases') a WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_cases) c WHERE c->>'kind'='voucher' AND c->>'case_id'=a->>'case_id' AND (c->>'source_in_snapshot')::boolean)) THEN RAISE EXCEPTION 'Correction inventory identity or case signal differs' USING ERRCODE='22023'; END IF;
 FOREACH v_group IN ARRAY ARRAY['expenses','historical','corrections'] LOOP
  v_choices:=p_choices->v_group;
  IF jsonb_typeof(v_choices) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Review every % item',v_group USING ERRCODE='22023'; END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(v_choices))<>(CASE v_group WHEN 'expenses' THEN jsonb_array_length(v_base->'expenses') WHEN 'historical' THEN jsonb_array_length(v_history) ELSE jsonb_array_length(v_cases) END) THEN RAISE EXCEPTION 'Review every % item',v_group USING ERRCODE='22023'; END IF;
  -- All decisions use {decision,reason}. Exclusions require a reason. A
  -- correction inclusion also requires a reason explaining the review; no
  -- implicit duplicate classification is inferred from numbers or an AI hint.
  IF EXISTS(SELECT 1 FROM jsonb_each(v_choices) e WHERE jsonb_typeof(e.value) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(CASE WHEN jsonb_typeof(e.value)='object' THEN e.value ELSE '{}'::jsonb END))<>2 OR NOT(e.value ?& ARRAY['decision','reason']) OR coalesce(e.value->>'decision','') NOT IN ('include','exclude') OR
   (e.value->>'decision'='include' AND v_group<>'corrections' AND e.value->'reason' IS DISTINCT FROM 'null'::jsonb) OR
   ((e.value->>'decision'='exclude' OR v_group='corrections') AND (jsonb_typeof(e.value->'reason') IS DISTINCT FROM 'string' OR length(btrim(e.value->>'reason')) NOT BETWEEN 1 AND 300 OR btrim(e.value->>'reason') IS DISTINCT FROM e.value->>'reason' OR (e.value->>'reason') ~ '[[:cntrl:]]'))) THEN RAISE EXCEPTION 'Invalid % decision or reason',v_group USING ERRCODE='22023'; END IF;
 END LOOP;
 FOR v_row IN SELECT value FROM jsonb_array_elements(v_base->'expenses') LOOP
  v_key:=v_row->>'id';v_choice:=p_choices->'expenses'->v_key;
  IF v_choice IS NULL THEN RAISE EXCEPTION 'Review every expense' USING ERRCODE='22023'; END IF;
  v_original:=(v_row->>'amount')::numeric;
  IF v_original IS NULL OR v_original='NaN'::numeric OR v_original<=0 OR v_original<>round(v_original,2) OR v_original>=10000000000 THEN RAISE EXCEPTION 'Invalid expense evidence' USING ERRCODE='22023'; END IF;
  IF v_choice->>'decision'='include' THEN v_exp:=v_exp+v_original; ELSE v_excluded_exp:=v_excluded_exp+v_original; END IF;
 END LOOP;
 FOR v_row IN SELECT value FROM jsonb_array_elements(v_base->'paid_allocations') LOOP
  v_original:=(v_row->>'gross')::numeric;
  IF v_original IS NULL OR v_original='NaN'::numeric OR v_original<0 OR v_original<>round(v_original,2) OR v_original>=10000000000 THEN RAISE EXCEPTION 'Invalid paid allocation' USING ERRCODE='22023'; END IF;
  v_paid:=v_paid+v_original;
 END LOOP;
 FOR v_row IN SELECT value FROM jsonb_array_elements(v_history) LOOP
  v_key:=v_row->>'request_id';v_choice:=p_choices->'historical'->v_key;
  IF v_choice IS NULL THEN RAISE EXCEPTION 'Review every historical attribution' USING ERRCODE='22023'; END IF;
  v_original:=(v_row->>'site_gross')::numeric;
  IF v_original IS NULL OR v_original='NaN'::numeric OR v_original<=0 OR v_original<>round(v_original,2) OR v_original>=10000000000 THEN RAISE EXCEPTION 'Invalid historical allocation' USING ERRCODE='22023'; END IF;
  IF v_choice->>'decision'='include' THEN
   IF (v_row->>'overlapping_vouchers')::bigint<>0 THEN RAISE EXCEPTION 'Investigate historical voucher overlap' USING ERRCODE='22023'; END IF;
   v_hist:=v_hist+v_original;
  ELSE v_excluded_hist:=v_excluded_hist+v_original; END IF;
 END LOOP;
 FOR v_row IN SELECT value FROM jsonb_array_elements(v_cases) LOOP
  v_key:=(v_row->>'kind')||':'||(v_row->>'case_id');v_choice:=p_choices->'corrections'->v_key;
  IF v_choice IS NULL THEN RAISE EXCEPTION 'Review every correction case' USING ERRCODE='22023'; END IF;
  IF v_choice->>'decision'='exclude' THEN v_excluded_cases:=v_excluded_cases+1;CONTINUE; END IF;
  v_evidence:=v_row->'evidence';v_case:=v_evidence->'case';
  IF coalesce((v_row->>'source_in_snapshot')::boolean,false) IS NOT TRUE OR v_evidence->'attribution' IS NULL OR v_evidence->'attribution'='null'::jsonb OR (v_evidence->'attribution'->>'case_changed')::boolean IS DISTINCT FROM false OR coalesce(v_case->>'status','') NOT IN ('settled_external','no_transfer') OR jsonb_typeof(v_case->'related_cases') IS DISTINCT FROM 'array' OR EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_case->'related_cases')='array' THEN v_case->'related_cases' ELSE '[]'::jsonb END) s WHERE coalesce(s->>'status','') NOT IN ('settled_external','no_transfer')) OR v_row->>'site_gross_change' IS NULL THEN RAISE EXCEPTION 'Included correction lacks current resolved source evidence' USING ERRCODE='22023'; END IF;
  v_source:=CASE v_row->>'kind' WHEN 'voucher' THEN v_case->>'payroll_id' WHEN 'external_worker' THEN v_case->>'external_worker_id' ELSE NULL END;
  IF v_source IS NULL THEN RAISE EXCEPTION 'Correction source unavailable' USING ERRCODE='22023'; END IF;
  -- Conservative limitation: no two included cases against the same original
  -- in this preview. A human must investigate and exclude possible duplicates;
  -- legitimate multiple incremental corrections require a future workflow.
  IF (v_row->>'kind'||':'||v_source)=ANY(v_seen_sources) THEN RAISE EXCEPTION 'Multiple included corrections for one original require separate reconciliation' USING ERRCODE='22023'; END IF;
  v_seen_sources:=array_append(v_seen_sources,v_row->>'kind'||':'||v_source);
  IF v_row->>'kind'='voucher' THEN
   SELECT (a->>'gross')::numeric INTO v_original FROM jsonb_array_elements(v_base->'paid_allocations') a WHERE a->>'payroll_id'=v_source;
  ELSE
   SELECT (h->>'site_gross')::numeric INTO v_original FROM jsonb_array_elements(v_history) h WHERE h->>'source_id'=v_source AND p_choices->'historical'->(h->>'request_id')->>'decision'='include' AND (h->>'overlapping_vouchers')::bigint=0;
  END IF;
  IF v_original IS NULL THEN RAISE EXCEPTION 'Correction original is not included in this site review' USING ERRCODE='22023'; END IF;
  v_effect:=(v_row->>'site_gross_change')::numeric;
  IF v_effect='NaN'::numeric OR abs(v_effect)>=10000000000 OR v_effect<>round(v_effect,2) OR v_original+v_effect<0 THEN RAISE EXCEPTION 'Correction exceeds or invalidates original site cost' USING ERRCODE='22023'; END IF;
  v_correction:=v_correction+v_effect;
 END LOOP;
 v_total:=v_exp+v_paid+v_hist+v_correction;
 IF v_total<0 OR v_total>=100000000000000 THEN RAISE EXCEPTION 'Invalid corrected total' USING ERRCODE='22023'; END IF;
 RETURN jsonb_build_object('project_id',p_project,'included_expenses',v_exp::numeric(16,2)::text,'excluded_expenses',v_excluded_exp::numeric(16,2)::text,'paid_gross',v_paid::numeric(16,2)::text,'historical_gross',v_hist::numeric(16,2)::text,'excluded_historical',v_excluded_hist::numeric(16,2)::text,'correction_gross',v_correction::numeric(16,2)::text,'excluded_cases',v_excluded_cases,'incomplete_total',v_total::numeric(16,2)::text,'incomplete',true);
END $$;
REVOKE ALL ON FUNCTION public.project_cost_corrected_preview(uuid,jsonb,jsonb,boolean) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.project_cost_corrected_preview(uuid,jsonb,jsonb,boolean) TO authenticated;
DO $postflight$ BEGIN
 IF has_function_privilege('anon','public.project_cost_corrected_preview(uuid,jsonb,jsonb,boolean)','EXECUTE') OR has_function_privilege('service_role','public.project_cost_corrected_preview(uuid,jsonb,jsonb,boolean)','EXECUTE') OR NOT has_function_privilege('authenticated','public.project_cost_corrected_preview(uuid,jsonb,jsonb,boolean)','EXECUTE') OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.project_cost_corrected_preview(uuid,jsonb,jsonb,boolean)'::regprocedure AND prosecdef AND provolatile='s' AND proconfig @> ARRAY['search_path=""']) THEN RAISE EXCEPTION 'Unexpected corrected preview privileges'; END IF;
END $postflight$;
