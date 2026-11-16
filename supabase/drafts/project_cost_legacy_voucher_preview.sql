-- HELD: additive legacy-voucher review experiment. Not an installation script
-- or a saved accounting ledger. Requires legacy_paid_voucher_attribution.sql,
-- correction inventory and corrected preview; do not deploy in isolation.
-- A later case or changed source blocks this whole preview pending an actual
-- correction workflow. Existing saved reviews and coverage DO NOT include these
-- legacy splits. They must be updated atomically before any production use.
-- No money, expense, payroll, project allocation or saved review is written.
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
DO $preflight$ BEGIN
 IF to_regclass('public.legacy_paid_voucher_attributions') IS NULL OR to_regclass('public.legacy_paid_voucher_attribution_sites') IS NULL
 OR to_regprocedure('public.legacy_paid_voucher_attribution(uuid)') IS NULL OR to_regprocedure('public.project_cost_correction_inventory(uuid)') IS NULL
 OR to_regprocedure('public.project_cost_corrected_preview(uuid,jsonb,jsonb,boolean)') IS NULL OR to_regprocedure('public.is_founder()') IS NULL OR to_regprocedure('public.session_assurance_satisfied()') IS NULL OR to_regprocedure('auth.uid()') IS NULL THEN RAISE EXCEPTION 'Legacy project preview prerequisites missing'; END IF;
 IF to_regprocedure('public.project_cost_legacy_voucher_inventory(uuid)') IS NOT NULL OR to_regprocedure('public.project_cost_legacy_voucher_preview(uuid,jsonb,jsonb,jsonb,boolean)') IS NOT NULL THEN RAISE EXCEPTION 'Legacy project preview already exists'; END IF;
END $preflight$;
CREATE FUNCTION public.project_cost_legacy_voucher_inventory(p_project uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_base jsonb;v_row record;v_status jsonb;v_legacy jsonb:='[]'::jsonb;v_result jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance required' USING ERRCODE='42501'; END IF;
 IF p_project IS NULL OR NOT EXISTS(SELECT 1 FROM public.projects WHERE id=p_project) THEN RAISE EXCEPTION 'Project unavailable' USING ERRCODE='42501'; END IF;
 v_base:=public.project_cost_correction_inventory(p_project);
 IF v_base->>'project_id' IS DISTINCT FROM p_project::text OR jsonb_typeof(v_base->'historical_review'->'base'->'paid_allocations') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Project cost inventory unavailable' USING ERRCODE='22023'; END IF;
 IF (SELECT count(*) FROM public.legacy_paid_voucher_attribution_sites WHERE project_id=p_project)>500 THEN RAISE EXCEPTION 'More than 500 legacy voucher attributions' USING ERRCODE='54000'; END IF;
 FOR v_row IN SELECT a.request_id,a.payroll_id,s.gross FROM public.legacy_paid_voucher_attribution_sites s JOIN public.legacy_paid_voucher_attributions a ON a.request_id=s.attribution_id WHERE s.project_id=p_project ORDER BY a.payroll_id LOOP
  v_status:=public.legacy_paid_voucher_attribution(v_row.payroll_id);
  IF v_status->'found' IS DISTINCT FROM 'true'::jsonb OR v_status->>'request_id' IS DISTINCT FROM v_row.request_id::text OR v_status->'source_changed' IS DISTINCT FROM 'false'::jsonb OR v_status->'case_count' IS DISTINCT FROM '0'::jsonb OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_base->'historical_review'->'base'->'paid_allocations') p WHERE p->>'payroll_id'=v_row.payroll_id::text) THEN RAISE EXCEPTION 'Legacy voucher changed, overlaps a paid allocation or has a correction; investigate' USING ERRCODE='40001'; END IF;
  v_legacy:=v_legacy||jsonb_build_array(jsonb_build_object('request_id',v_row.request_id,'payroll_id',v_row.payroll_id,'site_gross',v_row.gross::text,'status',v_status));
 END LOOP;
 v_result:=jsonb_build_object('project_id',p_project,'base',v_base,'legacy_vouchers',v_legacy);
 IF octet_length(v_result::text)>2097152 THEN RAISE EXCEPTION 'Legacy project inventory too large' USING ERRCODE='54000'; END IF;
 RETURN v_result;
END $$;
CREATE FUNCTION public.project_cost_legacy_voucher_preview(p_project uuid,p_snapshot jsonb,p_choices jsonb,p_legacy_choices jsonb,p_ack boolean) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_now jsonb;v_base jsonb;v_item jsonb;v_choice jsonb;v_included numeric:=0;v_excluded numeric:=0;v_total numeric;v_count integer:=0;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance required' USING ERRCODE='42501'; END IF;
 IF p_project IS NULL OR p_ack IS DISTINCT FROM true OR jsonb_typeof(p_snapshot) IS DISTINCT FROM 'object' OR octet_length(p_snapshot::text)>2097152 OR jsonb_typeof(p_legacy_choices) IS DISTINCT FROM 'object' OR octet_length(p_legacy_choices::text)>500000 THEN RAISE EXCEPTION 'Invalid legacy cost review' USING ERRCODE='22023'; END IF;
 v_now:=public.project_cost_legacy_voucher_inventory(p_project);
 IF v_now #- '{base,historical_review,base,captured_at}' IS DISTINCT FROM p_snapshot #- '{base,historical_review,base,captured_at}' THEN RAISE EXCEPTION 'Project evidence changed; reload and review' USING ERRCODE='40001'; END IF;
 IF (SELECT count(*) FROM jsonb_object_keys(p_legacy_choices))<>jsonb_array_length(v_now->'legacy_vouchers') THEN RAISE EXCEPTION 'Review every legacy voucher' USING ERRCODE='22023'; END IF;
 FOR v_item IN SELECT value FROM jsonb_array_elements(v_now->'legacy_vouchers') LOOP
  v_choice:=p_legacy_choices->(v_item->>'request_id');
  IF jsonb_typeof(v_choice) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(CASE WHEN jsonb_typeof(v_choice)='object' THEN v_choice ELSE '{}'::jsonb END))<>2 OR NOT(v_choice ?& ARRAY['decision','reason']) OR coalesce(v_choice->>'decision','') NOT IN ('include','exclude') OR (v_choice->>'decision'='include' AND v_choice->'reason' IS DISTINCT FROM 'null'::jsonb) OR (v_choice->>'decision'='exclude' AND (jsonb_typeof(v_choice->'reason') IS DISTINCT FROM 'string' OR length(btrim(v_choice->>'reason')) NOT BETWEEN 1 AND 300 OR btrim(v_choice->>'reason') IS DISTINCT FROM v_choice->>'reason' OR (v_choice->>'reason')~'[[:cntrl:]]')) THEN RAISE EXCEPTION 'Invalid legacy voucher decision' USING ERRCODE='22023'; END IF;
  IF v_choice->>'decision'='include' THEN v_included:=v_included+(v_item->>'site_gross')::numeric; ELSE v_excluded:=v_excluded+(v_item->>'site_gross')::numeric;v_count:=v_count+1; END IF;
 END LOOP;
 v_base:=public.project_cost_corrected_preview(p_project,v_now->'base',p_choices,true);
 v_total:=(v_base->>'incomplete_total')::numeric+v_included;
 IF v_total<0 OR v_total>=100000000000000 THEN RAISE EXCEPTION 'Invalid legacy cost total' USING ERRCODE='22023'; END IF;
 RETURN jsonb_build_object('project_id',p_project,'base',v_base,'legacy_included_gross',v_included::numeric(16,2)::text,'legacy_excluded_gross',v_excluded::numeric(16,2)::text,'legacy_excluded_count',v_count,'incomplete_total',v_total::numeric(16,2)::text,'incomplete',true);
END $$;
REVOKE ALL ON FUNCTION public.project_cost_legacy_voucher_inventory(uuid),public.project_cost_legacy_voucher_preview(uuid,jsonb,jsonb,jsonb,boolean) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.project_cost_legacy_voucher_inventory(uuid),public.project_cost_legacy_voucher_preview(uuid,jsonb,jsonb,jsonb,boolean) TO authenticated;
DO $postflight$ DECLARE f oid; BEGIN
 FOREACH f IN ARRAY ARRAY['public.project_cost_legacy_voucher_inventory(uuid)'::regprocedure::oid,'public.project_cost_legacy_voucher_preview(uuid,jsonb,jsonb,jsonb,boolean)'::regprocedure::oid] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=f AND prosecdef AND provolatile='s' AND proconfig @> ARRAY['search_path=""']) OR NOT has_function_privilege('authenticated',f,'EXECUTE') OR has_function_privilege('anon',f,'EXECUTE') OR has_function_privilege('service_role',f,'EXECUTE') THEN RAISE EXCEPTION 'Unexpected legacy project preview privileges'; END IF;
 END LOOP;
END $postflight$;
