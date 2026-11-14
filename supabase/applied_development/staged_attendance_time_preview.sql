-- Development only: add the read-only time-detail wrapper without enabling writes.
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
DO $preflight$
DECLARE f regprocedure:=to_regprocedure('public.weekly_worker_preview_inputs(date)');
BEGIN
 IF f IS NULL OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=f AND NOT prosecdef AND provolatile='s' AND md5(prosrc)='e94e19cb53dbeb677bf02b24dd43cb13') OR has_function_privilege('anon',f,'EXECUTE') OR NOT has_function_privilege('authenticated',f,'EXECUTE') OR to_regprocedure('public.weekly_worker_preview_base_inputs(date)') IS NOT NULL OR to_regprocedure('public.weekly_worker_time_preview_inputs(date)') IS NOT NULL THEN RAISE EXCEPTION 'Weekly preview base changed; reconcile before continuing'; END IF;
 IF to_regclass('public.attendance_time_details') IS NULL OR NOT EXISTS(SELECT 1 FROM pg_class WHERE oid='public.attendance_time_details'::regclass AND relrowsecurity) OR EXISTS(SELECT 1 FROM public.attendance_time_details) OR EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r(role_name) WHERE has_function_privilege(r.role_name,'public.record_attendance_time_detail(uuid,uuid,timestamptz,numeric,numeric,text)','EXECUTE')) THEN RAISE EXCEPTION 'Staged time detail state changed'; END IF;
END $preflight$;
ALTER FUNCTION public.weekly_worker_preview_inputs(date) RENAME TO weekly_worker_preview_base_inputs;
CREATE FUNCTION public.weekly_worker_preview_inputs(p_start date)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $$
DECLARE v_base jsonb; v_entries jsonb; v_result jsonb;
BEGIN
  v_base := public.weekly_worker_preview_base_inputs(p_start);
  SELECT coalesce(jsonb_agg(item.entry || jsonb_build_object('time_detail',detail.value) ORDER BY item.ordinality),'[]'::jsonb)
  INTO v_entries
  FROM jsonb_array_elements(v_base->'attendance') WITH ORDINALITY AS item(entry,ordinality)
  JOIN public.attendance a ON a.id=(item.entry->>'id')::uuid
  LEFT JOIN LATERAL (
    SELECT jsonb_build_object('regular_hours',d.regular_hours::text,'overtime_hours',d.overtime_hours::text,
      'stale',(d.worker_id,d.project_id,d.attendance_date,d.attendance_status,d.attendance_hours,d.attendance_submitted_at)
        IS DISTINCT FROM (a.worker_id,a.project_id,a.date,a.status,a.hours_worked,a.submitted_at)) AS value
    FROM public.attendance_time_details d WHERE d.attendance_id=a.id
    ORDER BY d.revision_id DESC LIMIT 1
  ) detail ON true;
  IF jsonb_array_length(v_entries) <> jsonb_array_length(v_base->'attendance') THEN
    RAISE EXCEPTION 'Attendance scope changed; reload the preview' USING ERRCODE='40001';
  END IF;
  v_result := jsonb_set(v_base,'{attendance}',v_entries);
  IF octet_length(v_result::text)>8388608 THEN RAISE EXCEPTION 'Weekly preview response too large' USING ERRCODE='54000'; END IF;
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.weekly_worker_preview_inputs(date) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.weekly_worker_preview_inputs(date) TO authenticated;
DO $postflight$ BEGIN
 IF has_function_privilege('anon','public.weekly_worker_preview_inputs(date)','EXECUTE') OR NOT has_function_privilege('authenticated','public.weekly_worker_preview_inputs(date)','EXECUTE') OR has_function_privilege('authenticated','public.record_attendance_time_detail(uuid,uuid,timestamptz,numeric,numeric,text)','EXECUTE') THEN RAISE EXCEPTION 'Unexpected staged preview privileges'; END IF;
END $postflight$;
