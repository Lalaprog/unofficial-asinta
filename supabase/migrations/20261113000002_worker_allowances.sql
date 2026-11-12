-- Allowances are new records only; no historical attendance or payroll is backfilled.
-- Neither approving an allowance nor reading it issues money or updates payroll.
CREATE TABLE public.worker_allowances (
  id uuid PRIMARY KEY,
  attendance_id uuid NOT NULL REFERENCES public.attendance(id) ON DELETE RESTRICT,
  worker_id uuid NOT NULL REFERENCES public.workers(id) ON DELETE RESTRICT,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE RESTRICT,
  attendance_date date NOT NULL,
  attendance_status text NOT NULL,
  attendance_hours numeric NOT NULL,
  attendance_submitted_at timestamptz NOT NULL,
  amount numeric(10,2) NOT NULL CHECK (amount > 0),
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 500),
  status text NOT NULL CHECK (status IN ('pending','approved','rejected')),
  submitted_by uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  submitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  reviewed_by uuid REFERENCES public.users(id) ON DELETE RESTRICT,
  reviewed_at timestamptz,
  CHECK ((status='pending' AND reviewed_by IS NULL AND reviewed_at IS NULL) OR (status IN ('approved','rejected') AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL))
);
CREATE INDEX worker_allowances_attendance_idx ON public.worker_allowances(attendance_id,submitted_at,id);
CREATE INDEX worker_allowances_pending_idx ON public.worker_allowances(submitted_at,id) WHERE status='pending';
ALTER TABLE public.worker_allowances ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.worker_allowances FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.worker_allowances TO authenticated;
CREATE POLICY worker_allowances_read ON public.worker_allowances FOR SELECT TO authenticated
  USING (public.session_assurance_satisfied() AND (public.is_founder() OR public.is_supervisor_assigned(project_id)));

CREATE FUNCTION public.worker_allowances_for_attendance(p_attendance uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $$
DECLARE v_result jsonb;
BEGIN
  IF NOT coalesce(public.session_assurance_satisfied(),false) OR NOT EXISTS(SELECT 1 FROM public.attendance WHERE id=p_attendance) THEN
    RAISE EXCEPTION 'Attendance access required' USING ERRCODE='42501';
  END IF;
  IF (SELECT count(*) FROM public.worker_allowances WHERE attendance_id=p_attendance)>100 THEN
    RAISE EXCEPTION 'Too many allowance records for this attendance; review with an administrator' USING ERRCODE='54000';
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',w.id,'amount',w.amount::text,'description',w.description,'status',w.status,
    'submitted_at',w.submitted_at,'reviewed_at',w.reviewed_at,
    'stale',(w.worker_id,w.project_id,w.attendance_date,w.attendance_status,w.attendance_hours,w.attendance_submitted_at)
      IS DISTINCT FROM (a.worker_id,a.project_id,a.date,a.status,a.hours_worked,a.submitted_at)) ORDER BY w.submitted_at,w.id),'[]'::jsonb)
  INTO v_result FROM public.worker_allowances w JOIN public.attendance a ON a.id=w.attendance_id WHERE w.attendance_id=p_attendance;
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.worker_allowances_for_attendance(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.worker_allowances_for_attendance(uuid) TO authenticated;

-- Idempotent requests use the client-supplied ID. The source attendance and
-- worker are locked before checking finalized payroll, in the same order as
-- the detailed time path. The Founder records an immediately approved entry.
CREATE FUNCTION public.submit_worker_allowance(p_id uuid,p_attendance uuid,p_expected_submitted_at timestamptz,p_amount numeric,p_description text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_user public.users%ROWTYPE; v_att public.attendance%ROWTYPE; v_worker uuid; v_prev public.worker_allowances%ROWTYPE; v_status text;
BEGIN
  IF auth.uid() IS NULL OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Attendance access required' USING ERRCODE='42501'; END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN RAISE EXCEPTION 'Allowance submission requires read committed isolation' USING ERRCODE='P1002'; END IF;
  IF p_id IS NULL OR p_attendance IS NULL OR p_expected_submitted_at IS NULL OR p_amount IS NULL OR p_amount <= 0 OR p_amount > 99999999.99 OR p_amount<>round(p_amount,2)
    OR p_description IS NULL OR length(btrim(p_description)) NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'Enter a valid amount and description' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_user FROM public.users WHERE id=auth.uid() FOR SHARE;
  IF NOT FOUND OR v_user.role NOT IN ('founder','supervisor') THEN RAISE EXCEPTION 'Attendance access required' USING ERRCODE='42501'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('worker-allowance:' || p_id::text,0));
  SELECT worker_id INTO v_worker FROM public.attendance WHERE id=p_attendance;
  IF NOT FOUND THEN RAISE EXCEPTION 'Attendance unavailable' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM public.workers WHERE id=v_worker FOR UPDATE;
  SELECT * INTO v_att FROM public.attendance WHERE id=p_attendance FOR UPDATE;
  IF NOT FOUND OR v_att.worker_id<>v_worker THEN RAISE EXCEPTION 'Attendance changed; refresh' USING ERRCODE='40001'; END IF;
  IF v_user.role='supervisor' THEN
    PERFORM 1 FROM public.project_supervisors WHERE supervisor_id=auth.uid() AND project_id=v_att.project_id FOR KEY SHARE;
    IF NOT FOUND OR NOT coalesce(public.is_supervisor_assigned(v_att.project_id),false) THEN RAISE EXCEPTION 'Project access required' USING ERRCODE='42501'; END IF;
  ELSIF NOT coalesce(public.is_founder(),false) THEN RAISE EXCEPTION 'Founder access required' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_prev FROM public.worker_allowances WHERE id=p_id;
  IF FOUND THEN
    IF (v_prev.submitted_by,v_prev.attendance_id,v_prev.attendance_submitted_at,v_prev.amount,v_prev.description)
      IS DISTINCT FROM (auth.uid(),p_attendance,p_expected_submitted_at,p_amount,btrim(p_description)) THEN
      RAISE EXCEPTION 'Request ID already used for a different allowance' USING ERRCODE='22023'; END IF;
    RETURN jsonb_build_object('id',v_prev.id,'status',v_prev.status,'replayed',true);
  END IF;
  IF v_att.submitted_at IS DISTINCT FROM p_expected_submitted_at THEN RAISE EXCEPTION 'Attendance changed; refresh' USING ERRCODE='40001'; END IF;
  IF v_att.status NOT IN ('present','half_day') THEN RAISE EXCEPTION 'Allowance requires a worked attendance record' USING ERRCODE='22023'; END IF;
  IF coalesce(v_att.worker_id=v_att.recorded_by,false) OR strpos(coalesce(v_att.notes,''),'Pending Founder Review')>0 OR strpos(coalesce(v_att.notes,''),'Founder Review:')>0 OR EXISTS(SELECT 1 FROM public.workers w WHERE w.id=v_worker AND (strpos(lower(w.position),'supervisor')>0
      OR EXISTS(SELECT 1 FROM public.users u WHERE u.role='supervisor' AND (u.id=w.id OR lower(btrim(u.name))=lower(btrim(w.name)))))) THEN
    RAISE EXCEPTION 'Possible Supervisor profile requires separate review' USING ERRCODE='22023'; END IF;
  IF EXISTS(SELECT 1 FROM public.payroll p WHERE p.worker_id=v_worker AND v_att.date BETWEEN p.period_start AND p.period_end AND p.status IN ('approved','paid')) THEN
    RAISE EXCEPTION 'Approved or paid payroll covers this date; review a separate correction' USING ERRCODE='22023'; END IF;
  IF (SELECT count(*) FROM public.worker_allowances WHERE attendance_id=v_att.id)>=100 THEN RAISE EXCEPTION 'Too many allowance records for this attendance; review with an administrator' USING ERRCODE='54000'; END IF;
  v_status:=CASE WHEN v_user.role='founder' THEN 'approved' ELSE 'pending' END;
  INSERT INTO public.worker_allowances(id,attendance_id,worker_id,project_id,attendance_date,attendance_status,attendance_hours,attendance_submitted_at,amount,description,status,submitted_by,reviewed_by,reviewed_at)
  VALUES(p_id,v_att.id,v_att.worker_id,v_att.project_id,v_att.date,v_att.status,v_att.hours_worked,v_att.submitted_at,p_amount,btrim(p_description),v_status,auth.uid(),CASE WHEN v_status='approved' THEN auth.uid() END,CASE WHEN v_status='approved' THEN clock_timestamp() END);
  RETURN jsonb_build_object('id',p_id,'status',v_status,'replayed',false);
END;
$$;
REVOKE ALL ON FUNCTION public.submit_worker_allowance(uuid,uuid,timestamptz,numeric,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.submit_worker_allowance(uuid,uuid,timestamptz,numeric,text) TO authenticated;

-- Founder decision is irreversible here; changes to approved/paid history need
-- a separately designed adjustment workflow, never silent in-place correction.
CREATE FUNCTION public.review_worker_allowance(p_id uuid,p_decision text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_worker uuid; v_att_id uuid; v_att public.attendance%ROWTYPE; v_before public.worker_allowances%ROWTYPE;
BEGIN
  IF NOT coalesce(public.is_founder(),false) THEN RAISE EXCEPTION 'Founder access required' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM public.users WHERE id=auth.uid() AND role='founder' FOR SHARE;
  IF NOT FOUND OR NOT coalesce(public.is_founder(),false) THEN RAISE EXCEPTION 'Founder access required' USING ERRCODE='42501'; END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN RAISE EXCEPTION 'Allowance review requires read committed isolation' USING ERRCODE='P1002'; END IF;
  IF p_decision IS NULL OR p_decision NOT IN ('approved','rejected') THEN RAISE EXCEPTION 'Invalid decision' USING ERRCODE='22023'; END IF;
  SELECT worker_id,attendance_id INTO v_worker,v_att_id FROM public.worker_allowances WHERE id=p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Allowance unavailable' USING ERRCODE='P0002'; END IF;
  PERFORM 1 FROM public.workers WHERE id=v_worker FOR UPDATE;
  SELECT * INTO v_att FROM public.attendance WHERE id=v_att_id FOR UPDATE;
  SELECT * INTO v_before FROM public.worker_allowances WHERE id=p_id FOR UPDATE;
  IF NOT FOUND OR v_before.worker_id<>v_worker OR v_before.attendance_id<>v_att_id THEN RAISE EXCEPTION 'Allowance changed; refresh' USING ERRCODE='40001'; END IF;
  IF v_before.status=p_decision THEN RETURN jsonb_build_object('id',p_id,'status',p_decision,'replayed',true); END IF;
  IF v_before.status<>'pending' THEN RAISE EXCEPTION 'Allowance already reviewed; refresh' USING ERRCODE='22023'; END IF;
  IF p_decision='approved' THEN
    IF v_att.id IS NULL OR (v_before.worker_id,v_before.project_id,v_before.attendance_date,v_before.attendance_status,v_before.attendance_hours,v_before.attendance_submitted_at)
      IS DISTINCT FROM (v_att.worker_id,v_att.project_id,v_att.date,v_att.status,v_att.hours_worked,v_att.submitted_at) THEN
      RAISE EXCEPTION 'Attendance changed; review the source before approving' USING ERRCODE='40001'; END IF;
    IF coalesce(v_att.worker_id=v_att.recorded_by,false) OR strpos(coalesce(v_att.notes,''),'Pending Founder Review')>0 OR strpos(coalesce(v_att.notes,''),'Founder Review:')>0 OR EXISTS(SELECT 1 FROM public.workers w WHERE w.id=v_worker AND (strpos(lower(w.position),'supervisor')>0 OR EXISTS(SELECT 1 FROM public.users u WHERE u.role='supervisor' AND (u.id=w.id OR lower(btrim(u.name))=lower(btrim(w.name)))))) THEN
      RAISE EXCEPTION 'Possible Supervisor profile requires separate review' USING ERRCODE='22023'; END IF;
    IF EXISTS(SELECT 1 FROM public.payroll p WHERE p.worker_id=v_worker AND v_before.attendance_date BETWEEN p.period_start AND p.period_end AND p.status IN ('approved','paid')) THEN
      RAISE EXCEPTION 'Approved or paid payroll covers this date; review a separate correction' USING ERRCODE='22023'; END IF;
  END IF;
  UPDATE public.worker_allowances SET status=p_decision,reviewed_by=auth.uid(),reviewed_at=clock_timestamp() WHERE id=p_id;
  RETURN jsonb_build_object('id',p_id,'status',p_decision,'replayed',false);
END;
$$;
REVOKE ALL ON FUNCTION public.review_worker_allowance(uuid,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.review_worker_allowance(uuid,text) TO authenticated;

-- A bounded Founder review queue. An error is preferable to silently omitting requests.
CREATE FUNCTION public.worker_allowance_pending_queue()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $$
DECLARE v_result jsonb; v_count bigint;
BEGIN
  IF NOT coalesce(public.is_founder(),false) THEN RAISE EXCEPTION 'Founder access required' USING ERRCODE='42501'; END IF;
  SELECT count(*) INTO v_count FROM public.worker_allowances WHERE status='pending';
  IF v_count>500 THEN
    RAISE EXCEPTION 'Too many pending allowances; review with an administrator' USING ERRCODE='54000'; END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',x.id,'worker_name',w.name,'worker_position',w.position,'project_name',p.name,
      'date',x.attendance_date,'amount',x.amount::text,'description',x.description,'submitted_at',x.submitted_at,
      'stale',(x.worker_id,x.project_id,x.attendance_date,x.attendance_status,x.attendance_hours,x.attendance_submitted_at)
       IS DISTINCT FROM (a.worker_id,a.project_id,a.date,a.status,a.hours_worked,a.submitted_at),
      'finalized',EXISTS(SELECT 1 FROM public.payroll pay WHERE pay.worker_id=x.worker_id AND x.attendance_date BETWEEN pay.period_start AND pay.period_end AND pay.status IN ('approved','paid')))
    ORDER BY x.submitted_at,x.id),'[]'::jsonb) INTO v_result
  FROM public.worker_allowances x JOIN public.attendance a ON a.id=x.attendance_id
    JOIN public.workers w ON w.id=x.worker_id JOIN public.projects p ON p.id=x.project_id WHERE x.status='pending';
  IF jsonb_array_length(v_result)<>v_count THEN RAISE EXCEPTION 'Pending allowance scope incomplete' USING ERRCODE='42501'; END IF;
  IF octet_length(v_result::text)>1048576 THEN RAISE EXCEPTION 'Pending allowance queue is too large' USING ERRCODE='54000'; END IF;
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.worker_allowance_pending_queue() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.worker_allowance_pending_queue() TO authenticated;
