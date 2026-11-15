-- HELD, read-only original-period context for a correction of an attributed
-- legacy voucher. It is NOT a corrected cost, decision, payment, posting, or
-- destination review. It does not unlock the existing legacy cost preview.
-- Case-only invalidation is distinguished from any changed voucher, worker,
-- competing allocation, Supervisor clue or overlapping payroll. The original
-- site split and current complete case evidence must still be reconciled by a
-- later reviewed, atomic cross-site workflow before inclusion in a total.
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
DO $preflight$ BEGIN
 IF to_regprocedure('public.legacy_paid_voucher_attribution(uuid)') IS NULL OR to_regprocedure('public.project_cost_correction_attribution(text,uuid,integer)') IS NULL OR to_regclass('public.paid_payroll_adjustment_cases') IS NULL OR to_regprocedure('public.project_cost_legacy_correction_context(uuid)') IS NOT NULL THEN RAISE EXCEPTION 'Legacy correction context prerequisites missing or collision'; END IF;
END $preflight$;
CREATE FUNCTION public.project_cost_legacy_correction_context(p_case uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_payroll uuid;v_status jsonb;v_correction jsonb;v_case jsonb;v_result jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance required' USING ERRCODE='42501'; END IF;
 IF p_case IS NULL THEN RAISE EXCEPTION 'Correction case required' USING ERRCODE='22023'; END IF;
 SELECT payroll_id INTO v_payroll FROM public.paid_payroll_adjustment_cases WHERE id=p_case;
 IF NOT FOUND THEN RAISE EXCEPTION 'Correction case unavailable' USING ERRCODE='P0002'; END IF;
 v_status:=public.legacy_paid_voucher_attribution(v_payroll);
 IF v_status->'found' IS DISTINCT FROM 'true'::jsonb OR v_status->'source_changed' IS DISTINCT FROM 'false'::jsonb OR v_status->'risks' IS DISTINCT FROM '["correction_cases"]'::jsonb OR (v_status->>'case_count')::integer<1 OR v_status->'voucher' IS DISTINCT FROM v_status->'snapshot' OR v_status->'worker' IS DISTINCT FROM v_status->'recorded_worker' THEN RAISE EXCEPTION 'Legacy original evidence changed or has another conflict; investigate' USING ERRCODE='40001'; END IF;
 v_correction:=public.project_cost_correction_attribution('voucher',p_case,NULL);v_case:=v_correction->'case';
 IF v_case->>'id' IS DISTINCT FROM p_case::text OR v_case->>'payroll_id' IS DISTINCT FROM v_payroll::text OR v_case->'original_voucher' IS DISTINCT FROM v_status->'snapshot' OR jsonb_typeof(v_case->'related_cases') IS DISTINCT FROM 'array' OR jsonb_array_length(v_case->'related_cases') IS DISTINCT FROM (v_status->>'case_count')::integer THEN RAISE EXCEPTION 'Correction and original voucher evidence differ' USING ERRCODE='40001'; END IF;
 v_result:=jsonb_build_object('source_kind','legacy_voucher','case_id',p_case,'payroll_id',v_payroll,'original',v_status,'correction',v_correction,'incomplete',true);
 IF octet_length(v_result::text)>262144 THEN RAISE EXCEPTION 'Legacy correction context too large' USING ERRCODE='54000'; END IF;
 RETURN v_result;
END $$;
REVOKE ALL ON FUNCTION public.project_cost_legacy_correction_context(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.project_cost_legacy_correction_context(uuid) TO authenticated;
DO $postflight$ BEGIN
 IF has_function_privilege('anon','public.project_cost_legacy_correction_context(uuid)','EXECUTE') OR has_function_privilege('service_role','public.project_cost_legacy_correction_context(uuid)','EXECUTE') OR NOT has_function_privilege('authenticated','public.project_cost_legacy_correction_context(uuid)','EXECUTE') OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.project_cost_legacy_correction_context(uuid)'::regprocedure AND prosecdef AND provolatile='s' AND proconfig @> ARRAY['search_path=""']) THEN RAISE EXCEPTION 'Unexpected legacy correction context privileges'; END IF;
END $postflight$;
