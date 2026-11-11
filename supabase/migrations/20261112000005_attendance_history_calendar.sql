-- Month markers for the existing history filters. Reads as the caller; never
-- infers absences, changes records or bypasses table/worker/project RLS.
CREATE OR REPLACE FUNCTION public.attendance_history_calendar(
  p_month date, p_project_id uuid DEFAULT NULL, p_status text DEFAULT NULL, p_search text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $$
DECLARE v_result jsonb;
BEGIN
  IF p_month IS NULL OR p_month <> date_trunc('month',p_month)::date OR p_month < '1900-01-01'::date OR p_month > '9998-12-01'::date THEN
    RAISE EXCEPTION 'Invalid calendar month' USING ERRCODE='22023';
  END IF;
  IF p_status IS NOT NULL AND p_status NOT IN ('present','half_day','absent','leave') THEN
    RAISE EXCEPTION 'Invalid attendance status' USING ERRCODE='22023';
  END IF;
  IF length(coalesce(p_search,'')) > 200 THEN RAISE EXCEPTION 'Search is too long' USING ERRCODE='22023'; END IF;
  IF NOT coalesce(public.session_assurance_satisfied(),false) OR NOT EXISTS (
    SELECT 1 FROM public.users u WHERE u.id=auth.uid() AND u.role IN ('founder','supervisor')
  ) THEN RAISE EXCEPTION 'Attendance access required' USING ERRCODE='42501'; END IF;
  IF p_project_id IS NOT NULL AND NOT (coalesce(public.is_founder(),false) OR coalesce(public.is_supervisor_assigned(p_project_id),false)) THEN
    RAISE EXCEPTION 'Project access required' USING ERRCODE='42501';
  END IF;
  IF p_project_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.projects p WHERE p.id=p_project_id) THEN
    RAISE EXCEPTION 'Project unavailable' USING ERRCODE='42501';
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('date',d.date,'count',d.record_count) ORDER BY d.date),'[]'::jsonb)
    INTO v_result FROM (
      SELECT a.date,count(*) AS record_count
      FROM public.attendance a
      LEFT JOIN public.workers w ON w.id=a.worker_id
      LEFT JOIN public.projects p ON p.id=a.project_id
      WHERE a.date >= p_month-6 AND a.date < (p_month+interval '1 month')::date+6
        AND (p_project_id IS NULL OR a.project_id=p_project_id)
        AND (p_status IS NULL OR a.status=p_status)
        AND (nullif(btrim(p_search),'') IS NULL OR
          strpos(lower(coalesce(w.name,'')),lower(btrim(p_search)))>0 OR
          strpos(lower(coalesce(w.position,'')),lower(btrim(p_search)))>0 OR
          strpos(lower(coalesce(p.name,'')),lower(btrim(p_search)))>0 OR
          strpos(lower(coalesce(a.notes,'')),lower(btrim(p_search)))>0)
      GROUP BY a.date
    ) d;
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.attendance_history_calendar(date,uuid,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.attendance_history_calendar(date,uuid,text,text) TO authenticated;
