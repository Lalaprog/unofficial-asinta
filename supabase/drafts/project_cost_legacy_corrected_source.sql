-- HELD: one legacy voucher with every original-period gross correction, across
-- every affected site in one statement snapshot. No posting/payment/review.
-- Callers must explicitly review whether multiple cases are distinct and must
-- not add these corrected amounts on top of the original legacy site split.
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
DO $preflight$ BEGIN
 IF to_regprocedure('public.project_cost_legacy_correction_context(uuid)') IS NULL OR to_regprocedure('public.legacy_paid_voucher_attribution(uuid)') IS NULL OR to_regclass('public.paid_payroll_adjustment_cases') IS NULL OR to_regprocedure('public.project_cost_legacy_corrected_source(uuid)') IS NOT NULL THEN RAISE EXCEPTION 'Legacy corrected source prerequisites missing or collision'; END IF;
END $preflight$;
CREATE FUNCTION public.project_cost_legacy_corrected_source(p_payroll uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_original jsonb;v_case_id uuid;v_context jsonb;v_correction jsonb;v_cases jsonb:='[]'::jsonb;v_projects uuid[];v_project uuid;v_before numeric;v_change numeric;v_after numeric;v_total numeric:=0;v_initial_total numeric:=0;v_change_total numeric:=0;v_expected_change numeric:=0;v_sites jsonb:='[]'::jsonb;v_result jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance required' USING ERRCODE='42501'; END IF;
 IF p_payroll IS NULL THEN RAISE EXCEPTION 'Voucher required' USING ERRCODE='22023'; END IF;
 v_original:=public.legacy_paid_voucher_attribution(p_payroll);
 IF v_original->'found' IS DISTINCT FROM 'true'::jsonb OR v_original->'source_changed' IS DISTINCT FROM 'false'::jsonb OR v_original->'voucher' IS DISTINCT FROM v_original->'snapshot' OR v_original->'worker' IS DISTINCT FROM v_original->'recorded_worker' OR v_original->'risks' NOT IN ('[]'::jsonb,'["correction_cases"]'::jsonb) THEN RAISE EXCEPTION 'Legacy voucher evidence changed or conflicts; investigate' USING ERRCODE='40001'; END IF;
 IF (v_original->>'case_count')::integer>100 THEN RAISE EXCEPTION 'Too many cases for one voucher' USING ERRCODE='54000'; END IF;
 FOR v_case_id IN SELECT id FROM public.paid_payroll_adjustment_cases WHERE payroll_id=p_payroll ORDER BY id LOOP
  v_context:=public.project_cost_legacy_correction_context(v_case_id);v_correction:=v_context->'correction';
  IF v_context->'original' IS DISTINCT FROM v_original OR v_correction->'case'->>'status' NOT IN ('settled_external','no_transfer') OR jsonb_typeof(v_correction->'attribution') IS DISTINCT FROM 'object' OR v_correction->'attribution'->'case_changed' IS DISTINCT FROM 'false'::jsonb OR v_correction->'attribution'->'case_snapshot' IS DISTINCT FROM v_correction->'case' OR jsonb_typeof(v_correction->'attribution'->'split') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Every legacy correction requires current resolved attribution' USING ERRCODE='22023'; END IF;
  v_expected_change:=v_expected_change+(v_correction->'attribution'->>'gross_change')::numeric;
  v_cases:=v_cases||jsonb_build_array(jsonb_build_object('case_id',v_case_id,'evidence',v_correction));
 END LOOP;
 IF jsonb_array_length(v_cases) IS DISTINCT FROM (v_original->>'case_count')::integer THEN RAISE EXCEPTION 'Legacy cases changed' USING ERRCODE='40001'; END IF;
 SELECT array_agg(project_id ORDER BY project_id) INTO v_projects FROM (
  SELECT (s->>'project_id')::uuid project_id FROM jsonb_array_elements(v_original->'split') s
  UNION SELECT (s->>'project_id')::uuid FROM jsonb_array_elements(v_cases) c CROSS JOIN LATERAL jsonb_array_elements(c->'evidence'->'attribution'->'split') s
 ) projects;
 IF coalesce(cardinality(v_projects),0) NOT BETWEEN 1 AND 150 THEN RAISE EXCEPTION 'Legacy corrected sites unavailable or too many' USING ERRCODE='54000'; END IF;
 FOREACH v_project IN ARRAY v_projects LOOP
  SELECT coalesce(sum((s->>'gross')::numeric),0) INTO v_before FROM jsonb_array_elements(v_original->'split') s WHERE (s->>'project_id')::uuid=v_project;
  SELECT coalesce(sum((s->>'gross_change')::numeric),0) INTO v_change FROM jsonb_array_elements(v_cases) c CROSS JOIN LATERAL jsonb_array_elements(c->'evidence'->'attribution'->'split') s WHERE (s->>'project_id')::uuid=v_project;
  v_after:=v_before+v_change;
  IF v_after<0 OR v_after>=10000000000 OR v_after<>round(v_after,2) THEN RAISE EXCEPTION 'Legacy correction exceeds original site cost' USING ERRCODE='22023'; END IF;
  v_initial_total:=v_initial_total+v_before;v_change_total:=v_change_total+v_change;v_total:=v_total+v_after;
  v_sites:=v_sites||jsonb_build_array(jsonb_build_object('project_id',v_project,'original_gross',v_before::numeric(12,2)::text,'gross_change',v_change::numeric(12,2)::text,'corrected_gross',v_after::numeric(12,2)::text));
 END LOOP;
 IF v_initial_total IS DISTINCT FROM (v_original->'snapshot'->>'gross_pay')::numeric OR v_change_total IS DISTINCT FROM v_expected_change OR v_total IS DISTINCT FROM v_initial_total+v_expected_change THEN RAISE EXCEPTION 'Legacy corrected source totals differ' USING ERRCODE='22023'; END IF;
 v_result:=jsonb_build_object('payroll_id',p_payroll,'original',v_original,'cases',v_cases,'sites',v_sites,'original_gross',v_initial_total::numeric(12,2)::text,'gross_change',v_change_total::numeric(12,2)::text,'corrected_gross',v_total::numeric(13,2)::text,'incomplete',true);
 IF octet_length(v_result::text)>1048576 THEN RAISE EXCEPTION 'Legacy corrected source too large' USING ERRCODE='54000'; END IF;
 RETURN v_result;
END $$;
REVOKE ALL ON FUNCTION public.project_cost_legacy_corrected_source(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.project_cost_legacy_corrected_source(uuid) TO authenticated;
DO $postflight$ BEGIN
 IF has_function_privilege('anon','public.project_cost_legacy_corrected_source(uuid)','EXECUTE') OR has_function_privilege('service_role','public.project_cost_legacy_corrected_source(uuid)','EXECUTE') OR NOT has_function_privilege('authenticated','public.project_cost_legacy_corrected_source(uuid)','EXECUTE') OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.project_cost_legacy_corrected_source(uuid)'::regprocedure AND prosecdef AND provolatile='s' AND proconfig @> ARRAY['search_path=""']) THEN RAISE EXCEPTION 'Unexpected legacy corrected source privileges'; END IF;
END $postflight$;
