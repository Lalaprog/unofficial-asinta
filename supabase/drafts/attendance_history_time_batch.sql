-- UNINSTALLED DRAFT: read-only attendance-history enrichment. This is not a
-- payroll calculation, a backfill, or proof that all details are visible. It
-- requires the reviewed attendance-time-detail migration and existing RLS.
-- Install only as a single transaction after catalog/permission review.
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
DO $preflight$
BEGIN
 IF to_regprocedure('auth.uid()') IS NULL OR to_regprocedure('public.session_assurance_satisfied()') IS NULL
 OR to_regprocedure('public.attendance_time_detail_latest(uuid)') IS NULL
 OR to_regclass('public.attendance') IS NULL OR to_regclass('public.attendance_time_details') IS NULL THEN
  RAISE EXCEPTION 'Attendance time history prerequisites missing'; END IF;
 IF to_regprocedure('public.attendance_history_time_batch(uuid[])') IS NOT NULL THEN RAISE EXCEPTION 'Attendance time history already exists'; END IF;
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_class WHERE oid IN ('public.attendance'::regclass,'public.attendance_time_details'::regclass) AND (relkind<>'r' OR NOT relrowsecurity)) THEN RAISE EXCEPTION 'Attendance time history requires RLS'; END IF;
END;
$preflight$;

-- SECURITY INVOKER: both attendance and supplemental details are filtered by
-- the caller's RLS. Missing/hidden requested attendance fails the whole batch;
-- a null detail means no *visible* detail, not that none exists globally.
-- A newer detail can be invisible after a site move; only describe this result
-- as the latest visible revision. Each batch is one statement snapshot.
CREATE FUNCTION public.attendance_history_time_batch(p_ids uuid[]) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $$
DECLARE v_count integer; v_rows jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Attendance access required' USING ERRCODE='42501'; END IF;
 IF p_ids IS NULL OR cardinality(p_ids)<1 OR cardinality(p_ids)>100 OR array_position(p_ids,NULL) IS NOT NULL
 OR (SELECT count(DISTINCT x) FROM unnest(p_ids) x)<>cardinality(p_ids) THEN
  RAISE EXCEPTION 'Provide 1 to 100 distinct attendance IDs' USING ERRCODE='22023'; END IF;
 SELECT count(*) INTO v_count FROM public.attendance a WHERE a.id=ANY(p_ids);
 IF v_count<>cardinality(p_ids) THEN RAISE EXCEPTION 'Some attendance records are unavailable; refresh' USING ERRCODE='42501'; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',a.id,'worker_id',a.worker_id,'project_id',a.project_id,'date',a.date,
   'status',a.status,'hours_worked',a.hours_worked,'submitted_at',a.submitted_at,'detail',d.detail) ORDER BY requested.ordinality),'[]'::jsonb)
 INTO v_rows FROM unnest(p_ids) WITH ORDINALITY requested(id,ordinality)
 JOIN public.attendance a ON a.id=requested.id
 LEFT JOIN LATERAL (
  SELECT jsonb_build_object('regular_hours',t.regular_hours::text,'overtime_hours',t.overtime_hours::text,
   'stale',(t.worker_id,t.project_id,t.attendance_date,t.attendance_status,t.attendance_hours,t.attendance_submitted_at)
    IS DISTINCT FROM (a.worker_id,a.project_id,a.date,a.status,a.hours_worked,a.submitted_at)) detail
  FROM public.attendance_time_details t WHERE t.attendance_id=a.id ORDER BY t.revision_id DESC LIMIT 1
 ) d ON true;
 IF jsonb_array_length(v_rows)<>cardinality(p_ids) THEN RAISE EXCEPTION 'Attendance scope changed; refresh' USING ERRCODE='40001'; END IF;
 RETURN jsonb_build_object('items',v_rows);
END;
$$;
REVOKE ALL ON FUNCTION public.attendance_history_time_batch(uuid[]) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.attendance_history_time_batch(uuid[]) TO authenticated;
DO $postflight$
BEGIN
 IF has_function_privilege('anon','public.attendance_history_time_batch(uuid[])','EXECUTE')
 OR has_function_privilege('service_role','public.attendance_history_time_batch(uuid[])','EXECUTE')
 OR NOT has_function_privilege('authenticated','public.attendance_history_time_batch(uuid[])','EXECUTE') THEN
  RAISE EXCEPTION 'Unexpected attendance time batch privileges'; END IF;
END;
$postflight$;
