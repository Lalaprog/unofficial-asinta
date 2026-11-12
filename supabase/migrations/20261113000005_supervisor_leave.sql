-- Supervisor leave requests only. No attendance, voucher, payment or legacy
-- records are created or changed; payroll integration requires a later cutover.
CREATE TABLE public.supervisor_leave_requests (
  id uuid PRIMARY KEY,
  supervisor_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  start_date date NOT NULL,
  end_date date NOT NULL,
  kind text NOT NULL CHECK (kind IN ('normal','emergency')),
  reason text NOT NULL CHECK (length(reason)<=500),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  submitted_at timestamptz NOT NULL,
  reviewed_by uuid REFERENCES public.users(id) ON DELETE RESTRICT,
  reviewed_at timestamptz,
  CHECK (end_date>=start_date AND end_date-start_date<=366),
  CHECK ((status='pending' AND reviewed_by IS NULL AND reviewed_at IS NULL) OR
         (status IN ('approved','rejected') AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL))
);
CREATE INDEX supervisor_leave_owner_dates_idx ON public.supervisor_leave_requests(supervisor_id,start_date,end_date);
CREATE INDEX supervisor_leave_queue_idx ON public.supervisor_leave_requests(status,submitted_at DESC,id);
ALTER TABLE public.supervisor_leave_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.supervisor_leave_requests FROM PUBLIC,anon,authenticated;

-- Isolated for timezone-boundary tests; submission supplies the database clock,
-- never a caller-supplied timestamp.
CREATE FUNCTION app_private.normal_leave_notice_allowed(p_start date,p_now timestamptz)
RETURNS boolean LANGUAGE sql STABLE SET search_path='' AS $$
  SELECT p_start >= (p_now AT TIME ZONE 'Asia/Manila')::date + 2
$$;
REVOKE ALL ON FUNCTION app_private.normal_leave_notice_allowed(date,timestamptz) FROM PUBLIC,anon,authenticated;

-- The Supervisor row lock serializes retries, overlapping submissions and
-- decisions for that person. Keys are client-generated, scoped to the actor,
-- and exact replays remain valid after the notice deadline or a later decision.
CREATE FUNCTION public.submit_supervisor_leave(p_id uuid,p_start date,p_end date,p_kind text,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_prev public.supervisor_leave_requests%ROWTYPE; v_now timestamptz; v_reason text;
BEGIN
  IF auth.uid() IS NULL OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Supervisor access required' USING ERRCODE='42501'; END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN RAISE EXCEPTION 'Leave submission requires read committed isolation' USING ERRCODE='P1002'; END IF;
  IF p_id IS NULL OR p_start IS NULL OR p_end IS NULL OR p_kind IS NULL OR p_kind NOT IN ('normal','emergency') OR p_reason IS NULL
    OR p_start<'1900-01-01'::date OR p_end>'9998-12-31'::date OR p_end<p_start OR p_end-p_start>366 OR length(btrim(p_reason))>500 THEN
    RAISE EXCEPTION 'Enter a valid leave date range and reason' USING ERRCODE='22023'; END IF;
  v_reason:=btrim(p_reason);
  PERFORM 1 FROM public.users WHERE id=auth.uid() AND role='supervisor' FOR UPDATE;
  IF NOT FOUND OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Supervisor access required' USING ERRCODE='42501'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('supervisor-leave:'||p_id::text,0));
  SELECT * INTO v_prev FROM public.supervisor_leave_requests WHERE id=p_id;
  IF FOUND THEN
    IF (v_prev.supervisor_id,v_prev.start_date,v_prev.end_date,v_prev.kind,v_prev.reason) IS DISTINCT FROM (auth.uid(),p_start,p_end,p_kind,v_reason) THEN
      RAISE EXCEPTION 'Request ID already used for different leave' USING ERRCODE='22023'; END IF;
    RETURN jsonb_build_object('id',v_prev.id,'status',v_prev.status,'replayed',true);
  END IF;
  v_now:=clock_timestamp();
  IF p_kind='normal' AND NOT app_private.normal_leave_notice_allowed(p_start,v_now) THEN
    RAISE EXCEPTION 'Normal leave requires at least two calendar days notice in Manila time' USING ERRCODE='22023'; END IF;
  IF EXISTS (SELECT 1 FROM public.supervisor_leave_requests l WHERE l.supervisor_id=auth.uid() AND l.status IN ('pending','approved') AND l.start_date<=p_end AND l.end_date>=p_start) THEN
    RAISE EXCEPTION 'A pending or approved leave request overlaps these dates; review the existing request' USING ERRCODE='22023'; END IF;
  INSERT INTO public.supervisor_leave_requests(id,supervisor_id,start_date,end_date,kind,reason,submitted_at)
  VALUES(p_id,auth.uid(),p_start,p_end,p_kind,v_reason,v_now);
  RETURN jsonb_build_object('id',p_id,'status','pending','replayed',false);
END;
$$;
REVOKE ALL ON FUNCTION public.submit_supervisor_leave(uuid,date,date,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.submit_supervisor_leave(uuid,date,date,text,text) TO authenticated;

-- Founder approval is recorded as unpaid leave for future integration only.
-- It never changes paid or approved vouchers or existing site attendance.
CREATE FUNCTION public.review_supervisor_leave(p_id uuid,p_decision text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_owner uuid; v_row public.supervisor_leave_requests%ROWTYPE;
BEGIN
  IF NOT coalesce(public.is_founder(),false) THEN RAISE EXCEPTION 'Founder access required' USING ERRCODE='42501'; END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN RAISE EXCEPTION 'Leave review requires read committed isolation' USING ERRCODE='P1002'; END IF;
  IF p_decision IS NULL OR p_decision NOT IN ('approved','rejected') THEN RAISE EXCEPTION 'Invalid leave decision' USING ERRCODE='22023'; END IF;
  PERFORM 1 FROM public.users WHERE id=auth.uid() AND role='founder' FOR SHARE;
  IF NOT FOUND OR NOT coalesce(public.is_founder(),false) THEN RAISE EXCEPTION 'Founder access required' USING ERRCODE='42501'; END IF;
  SELECT supervisor_id INTO v_owner FROM public.supervisor_leave_requests WHERE id=p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Leave request not found' USING ERRCODE='P0002'; END IF;
  PERFORM 1 FROM public.users WHERE id=v_owner FOR UPDATE;
  SELECT * INTO v_row FROM public.supervisor_leave_requests WHERE id=p_id FOR UPDATE;
  IF NOT FOUND OR v_row.supervisor_id<>v_owner THEN RAISE EXCEPTION 'Leave request changed; refresh' USING ERRCODE='40001'; END IF;
  IF v_row.status=p_decision THEN RETURN jsonb_build_object('id',v_row.id,'status',v_row.status,'replayed',true); END IF;
  IF v_row.status<>'pending' THEN RAISE EXCEPTION 'Leave request already decided; review the recorded decision' USING ERRCODE='22023'; END IF;
  IF p_decision='approved' AND EXISTS(SELECT 1 FROM public.supervisor_leave_requests l WHERE l.id<>p_id AND l.supervisor_id=v_owner AND l.status='approved' AND l.start_date<=v_row.end_date AND l.end_date>=v_row.start_date) THEN
    RAISE EXCEPTION 'Another approved leave overlaps these dates' USING ERRCODE='22023'; END IF;
  UPDATE public.supervisor_leave_requests SET status=p_decision,reviewed_by=auth.uid(),reviewed_at=clock_timestamp() WHERE id=p_id;
  RETURN jsonb_build_object('id',p_id,'status',p_decision,'replayed',false);
END;
$$;
REVOKE ALL ON FUNCTION public.review_supervisor_leave(uuid,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.review_supervisor_leave(uuid,text) TO authenticated;

-- At most 100 rows, with a truthful total. A possible paid-voucher overlap is
-- visible to the Founder only, and same-name matches are deliberately treated
-- as ambiguous rather than silently identifying or modifying paid history.
CREATE FUNCTION public.supervisor_leave_list(p_offset integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_founder boolean; v_total bigint; v_items jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Leave access required' USING ERRCODE='42501'; END IF;
  IF p_offset IS NULL OR p_offset<0 OR p_offset>1000000 THEN RAISE EXCEPTION 'Invalid leave list offset' USING ERRCODE='22023'; END IF;
  v_founder:=coalesce(public.is_founder(),false);
  IF NOT v_founder AND NOT EXISTS(SELECT 1 FROM public.users WHERE id=auth.uid() AND role='supervisor') THEN RAISE EXCEPTION 'Leave access required' USING ERRCODE='42501'; END IF;
  SELECT count(*) INTO v_total FROM public.supervisor_leave_requests l WHERE v_founder OR l.supervisor_id=auth.uid();
  SELECT coalesce(jsonb_agg(x.item ORDER BY x.priority,x.submitted_at DESC,x.id),'[]'::jsonb) INTO v_items FROM (
    SELECT l.id,l.submitted_at,CASE WHEN l.status='pending' THEN 0 ELSE 1 END AS priority,
      jsonb_build_object('id',l.id,'supervisor_name',u.name,'start_date',l.start_date,'end_date',l.end_date,'kind',l.kind,'reason',l.reason,'status',l.status,'submitted_at',l.submitted_at,
        'reviewed_at',l.reviewed_at,
        'possible_paid_overlap',CASE WHEN v_founder THEN EXISTS(SELECT 1 FROM public.workers w JOIN public.payroll p ON p.worker_id=w.id
          WHERE (w.id=u.id OR lower(btrim(w.name))=lower(btrim(u.name))) AND p.status='paid' AND p.period_start<=l.end_date AND p.period_end>=l.start_date) ELSE NULL END,
        'identity_needs_review',CASE WHEN v_founder THEN NOT EXISTS(SELECT 1 FROM public.workers w WHERE w.id=u.id)
          OR EXISTS(SELECT 1 FROM public.workers w WHERE w.id<>u.id AND lower(btrim(w.name))=lower(btrim(u.name))) ELSE NULL END) AS item
    FROM public.supervisor_leave_requests l JOIN public.users u ON u.id=l.supervisor_id
    WHERE v_founder OR l.supervisor_id=auth.uid()
    ORDER BY priority,l.submitted_at DESC,l.id LIMIT 100 OFFSET p_offset
  ) x;
  RETURN jsonb_build_object('total',v_total,'offset',p_offset,'items',v_items);
END;
$$;
REVOKE ALL ON FUNCTION public.supervisor_leave_list(integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.supervisor_leave_list(integer) TO authenticated;
