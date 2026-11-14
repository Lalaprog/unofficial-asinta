-- EXPERIMENTAL, UNINSTALLED, READ ONLY. Compare a paid source-bound worker
-- voucher's saved attendance and latest detailed hours with the current rows.
-- A legacy paid voucher has no source snapshot: report unavailable, not clean.
-- This is a point-in-time signal, not a correction, audit, payment proof, or a
-- comparison of rates, allowances, Bale, external payments or project costs.
-- Requires the exact reviewed weekly source/time-detail drafts. Do not install
-- on a shared database until coordinated cutover, ACL and recovery are reviewed.
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
DO $preflight$
BEGIN
 IF pg_catalog.to_regclass('public.payroll') IS NULL OR pg_catalog.to_regclass('public.attendance') IS NULL
 OR pg_catalog.to_regclass('public.attendance_time_details') IS NULL OR pg_catalog.to_regclass('public.weekly_worker_draft_sources') IS NULL
 OR pg_catalog.to_regprocedure('auth.uid()') IS NULL OR pg_catalog.to_regprocedure('public.is_founder()') IS NULL
 OR pg_catalog.to_regprocedure('public.session_assurance_satisfied()') IS NULL THEN RAISE EXCEPTION 'Paid attendance review prerequisites missing'; END IF;
 IF pg_catalog.to_regprocedure('public.weekly_paid_attendance_change_review(uuid)') IS NOT NULL THEN RAISE EXCEPTION 'Paid attendance review name collision'; END IF;
END;
$preflight$;
CREATE FUNCTION public.weekly_paid_attendance_change_review(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_pay public.payroll%ROWTYPE; v_source public.weekly_worker_draft_sources%ROWTYPE; v_saved jsonb; v_current jsonb; v_status text;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 IF p_id IS NULL THEN RAISE EXCEPTION 'Choose a paid voucher' USING ERRCODE='22023'; END IF;
 SELECT * INTO v_pay FROM public.payroll WHERE id=p_id AND status='paid';
 IF NOT FOUND THEN RAISE EXCEPTION 'Paid voucher unavailable' USING ERRCODE='P0002'; END IF;
 SELECT * INTO v_source FROM public.weekly_worker_draft_sources WHERE payroll_id=p_id;
 IF NOT FOUND THEN
  v_status:='unavailable';
 ELSE
  IF v_source.worker_id IS DISTINCT FROM v_pay.worker_id OR v_source.period_start IS DISTINCT FROM v_pay.period_start OR v_pay.period_end IS DISTINCT FROM v_pay.period_start+6
   OR v_source.source_snapshot->'version' IS DISTINCT FROM '1'::jsonb OR coalesce(jsonb_typeof(v_source.source_snapshot->'attendance'),'')<>'array' THEN
   RAISE EXCEPTION 'Saved weekly attendance evidence is inconsistent; investigate' USING ERRCODE='22023'; END IF;
  v_saved:=v_source.source_snapshot->'attendance';
  IF jsonb_array_length(v_saved)<1 OR jsonb_array_length(v_saved)>500 OR EXISTS(
   SELECT 1 FROM jsonb_array_elements(v_saved) x
   WHERE coalesce(jsonb_typeof(x),'')<>'object' OR coalesce(jsonb_typeof(x->'record'),'')<>'object'
    OR coalesce(jsonb_typeof(x->'latest_detail'),'') NOT IN ('object','null')
    OR coalesce(x->'record'->>'id','')='' OR x->'record'->>'worker_id' IS DISTINCT FROM v_pay.worker_id::text
    OR coalesce(x->'record'->>'date','') NOT BETWEEN v_pay.period_start::text AND v_pay.period_end::text
  ) OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_saved) x GROUP BY x->'record'->>'id' HAVING count(*)>1) THEN
   RAISE EXCEPTION 'Saved weekly attendance evidence is incomplete; investigate' USING ERRCODE='22023'; END IF;
  IF (SELECT count(*) FROM (SELECT 1 FROM public.attendance a WHERE a.worker_id=v_pay.worker_id AND a.date BETWEEN v_pay.period_start AND v_pay.period_end LIMIT 501) bounded)>500 THEN
   RAISE EXCEPTION 'Too many attendance records to compare; investigate' USING ERRCODE='54000'; END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('record',to_jsonb(a),'latest_detail',d.detail) ORDER BY a.date,a.id),'[]'::jsonb) INTO v_current
   FROM public.attendance a LEFT JOIN LATERAL (SELECT to_jsonb(t) detail FROM public.attendance_time_details t WHERE t.attendance_id=a.id ORDER BY t.revision_id DESC LIMIT 1) d ON true
   WHERE a.worker_id=v_pay.worker_id AND a.date BETWEEN v_pay.period_start AND v_pay.period_end;
  v_status:=CASE WHEN v_current IS DISTINCT FROM v_saved THEN 'changed' ELSE 'unchanged' END;
 END IF;
 RETURN jsonb_build_object('payroll_id',v_pay.id,'worker_id',v_pay.worker_id,'period_start',v_pay.period_start,'period_end',v_pay.period_end,'attendance',v_status);
END;
$$;
REVOKE ALL ON FUNCTION public.weekly_paid_attendance_change_review(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.weekly_paid_attendance_change_review(uuid) TO authenticated;
DO $postflight$
BEGIN
 IF pg_catalog.has_function_privilege('anon','public.weekly_paid_attendance_change_review(uuid)','EXECUTE')
 OR pg_catalog.has_function_privilege('service_role','public.weekly_paid_attendance_change_review(uuid)','EXECUTE')
 OR NOT pg_catalog.has_function_privilege('authenticated','public.weekly_paid_attendance_change_review(uuid)','EXECUTE') THEN
  RAISE EXCEPTION 'Unexpected paid attendance review function privileges'; END IF;
END;
$postflight$;
