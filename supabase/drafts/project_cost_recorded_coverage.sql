-- Read-only coverage signals alongside the current corrected review, in the
-- same PostgreSQL statement snapshot. This does not establish completeness:
-- attendance, external evidence and financial records themselves may be missing.
-- No payroll, expense, review, allocation or payment record is written.
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
DO $preflight$ BEGIN
 IF to_regclass('public.projects') IS NULL OR to_regclass('public.payroll') IS NULL
 OR to_regclass('public.weekly_worker_paid_allocations') IS NULL
 OR to_regclass('public.attendance') IS NULL OR to_regclass('public.historical_external_worker_payroll') IS NULL
 OR to_regclass('public.historical_worker_attributions') IS NULL
 OR to_regprocedure('public.project_cost_corrected_review(uuid,integer)') IS NULL
 OR to_regprocedure('public.is_founder()') IS NULL OR to_regprocedure('public.session_assurance_satisfied()') IS NULL
 OR to_regprocedure('auth.uid()') IS NULL THEN RAISE EXCEPTION 'Recorded-cost coverage prerequisites missing'; END IF;
 IF to_regprocedure('public.project_cost_recorded_coverage(uuid)') IS NOT NULL THEN RAISE EXCEPTION 'Recorded-cost coverage function already exists'; END IF;
END $preflight$;
CREATE FUNCTION public.project_cost_recorded_coverage(p_project uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_missing bigint;v_site bigint;v_inconsistent bigint;v_history bigint;v_review jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN
  RAISE EXCEPTION 'Founder access with required assurance required' USING ERRCODE='42501'; END IF;
 IF p_project IS NULL OR NOT EXISTS(SELECT 1 FROM public.projects WHERE id=p_project) THEN
  RAISE EXCEPTION 'Project unavailable' USING ERRCODE='42501'; END IF;
 -- Older payroll has no project ID. All unallocated positive paid vouchers are
 -- global signals, even without attendance. A site attendance match is a clue,
 -- not proof of attribution or the absence of other project costs.
 WITH allocations AS (SELECT payroll_id,count(*) n,sum(gross) gross FROM public.weekly_worker_paid_allocations GROUP BY payroll_id),
 paid AS (SELECT p.*,coalesce(a.n,0) n,a.gross allocated FROM public.payroll p LEFT JOIN allocations a ON a.payroll_id=p.id WHERE p.status='paid')
 SELECT count(*) FILTER (WHERE n=0 AND gross_pay>0),
  count(*) FILTER (WHERE n=0 AND gross_pay>0 AND EXISTS(SELECT 1 FROM public.attendance a WHERE a.project_id=p_project AND a.worker_id=paid.worker_id AND a.date BETWEEN paid.period_start AND paid.period_end)),
  count(*) FILTER (WHERE gross_pay IS NULL OR (n>0 AND allocated IS DISTINCT FROM gross_pay))
 INTO v_missing,v_site,v_inconsistent FROM paid;
 SELECT count(*) INTO v_history FROM public.historical_external_worker_payroll h
 WHERE h.gross>0 AND NOT EXISTS(SELECT 1 FROM public.historical_worker_attributions a WHERE a.source_id=h.request_id);
 -- Same STABLE statement snapshot as the signals above.
 v_review:=public.project_cost_corrected_review(p_project,NULL);
 RETURN jsonb_build_object('project_id',p_project,'captured_at',statement_timestamp(),
  'unallocated_paid',v_missing,'attendance_matches',v_site,'inconsistent_allocations',v_inconsistent,
  'unattributed_history',v_history,'review',v_review);
END $$;
REVOKE ALL ON FUNCTION public.project_cost_recorded_coverage(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.project_cost_recorded_coverage(uuid) TO authenticated;
DO $postflight$ BEGIN
 IF has_function_privilege('anon','public.project_cost_recorded_coverage(uuid)','EXECUTE')
 OR has_function_privilege('service_role','public.project_cost_recorded_coverage(uuid)','EXECUTE')
 OR NOT has_function_privilege('authenticated','public.project_cost_recorded_coverage(uuid)','EXECUTE')
 OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE oid='public.project_cost_recorded_coverage(uuid)'::regprocedure
  AND prosecdef AND provolatile='s' AND proconfig @> ARRAY['search_path=""']) THEN
  RAISE EXCEPTION 'Unexpected recorded-cost coverage privileges'; END IF;
END $postflight$;
