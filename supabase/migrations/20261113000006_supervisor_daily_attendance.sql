-- General Supervisor attendance is separate from project roll calls and the
-- legacy payroll generator. This migration does not backfill or alter history.
CREATE TABLE public.supervisor_daily_attendance (
  id uuid PRIMARY KEY,
  supervisor_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  work_date date NOT NULL,
  work_status text NOT NULL CHECK (work_status IN ('present','half_day','absent')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  submitted_at timestamptz NOT NULL,
  reviewed_by uuid REFERENCES public.users(id) ON DELETE RESTRICT,
  reviewed_at timestamptz,
  CHECK ((status='pending' AND reviewed_by IS NULL AND reviewed_at IS NULL) OR
         (status IN ('approved','rejected') AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL))
);
-- Rejected submissions remain history; a new submission may be made. A pending
-- or approved day is unique for the person, independent of site.
CREATE UNIQUE INDEX supervisor_daily_attendance_open_day ON public.supervisor_daily_attendance(supervisor_id,work_date) WHERE status IN ('pending','approved');
CREATE INDEX supervisor_daily_attendance_queue ON public.supervisor_daily_attendance(status,submitted_at DESC,id);
ALTER TABLE public.supervisor_daily_attendance ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.supervisor_daily_attendance FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.submit_supervisor_day(p_id uuid,p_date date,p_work_status text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_prev public.supervisor_daily_attendance%ROWTYPE; v_now timestamptz;
BEGIN
  IF auth.uid() IS NULL OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Supervisor access required' USING ERRCODE='42501'; END IF;
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Daily attendance requires read committed isolation' USING ERRCODE='P1002'; END IF;
  IF p_id IS NULL OR p_date IS NULL OR p_date<'1900-01-01'::date OR p_date>'9998-12-31'::date OR p_work_status IS NULL OR p_work_status NOT IN ('present','half_day','absent') THEN
    RAISE EXCEPTION 'Enter a valid date and attendance status' USING ERRCODE='22023'; END IF;
  PERFORM 1 FROM public.users WHERE id=auth.uid() AND role='supervisor' FOR UPDATE;
  IF NOT FOUND OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Supervisor access required' USING ERRCODE='42501'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('supervisor-day:'||p_id::text,0));
  SELECT * INTO v_prev FROM public.supervisor_daily_attendance WHERE id=p_id;
  IF FOUND THEN
    IF (v_prev.supervisor_id,v_prev.work_date,v_prev.work_status) IS DISTINCT FROM (auth.uid(),p_date,p_work_status) THEN
      RAISE EXCEPTION 'Request ID already used for different attendance' USING ERRCODE='22023'; END IF;
    RETURN jsonb_build_object('id',v_prev.id,'status',v_prev.status,'replayed',true);
  END IF;
  v_now:=clock_timestamp();
  IF p_date>(v_now AT TIME ZONE 'Asia/Manila')::date THEN RAISE EXCEPTION 'Cannot submit attendance for a future Manila date' USING ERRCODE='22023'; END IF;
  IF EXISTS (SELECT 1 FROM public.supervisor_daily_attendance d WHERE d.supervisor_id=auth.uid() AND d.work_date=p_date AND d.status IN ('pending','approved')) THEN
    RAISE EXCEPTION 'A pending or approved daily record already exists for this date' USING ERRCODE='22023'; END IF;
  INSERT INTO public.supervisor_daily_attendance(id,supervisor_id,work_date,work_status,submitted_at) VALUES(p_id,auth.uid(),p_date,p_work_status,v_now);
  RETURN jsonb_build_object('id',p_id,'status','pending','replayed',false);
END;
$$;
REVOKE ALL ON FUNCTION public.submit_supervisor_day(uuid,date,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.submit_supervisor_day(uuid,date,text) TO authenticated;

CREATE FUNCTION public.review_supervisor_day(p_id uuid,p_decision text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_owner uuid; v_day public.supervisor_daily_attendance%ROWTYPE;
BEGIN
  IF NOT coalesce(public.is_founder(),false) THEN RAISE EXCEPTION 'Founder access required' USING ERRCODE='42501'; END IF;
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Daily attendance review requires read committed isolation' USING ERRCODE='P1002'; END IF;
  IF p_decision IS NULL OR p_decision NOT IN ('approved','rejected') THEN RAISE EXCEPTION 'Invalid attendance decision' USING ERRCODE='22023'; END IF;
  PERFORM 1 FROM public.users WHERE id=auth.uid() AND role='founder' FOR SHARE;
  IF NOT FOUND OR NOT coalesce(public.is_founder(),false) THEN RAISE EXCEPTION 'Founder access required' USING ERRCODE='42501'; END IF;
  SELECT supervisor_id INTO v_owner FROM public.supervisor_daily_attendance WHERE id=p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Daily attendance not found' USING ERRCODE='P0002'; END IF;
  PERFORM 1 FROM public.users WHERE id=v_owner FOR UPDATE;
  SELECT * INTO v_day FROM public.supervisor_daily_attendance WHERE id=p_id FOR UPDATE;
  IF NOT FOUND OR v_day.supervisor_id<>v_owner THEN RAISE EXCEPTION 'Daily attendance changed; refresh' USING ERRCODE='40001'; END IF;
  IF v_day.status=p_decision THEN RETURN jsonb_build_object('id',v_day.id,'status',v_day.status,'replayed',true); END IF;
  IF v_day.status<>'pending' THEN RAISE EXCEPTION 'Daily attendance already decided; review the recorded decision' USING ERRCODE='22023'; END IF;
  IF p_decision='approved' AND EXISTS(SELECT 1 FROM public.supervisor_leave_requests l WHERE l.supervisor_id=v_owner AND l.status='approved' AND v_day.work_date BETWEEN l.start_date AND l.end_date) THEN
    RAISE EXCEPTION 'Approved leave covers this date; review the conflicting records' USING ERRCODE='22023'; END IF;
  UPDATE public.supervisor_daily_attendance SET status=p_decision,reviewed_by=auth.uid(),reviewed_at=clock_timestamp() WHERE id=p_id;
  RETURN jsonb_build_object('id',p_id,'status',p_decision,'replayed',false);
END;
$$;
REVOKE ALL ON FUNCTION public.review_supervisor_day(uuid,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.review_supervisor_day(uuid,text) TO authenticated;

-- The leave review path locks the same Supervisor user row before UPDATE.
-- Reject a conflicting approval in either direction; neither path rewrites the
-- other record. Privileged direct writes are outside the application protocol.
CREATE FUNCTION public.guard_leave_against_approved_supervisor_day()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status AND NEW.status='approved' AND EXISTS(
    SELECT 1 FROM public.supervisor_daily_attendance d WHERE d.supervisor_id=NEW.supervisor_id AND d.status='approved' AND d.work_date BETWEEN NEW.start_date AND NEW.end_date
  ) THEN RAISE EXCEPTION 'Approved daily attendance overlaps this leave; review the conflicting records' USING ERRCODE='22023'; END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_leave_against_approved_supervisor_day() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER guard_leave_against_approved_supervisor_day BEFORE UPDATE OF status ON public.supervisor_leave_requests
FOR EACH ROW EXECUTE FUNCTION public.guard_leave_against_approved_supervisor_day();

-- Site indicators show current assignments and whether any site attendance
-- records exist for that day; they are NOT proof that a full roll call was filed.
-- A maximum of 100 current sites per displayed Supervisor is enforced rather
-- than returning a silently truncated list. Paid/identity signals are Founder-only.
CREATE FUNCTION public.supervisor_day_list(p_offset integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_founder boolean; v_total bigint; v_items jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Attendance access required' USING ERRCODE='42501'; END IF;
  IF p_offset IS NULL OR p_offset<0 OR p_offset>1000000 THEN RAISE EXCEPTION 'Invalid attendance list offset' USING ERRCODE='22023'; END IF;
  v_founder:=coalesce(public.is_founder(),false);
  IF NOT v_founder AND NOT EXISTS(SELECT 1 FROM public.users WHERE id=auth.uid() AND role='supervisor') THEN RAISE EXCEPTION 'Attendance access required' USING ERRCODE='42501'; END IF;
  SELECT count(*) INTO v_total FROM public.supervisor_daily_attendance d WHERE v_founder OR d.supervisor_id=auth.uid();
  IF EXISTS(SELECT 1 FROM (SELECT d.supervisor_id FROM public.supervisor_daily_attendance d WHERE v_founder OR d.supervisor_id=auth.uid() GROUP BY d.supervisor_id) q
    WHERE (SELECT count(*) FROM public.project_supervisors ps WHERE ps.supervisor_id=q.supervisor_id)>100) THEN
    RAISE EXCEPTION 'Too many current project assignments for the attendance view' USING ERRCODE='54000'; END IF;
  SELECT coalesce(jsonb_agg(x.item ORDER BY x.priority,x.submitted_at DESC,x.id),'[]'::jsonb) INTO v_items FROM (
    SELECT d.id,d.submitted_at,CASE WHEN d.status='pending' THEN 0 ELSE 1 END AS priority,
      jsonb_build_object('id',d.id,'supervisor_name',u.name,'work_date',d.work_date,'work_status',d.work_status,'status',d.status,'submitted_at',d.submitted_at,'reviewed_at',d.reviewed_at,
        'approved_leave',EXISTS(SELECT 1 FROM public.supervisor_leave_requests l WHERE l.supervisor_id=d.supervisor_id AND l.status='approved' AND d.work_date BETWEEN l.start_date AND l.end_date),
        'pending_leave',EXISTS(SELECT 1 FROM public.supervisor_leave_requests l WHERE l.supervisor_id=d.supervisor_id AND l.status='pending' AND d.work_date BETWEEN l.start_date AND l.end_date),
        'legacy_self_records',CASE WHEN v_founder THEN (SELECT count(*) FROM public.attendance a WHERE a.worker_id=d.supervisor_id AND a.date=d.work_date) ELSE NULL END,
        'possible_paid_overlap',CASE WHEN v_founder THEN EXISTS(SELECT 1 FROM public.workers w JOIN public.payroll p ON p.worker_id=w.id
          WHERE (w.id=u.id OR lower(btrim(w.name))=lower(btrim(u.name))) AND p.status='paid' AND d.work_date BETWEEN p.period_start AND p.period_end) ELSE NULL END,
        'identity_needs_review',CASE WHEN v_founder THEN NOT EXISTS(SELECT 1 FROM public.workers w WHERE w.id=u.id)
          OR EXISTS(SELECT 1 FROM public.workers w WHERE w.id<>u.id AND lower(btrim(w.name))=lower(btrim(u.name))) ELSE NULL END,
        'sites',coalesce((SELECT jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'has_entries',EXISTS(SELECT 1 FROM public.attendance a WHERE a.project_id=p.id AND a.date=d.work_date)) ORDER BY p.name,p.id)
          FROM public.project_supervisors ps JOIN public.projects p ON p.id=ps.project_id WHERE ps.supervisor_id=d.supervisor_id),'[]'::jsonb)) AS item
    FROM public.supervisor_daily_attendance d JOIN public.users u ON u.id=d.supervisor_id
    WHERE v_founder OR d.supervisor_id=auth.uid()
    ORDER BY priority,d.submitted_at DESC,d.id LIMIT 100 OFFSET p_offset
  ) x;
  RETURN jsonb_build_object('total',v_total,'offset',p_offset,'items',v_items);
END;
$$;
REVOKE ALL ON FUNCTION public.supervisor_day_list(integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.supervisor_day_list(integer) TO authenticated;
