-- HELD candidate: same-statement legacy-aware coverage plus ordinary and
-- legacy-inclusive reviews. Not completeness/payment proof; not a release.
-- Requires coordinated clients, correction handling and lock verification.
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
DO $preflight$ BEGIN
 IF to_regprocedure('public.project_cost_recorded_coverage(uuid)') IS NULL OR to_regprocedure('public.project_cost_legacy_review(uuid,integer)') IS NULL OR to_regprocedure('public.legacy_paid_voucher_attribution(uuid)') IS NULL OR to_regprocedure('public.project_cost_legacy_corrected_source(uuid)') IS NULL OR to_regclass('public.legacy_paid_voucher_attributions') IS NULL OR to_regclass('public.legacy_paid_voucher_attribution_sites') IS NULL OR to_regprocedure('public.project_cost_legacy_recorded_coverage(uuid)') IS NOT NULL THEN RAISE EXCEPTION 'Legacy coverage prerequisites missing or collision'; END IF;
END $preflight$;
CREATE FUNCTION public.project_cost_legacy_recorded_coverage(p_project uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_base jsonb;v_review jsonb;v_count bigint;v_bad bigint:=0;v_valid uuid[]:='{}'::uuid[];v_row record;v_status jsonb;v_unallocated bigint;v_attendance bigint;v_site bigint;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance required' USING ERRCODE='42501'; END IF;
 IF p_project IS NULL OR NOT EXISTS(SELECT 1 FROM public.projects WHERE id=p_project) THEN RAISE EXCEPTION 'Project unavailable' USING ERRCODE='42501'; END IF;
 v_base:=public.project_cost_recorded_coverage(p_project);
 SELECT count(*) INTO v_count FROM public.legacy_paid_voucher_attributions;
 IF v_count>1000 THEN RAISE EXCEPTION 'Too many legacy vouchers for coverage; separate reconciliation required' USING ERRCODE='54000'; END IF;
 -- A split suppresses the unallocated warning only if all source evidence
 -- remains valid. Any unverifiable row fails the entire reader closed.
 FOR v_row IN SELECT request_id,payroll_id FROM public.legacy_paid_voucher_attributions ORDER BY payroll_id LOOP
  v_status:=public.legacy_paid_voucher_attribution(v_row.payroll_id);
  IF v_status->'found' IS DISTINCT FROM 'true'::jsonb OR v_status->>'request_id' IS DISTINCT FROM v_row.request_id::text THEN RAISE EXCEPTION 'Legacy attribution status unavailable' USING ERRCODE='22023'; END IF;
  BEGIN
   PERFORM public.project_cost_legacy_corrected_source(v_row.payroll_id);
   v_valid:=array_append(v_valid,v_row.payroll_id);
  EXCEPTION WHEN data_exception OR integrity_constraint_violation OR SQLSTATE '40001' OR SQLSTATE '54000' THEN v_bad:=v_bad+1;
  END;
 END LOOP;
 SELECT count(*) FILTER (WHERE p.status='paid' AND p.gross_pay>0 AND NOT EXISTS(SELECT 1 FROM public.weekly_worker_paid_allocations a WHERE a.payroll_id=p.id) AND NOT(p.id=ANY(v_valid))),
  count(*) FILTER (WHERE p.status='paid' AND p.gross_pay>0 AND NOT EXISTS(SELECT 1 FROM public.weekly_worker_paid_allocations a WHERE a.payroll_id=p.id) AND NOT(p.id=ANY(v_valid)) AND EXISTS(SELECT 1 FROM public.attendance a WHERE a.project_id=p_project AND a.worker_id=p.worker_id AND a.date BETWEEN p.period_start AND p.period_end))
 INTO v_unallocated,v_attendance FROM public.payroll p;
 SELECT count(*) INTO v_site FROM public.legacy_paid_voucher_attributions a WHERE EXISTS(SELECT 1 FROM public.legacy_paid_voucher_attribution_sites s WHERE s.attribution_id=a.request_id AND s.project_id=p_project) OR EXISTS(SELECT 1 FROM public.paid_payroll_adjustment_cases c JOIN public.project_cost_correction_attributions ca ON ca.voucher_case_id=c.id AND ca.source_kind='voucher' JOIN public.project_cost_correction_sites cs ON cs.request_id=ca.request_id WHERE c.payroll_id=a.payroll_id AND cs.project_id=p_project AND ca.revision=(SELECT max(b.revision) FROM public.project_cost_correction_attributions b WHERE b.source_kind='voucher' AND b.voucher_case_id=c.id));
 v_review:=public.project_cost_legacy_review(p_project,NULL);
 RETURN jsonb_build_object('project_id',p_project,'captured_at',statement_timestamp(),'unallocated_paid',v_unallocated,'attendance_matches',v_attendance,'inconsistent_allocations',v_base->'inconsistent_allocations','unattributed_history',v_base->'unattributed_history','review',v_base->'review','legacy_site_attributions',v_site,'changed_legacy_attributions',v_bad,'legacy_review',v_review);
END $$;
REVOKE ALL ON FUNCTION public.project_cost_legacy_recorded_coverage(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.project_cost_legacy_recorded_coverage(uuid) TO authenticated;
DO $postflight$ BEGIN
 IF has_function_privilege('anon','public.project_cost_legacy_recorded_coverage(uuid)','EXECUTE') OR has_function_privilege('service_role','public.project_cost_legacy_recorded_coverage(uuid)','EXECUTE') OR NOT has_function_privilege('authenticated','public.project_cost_legacy_recorded_coverage(uuid)','EXECUTE') OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.project_cost_legacy_recorded_coverage(uuid)'::regprocedure AND prosecdef AND provolatile='s' AND proconfig @> ARRAY['search_path=""']) THEN RAISE EXCEPTION 'Unexpected legacy coverage privileges'; END IF;
END $postflight$;
