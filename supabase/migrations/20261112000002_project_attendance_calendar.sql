-- Read-only site calendar counts, bounded to one month plus its edge weeks.
-- Caller RLS remains in force; no attendance or financial data is changed.
CREATE OR REPLACE FUNCTION public.project_attendance_calendar(p_project_id uuid, p_month date)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE v_result jsonb;
BEGIN
  IF p_project_id IS NULL OR p_month IS NULL OR p_month <> date_trunc('month',p_month)::date
    OR p_month < '1900-01-01'::date OR p_month > '9998-12-01'::date THEN
    RAISE EXCEPTION 'Invalid project or calendar month' USING ERRCODE='22023';
  END IF;
  IF NOT (coalesce(public.is_founder(),false) OR coalesce(public.is_supervisor_assigned(p_project_id),false)) THEN
    RAISE EXCEPTION 'Project access required' USING ERRCODE='42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.projects p WHERE p.id=p_project_id) THEN
    RAISE EXCEPTION 'Project unavailable' USING ERRCODE='42501';
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('date', x.date, 'count', x.record_count) ORDER BY x.date),'[]'::jsonb)
  INTO v_result FROM (
    SELECT a.date, count(*) AS record_count FROM public.attendance a
    WHERE a.project_id=p_project_id AND a.date >= p_month - 6
      AND a.date < (p_month + interval '1 month')::date + 6
    GROUP BY a.date
  ) x;
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.project_attendance_calendar(uuid,date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.project_attendance_calendar(uuid,date) TO authenticated;
