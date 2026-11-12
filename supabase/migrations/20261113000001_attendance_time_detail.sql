-- Supplemental time details are append-only and do not modify attendance or payroll.
-- No legacy rows are backfilled. A later attendance change makes a detail stale.
CREATE TABLE public.attendance_time_details (
  request_id uuid PRIMARY KEY,
  revision_id bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  attendance_id uuid NOT NULL REFERENCES public.attendance(id) ON DELETE RESTRICT,
  worker_id uuid NOT NULL REFERENCES public.workers(id) ON DELETE RESTRICT,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE RESTRICT,
  attendance_date date NOT NULL,
  attendance_status text NOT NULL,
  attendance_hours numeric NOT NULL,
  attendance_submitted_at timestamptz NOT NULL,
  regular_hours numeric(4,2) NOT NULL CHECK (regular_hours >= 0 AND regular_hours <= 8),
  overtime_hours numeric(4,2) NOT NULL CHECK (overtime_hours >= 0 AND overtime_hours <= 24),
  note text NOT NULL CHECK (length(note) BETWEEN 1 AND 500),
  recorded_by uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (regular_hours + overtime_hours <= 24)
);
CREATE INDEX attendance_time_details_latest ON public.attendance_time_details(attendance_id,revision_id DESC);
ALTER TABLE public.attendance_time_details ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.attendance_time_details FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.attendance_time_details TO authenticated;
CREATE POLICY attendance_time_details_read ON public.attendance_time_details FOR SELECT TO authenticated
  USING (public.session_assurance_satisfied() AND (public.is_founder() OR public.is_supervisor_assigned(project_id)));

-- A caller-visible record, not a substitute for the underlying attendance status.
CREATE FUNCTION public.attendance_time_detail_latest(p_attendance uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $$
DECLARE v_result jsonb;
BEGIN
  IF NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Attendance access required' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.attendance a WHERE a.id=p_attendance) THEN
    RAISE EXCEPTION 'Attendance unavailable' USING ERRCODE='42501';
  END IF;
  SELECT jsonb_build_object('request_id',d.request_id,'regular_hours',d.regular_hours::text,'overtime_hours',d.overtime_hours::text,
    'note',d.note,'recorded_at',d.recorded_at,'recorded_by',d.recorded_by,
    'stale', (d.worker_id,d.project_id,d.attendance_date,d.attendance_status,d.attendance_hours,d.attendance_submitted_at)
      IS DISTINCT FROM (a.worker_id,a.project_id,a.date,a.status,a.hours_worked,a.submitted_at))
    INTO v_result
  FROM public.attendance_time_details d JOIN public.attendance a ON a.id=d.attendance_id
  WHERE d.attendance_id=p_attendance ORDER BY d.revision_id DESC LIMIT 1;
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.attendance_time_detail_latest(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.attendance_time_detail_latest(uuid) TO authenticated;

-- Serialize with payroll approval/payment and other detailed-time writes for this
-- worker. Old attendance writes remain separate; the read path flags staleness.
CREATE FUNCTION public.record_attendance_time_detail(p_request uuid,p_attendance uuid,p_expected_submitted_at timestamptz,p_regular numeric,p_overtime numeric,p_note text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_att public.attendance%ROWTYPE; v_worker uuid; v_user public.users%ROWTYPE; v_prev public.attendance_time_details%ROWTYPE; v_detail public.attendance_time_details%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Attendance access required' USING ERRCODE='42501'; END IF;
  -- A snapshot taken before a concurrent approval could otherwise hide it after the worker lock is acquired.
  IF current_setting('transaction_isolation') <> 'read committed' THEN RAISE EXCEPTION 'Time detail recording requires read committed isolation' USING ERRCODE='P1002'; END IF;
  IF p_request IS NULL OR p_attendance IS NULL OR p_expected_submitted_at IS NULL OR p_regular IS NULL OR p_overtime IS NULL
    OR p_regular <> round(p_regular,2) OR p_overtime <> round(p_overtime,2)
    OR p_regular < 0 OR p_regular > 8 OR p_overtime < 0 OR p_regular+p_overtime > 24
    OR p_note IS NULL OR length(btrim(p_note)) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'Enter valid hours (up to 8 regular, 24 total) and a reason' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_user FROM public.users WHERE id=auth.uid() FOR SHARE;
  IF NOT FOUND OR v_user.role NOT IN ('founder','supervisor') THEN RAISE EXCEPTION 'Attendance access required' USING ERRCODE='42501'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('attendance-time:' || p_request::text,0));
  SELECT worker_id INTO v_worker FROM public.attendance WHERE id=p_attendance;
  IF NOT FOUND THEN RAISE EXCEPTION 'Attendance unavailable' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM public.workers WHERE id=v_worker FOR UPDATE;
  SELECT * INTO v_att FROM public.attendance WHERE id=p_attendance FOR UPDATE;
  IF NOT FOUND OR v_att.worker_id<>v_worker THEN RAISE EXCEPTION 'Attendance changed; refresh' USING ERRCODE='40001'; END IF;
  IF v_user.role='supervisor' THEN
    PERFORM 1 FROM public.project_supervisors WHERE supervisor_id=auth.uid() AND project_id=v_att.project_id FOR KEY SHARE;
    IF NOT FOUND OR NOT coalesce(public.is_supervisor_assigned(v_att.project_id),false) THEN RAISE EXCEPTION 'Project access required' USING ERRCODE='42501'; END IF;
  ELSIF NOT coalesce(public.is_founder(),false) THEN RAISE EXCEPTION 'Founder access required' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_prev FROM public.attendance_time_details WHERE request_id=p_request;
  IF FOUND THEN
    IF (v_prev.recorded_by,v_prev.attendance_id,v_prev.attendance_submitted_at,v_prev.regular_hours,v_prev.overtime_hours,v_prev.note)
       IS DISTINCT FROM (auth.uid(),p_attendance,p_expected_submitted_at,p_regular,p_overtime,btrim(p_note)) THEN
      RAISE EXCEPTION 'Request ID already used for different details' USING ERRCODE='22023';
    END IF;
    RETURN jsonb_build_object('request_id',v_prev.request_id,'replayed',true);
  END IF;
  IF v_att.submitted_at IS DISTINCT FROM p_expected_submitted_at THEN RAISE EXCEPTION 'Attendance changed; refresh before recording hours' USING ERRCODE='40001'; END IF;
  IF v_att.status NOT IN ('present','half_day') OR p_regular+p_overtime <= 0 THEN RAISE EXCEPTION 'Time details require a worked attendance record' USING ERRCODE='22023'; END IF;
  IF EXISTS (SELECT 1 FROM public.workers w WHERE w.id=v_worker AND
    (strpos(lower(w.position),'supervisor')>0 OR EXISTS(SELECT 1 FROM public.users u WHERE u.role='supervisor' AND (u.id=w.id OR lower(btrim(u.name))=lower(btrim(w.name)))))) THEN
    RAISE EXCEPTION 'Possible Supervisor profile requires separate review' USING ERRCODE='22023';
  END IF;
  IF EXISTS (SELECT 1 FROM public.payroll p WHERE p.worker_id=v_worker AND v_att.date BETWEEN p.period_start AND p.period_end AND p.status IN ('approved','paid')) THEN
    RAISE EXCEPTION 'Approved or paid payroll covers this date; review a separate correction, do not change its inputs here' USING ERRCODE='22023';
  END IF;
  INSERT INTO public.attendance_time_details(request_id,attendance_id,worker_id,project_id,attendance_date,attendance_status,attendance_hours,attendance_submitted_at,regular_hours,overtime_hours,note,recorded_by)
    VALUES(p_request,v_att.id,v_att.worker_id,v_att.project_id,v_att.date,v_att.status,v_att.hours_worked,v_att.submitted_at,p_regular,p_overtime,btrim(p_note),auth.uid()) RETURNING * INTO v_detail;
  RETURN jsonb_build_object('request_id',v_detail.request_id,'replayed',false);
END;
$$;
REVOKE ALL ON FUNCTION public.record_attendance_time_detail(uuid,uuid,timestamptz,numeric,numeric,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.record_attendance_time_detail(uuid,uuid,timestamptz,numeric,numeric,text) TO authenticated;

-- Enrich the existing read-only weekly snapshot in the same database snapshot.
-- The original function retains Founder checks, bounds and caller RLS.
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
