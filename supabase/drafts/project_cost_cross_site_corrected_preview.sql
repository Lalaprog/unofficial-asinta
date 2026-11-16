-- UNINSTALLED, read-only integration for a destination project. Builds on the
-- existing corrected preview and requires exact saved source-site decisions.
-- Supports one-case positive incoming corrections only. No review is saved,
-- no original payroll changes, and the result remains an incomplete estimate.
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
DO $preflight$ BEGIN
 IF to_regprocedure('public.project_cost_corrected_preview(uuid,jsonb,jsonb,boolean)') IS NULL OR to_regprocedure('public.project_cost_cross_site_review_context(uuid,text,uuid)') IS NULL OR to_regprocedure('public.is_founder()') IS NULL OR to_regprocedure('public.session_assurance_satisfied()') IS NULL OR to_regprocedure('auth.uid()') IS NULL THEN RAISE EXCEPTION 'Cross-site corrected preview prerequisites missing'; END IF;
 IF to_regprocedure('public.project_cost_cross_site_corrected_preview(uuid,jsonb,jsonb,jsonb,boolean)') IS NOT NULL THEN RAISE EXCEPTION 'Cross-site corrected preview name collision'; END IF;
END $preflight$;
CREATE FUNCTION public.project_cost_cross_site_corrected_preview(p_project uuid,p_snapshot jsonb,p_choices jsonb,p_cross_sites jsonb,p_ack boolean) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_row jsonb;v_choice jsonb;v_base_choices jsonb;v_base jsonb;v_context jsonb;v_expected jsonb;v_destination jsonb;v_key text;v_change numeric;v_incoming numeric:=0;v_count integer:=0;v_total numeric;v_correction numeric;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance required' USING ERRCODE='42501'; END IF;
 IF p_project IS NULL OR p_ack IS DISTINCT FROM true OR jsonb_typeof(p_snapshot) IS DISTINCT FROM 'object' OR jsonb_typeof(p_snapshot->'corrections') IS DISTINCT FROM 'array' OR jsonb_array_length(p_snapshot->'corrections')>500 OR jsonb_typeof(p_choices) IS DISTINCT FROM 'object' OR jsonb_typeof(p_choices->'corrections') IS DISTINCT FROM 'object' OR jsonb_typeof(p_cross_sites) IS DISTINCT FROM 'object' OR octet_length(p_cross_sites::text)>500000 THEN RAISE EXCEPTION 'Invalid cross-site corrected review' USING ERRCODE='22023'; END IF;
 v_base_choices:=p_choices;
 FOR v_row IN SELECT value FROM jsonb_array_elements(p_snapshot->'corrections') LOOP
  v_key:=(v_row->>'kind')||':'||(v_row->>'case_id');v_choice:=p_choices->'corrections'->v_key;
  IF v_row->'source_in_snapshot' IS DISTINCT FROM 'false'::jsonb OR v_choice->>'decision' IS DISTINCT FROM 'include' THEN CONTINUE; END IF;
  IF v_row->>'kind' NOT IN ('voucher','external_worker') OR v_row->>'case_id' IS NULL THEN RAISE EXCEPTION 'Invalid incoming correction identity' USING ERRCODE='22023'; END IF;
  v_expected:=p_cross_sites->v_key;
  IF jsonb_typeof(v_expected) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Saved original-site review evidence required' USING ERRCODE='22023'; END IF;
  v_context:=public.project_cost_cross_site_review_context(p_project,v_row->>'kind',(v_row->>'case_id')::uuid);
  IF v_context IS DISTINCT FROM v_expected THEN RAISE EXCEPTION 'Original-site review evidence changed; reload and review' USING ERRCODE='40001'; END IF;
  IF v_context->>'destination' IS DISTINCT FROM p_project::text OR v_context->>'source_kind' IS DISTINCT FROM v_row->>'kind' OR v_context->>'case_id' IS DISTINCT FROM v_row->>'case_id' OR v_context->'incomplete' IS DISTINCT FROM 'true'::jsonb OR v_context->'source_evidence'->'correction' IS DISTINCT FROM v_row->'evidence' THEN RAISE EXCEPTION 'Incoming correction evidence differs' USING ERRCODE='22023'; END IF;
  SELECT jsonb_agg(s) INTO v_destination FROM jsonb_array_elements(v_context->'illustration'->'sites') s WHERE s->>'project_id'=p_project::text;
  IF coalesce(jsonb_array_length(v_destination),0)<>1 THEN RAISE EXCEPTION 'Incoming correction destination unavailable' USING ERRCODE='22023'; END IF;
  v_destination:=v_destination->0;
  IF v_destination->>'original_gross' IS DISTINCT FROM '0.00' OR v_destination->>'gross_change' IS DISTINCT FROM v_row->>'site_gross_change' OR v_destination->>'gross_change' IS DISTINCT FROM v_destination->>'corrected_gross' OR v_destination->>'gross_change' !~ '^(0|[1-9][0-9]{0,9})\.[0-9]{2}$' THEN RAISE EXCEPTION 'Incoming correction amount differs' USING ERRCODE='22023'; END IF;
  v_change:=(v_destination->>'gross_change')::numeric;
  IF v_change IS NULL OR v_change<=0 THEN RAISE EXCEPTION 'Incoming correction must be positive' USING ERRCODE='22023'; END IF;
  -- The existing preview validates all decisions and the destination's exact
  -- inventory; replace only this incoming inclusion with an explicit omission
  -- for its calculation, then add the separately verified positive effect.
  v_base_choices:=jsonb_set(v_base_choices,ARRAY['corrections',v_key,'decision'],'"exclude"'::jsonb);
  v_count:=v_count+1;v_incoming:=v_incoming+v_change;
 END LOOP;
 IF (SELECT count(*) FROM jsonb_object_keys(p_cross_sites))<>v_count THEN RAISE EXCEPTION 'Unexpected or missing cross-site evidence' USING ERRCODE='22023'; END IF;
 v_base:=public.project_cost_corrected_preview(p_project,p_snapshot,v_base_choices,true);
 IF v_base->>'project_id' IS DISTINCT FROM p_project::text OR v_base->'incomplete' IS DISTINCT FROM 'true'::jsonb OR (v_base->>'excluded_cases')::integer<v_count THEN RAISE EXCEPTION 'Base corrected preview differs' USING ERRCODE='22023'; END IF;
 v_total:=(v_base->>'incomplete_total')::numeric+v_incoming;v_correction:=(v_base->>'correction_gross')::numeric+v_incoming;
 IF v_total IS NULL OR v_total<0 OR v_total>=100000000000000 OR v_correction IS NULL OR abs(v_correction)>=100000000000000 THEN RAISE EXCEPTION 'Cross-site corrected total invalid' USING ERRCODE='22023'; END IF;
 RETURN v_base||jsonb_build_object('incomplete_total',v_total::numeric(16,2)::text,'correction_gross',v_correction::numeric(16,2)::text,'excluded_cases',(v_base->>'excluded_cases')::integer-v_count,'cross_site_gross',v_incoming::numeric(16,2)::text,'cross_site_cases',v_count);
END $$;
REVOKE ALL ON FUNCTION public.project_cost_cross_site_corrected_preview(uuid,jsonb,jsonb,jsonb,boolean) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.project_cost_cross_site_corrected_preview(uuid,jsonb,jsonb,jsonb,boolean) TO authenticated;
DO $postflight$ BEGIN
 IF has_function_privilege('anon','public.project_cost_cross_site_corrected_preview(uuid,jsonb,jsonb,jsonb,boolean)','EXECUTE') OR has_function_privilege('service_role','public.project_cost_cross_site_corrected_preview(uuid,jsonb,jsonb,jsonb,boolean)','EXECUTE') OR NOT has_function_privilege('authenticated','public.project_cost_cross_site_corrected_preview(uuid,jsonb,jsonb,jsonb,boolean)','EXECUTE') OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.project_cost_cross_site_corrected_preview(uuid,jsonb,jsonb,jsonb,boolean)'::regprocedure AND prosecdef AND provolatile='s' AND proconfig @> ARRAY['search_path=""']) THEN RAISE EXCEPTION 'Unexpected cross-site corrected preview privileges'; END IF;
END $postflight$;
