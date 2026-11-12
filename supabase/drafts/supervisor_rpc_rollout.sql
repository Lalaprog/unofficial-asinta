-- Guarded Supervisor functions for the already-installed locked tables.
-- NOT APPROVED FOR HOSTED DEPLOYMENT: see docs/PR103_SCHEMA_REHEARSAL.md.
-- Not a complete payroll feature; review the target and recovery plan first.
-- This candidate requires ONE surrounding transaction for all statements.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = public, pg_catalog;
DO $preflight$
DECLARE v_name text; v_expected text; v_hash text; v_signature text; v_missing text;
BEGIN
 IF to_regprocedure('auth.uid()') IS NULL OR to_regprocedure('public.is_founder()') IS NULL OR to_regprocedure('public.session_assurance_satisfied()') IS NULL OR to_regclass('public.users') IS NULL OR to_regclass('public.attendance') IS NULL OR to_regclass('public.projects') IS NULL OR to_regclass('public.project_supervisors') IS NULL OR to_regclass('public.workers') IS NULL OR to_regclass('public.payroll') IS NULL THEN RAISE EXCEPTION 'Supervisor prerequisite missing'; END IF;
 -- Block writes to both tables until the surrounding transaction ends, so the
 -- empty-table and trigger checks cannot race a privileged business write.
 LOCK TABLE public.supervisor_daily_attendance, public.supervisor_leave_requests IN SHARE MODE;
 SELECT string_agg(required.rel || '.' || required.col, ', ' ORDER BY required.rel, required.col) INTO v_missing
 FROM (VALUES ('users','id','uuid'),('users','name','text'),('users','role','text'),
   ('workers','id','uuid'),('workers','name','text'),('projects','id','uuid'),('projects','name','text'),
   ('project_supervisors','project_id','uuid'),('project_supervisors','supervisor_id','uuid'),
   ('attendance','worker_id','uuid'),('attendance','project_id','uuid'),('attendance','date','date'),
   ('payroll','worker_id','uuid'),('payroll','status','text'),('payroll','period_start','date'),('payroll','period_end','date')) AS required(rel,col,typ)
 LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=pg_catalog.to_regclass('public.'||required.rel)
   AND a.attname=required.col AND a.attnum>0 AND NOT a.attisdropped
 WHERE a.attname IS NULL OR pg_catalog.format_type(a.atttypid,a.atttypmod) IS DISTINCT FROM required.typ;
 IF v_missing IS NOT NULL THEN RAISE EXCEPTION 'Supervisor prerequisite columns missing or different: %',v_missing; END IF;
 FOREACH v_signature IN ARRAY ARRAY['app_private.normal_leave_notice_allowed(date,timestamptz)','public.submit_supervisor_leave(uuid,date,date,text,text)','public.review_supervisor_leave(uuid,text)','public.supervisor_leave_list(integer)','public.submit_supervisor_day(uuid,date,text)','public.review_supervisor_day(uuid,text)','public.guard_leave_against_approved_supervisor_day()','public.supervisor_day_list(integer)'] LOOP
  IF to_regprocedure(v_signature) IS NOT NULL THEN RAISE EXCEPTION 'Supervisor function already exists: %',v_signature; END IF;
 END LOOP;
 FOREACH v_name IN ARRAY ARRAY['supervisor_daily_attendance','supervisor_leave_requests'] LOOP
  v_expected:=CASE v_name WHEN 'supervisor_daily_attendance' THEN '70e3d6ee56b130b897505c5c19843b2d' ELSE '9739b77d0441a9714d982ee4ece68fdd' END;
  SELECT md5((jsonb_build_object('columns',(SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
   'constraints',(SELECT jsonb_agg(jsonb_build_array(con.conname,con.contype,pg_get_constraintdef(con.oid)) ORDER BY con.conname) FROM pg_constraint con WHERE con.conrelid=c.oid),
   'indexes',(SELECT jsonb_agg(jsonb_build_array(i.relname,pg_get_indexdef(i.oid)) ORDER BY i.relname) FROM pg_index ix JOIN pg_class i ON i.oid=ix.indexrelid WHERE ix.indrelid=c.oid)))::text) INTO v_hash
   FROM pg_class c WHERE c.oid=pg_catalog.to_regclass('public.'||v_name) AND c.relkind='r' AND c.relrowsecurity;
  IF v_hash IS DISTINCT FROM v_expected THEN RAISE EXCEPTION 'Locked Supervisor table missing or different: %',v_name; END IF;
  IF pg_catalog.has_table_privilege('anon','public.'||v_name,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR pg_catalog.has_table_privilege('authenticated','public.'||v_name,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN
   RAISE EXCEPTION 'Unexpected client privileges on locked Supervisor table %',v_name; END IF;
  IF EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=pg_catalog.to_regclass('public.'||v_name) AND NOT t.tgisinternal) THEN
   RAISE EXCEPTION 'Unexpected trigger on locked Supervisor table %',v_name; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM public.supervisor_leave_requests) OR EXISTS(SELECT 1 FROM public.supervisor_daily_attendance) THEN
  RAISE EXCEPTION 'Locked Supervisor tables contain data; reconcile before proceeding'; END IF;
END;
$preflight$;

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

DO $postflight$
DECLARE v_signature text; v_proc regprocedure;
BEGIN
 FOREACH v_signature IN ARRAY ARRAY['public.submit_supervisor_leave(uuid,date,date,text,text)','public.review_supervisor_leave(uuid,text)','public.supervisor_leave_list(integer)','public.submit_supervisor_day(uuid,date,text)','public.review_supervisor_day(uuid,text)','public.supervisor_day_list(integer)'] LOOP
  v_proc:=to_regprocedure(v_signature);
  IF v_proc IS NULL OR has_function_privilege('anon',v_proc,'EXECUTE') OR NOT has_function_privilege('authenticated',v_proc,'EXECUTE') OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=v_proc AND p.prosecdef AND p.proconfig @> ARRAY['search_path=""']) THEN
   RAISE EXCEPTION 'Unexpected Supervisor function security: %',v_signature; END IF;
 END LOOP;
 FOREACH v_signature IN ARRAY ARRAY['app_private.normal_leave_notice_allowed(date,timestamptz)','public.guard_leave_against_approved_supervisor_day()'] LOOP
  v_proc:=to_regprocedure(v_signature);
  IF v_proc IS NULL OR has_function_privilege('anon',v_proc,'EXECUTE') OR has_function_privilege('authenticated',v_proc,'EXECUTE') THEN
   RAISE EXCEPTION 'Unexpected internal Supervisor function privileges: %',v_signature; END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid='public.supervisor_leave_requests'::regclass AND t.tgname='guard_leave_against_approved_supervisor_day' AND t.tgfoid=to_regprocedure('public.guard_leave_against_approved_supervisor_day()') AND NOT t.tgisinternal AND t.tgenabled='O') THEN RAISE EXCEPTION 'Supervisor conflict guard missing or disabled'; END IF;
 IF has_table_privilege('anon','public.supervisor_leave_requests','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_table_privilege('authenticated','public.supervisor_leave_requests','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_table_privilege('anon','public.supervisor_daily_attendance','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_table_privilege('authenticated','public.supervisor_daily_attendance','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN RAISE EXCEPTION 'Unexpected direct table privileges'; END IF;
END;
$postflight$;
