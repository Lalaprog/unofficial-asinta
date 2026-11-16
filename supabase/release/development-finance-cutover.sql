-- Development cutover candidate: run all statements in ONE managed transaction.
-- No test-only data is created; this is not the rollback-only rehearsal bundle.
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
-- Take all business locks before the empty-development check. This blocks new
-- writes until commit; it is not a guarantee against privileged trigger bypass.
LOCK TABLE public.advances,public.advance_requests,public.payroll,public.attendance,public.workers,public.projects,public.project_worker_assignments,public.project_supervisors,public.supervisor_daily_attendance,public.supervisor_leave_requests,public.tools,public.expenses IN SHARE ROW EXCLUSIVE MODE;
DO $staged_preflight$
DECLARE f regprocedure;
BEGIN
 IF current_database()<>'postgres' AND NOT (current_database() LIKE 'asinta\_test\_%' ESCAPE '\' AND to_regclass('app_private.synthetic_finance_rehearsal_marker') IS NOT NULL) THEN RAISE EXCEPTION 'Unexpected database'; END IF;
 IF EXISTS(SELECT 1 FROM public.workers) OR EXISTS(SELECT 1 FROM public.projects) OR EXISTS(SELECT 1 FROM public.attendance) OR EXISTS(SELECT 1 FROM public.payroll) OR EXISTS(SELECT 1 FROM public.advances) OR EXISTS(SELECT 1 FROM public.advance_requests) OR EXISTS(SELECT 1 FROM public.project_worker_assignments) OR EXISTS(SELECT 1 FROM public.project_supervisors) OR EXISTS(SELECT 1 FROM public.supervisor_daily_attendance) OR EXISTS(SELECT 1 FROM public.supervisor_leave_requests) OR EXISTS(SELECT 1 FROM public.tools) OR EXISTS(SELECT 1 FROM public.expenses) THEN RAISE EXCEPTION 'Development business records exist; reconcile before cutover'; END IF;
 IF to_regclass('public.attendance_time_details') IS NULL OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.attendance_time_details'::regclass) OR EXISTS(SELECT 1 FROM public.attendance_time_details) THEN RAISE EXCEPTION 'Expected empty staged time detail table required'; END IF;
 f:=to_regprocedure('public.record_attendance_time_detail(uuid,uuid,timestamptz,numeric,numeric,text)');
 IF f IS NULL OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=f AND prosecdef AND md5(prosrc)='9e005a393f9295f31e5724906b46b08e') OR EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r(role_name) WHERE has_function_privilege(r.role_name,f,'EXECUTE')) THEN RAISE EXCEPTION 'Staged time writer changed or enabled'; END IF;
 f:=to_regprocedure('public.weekly_worker_preview_inputs(date)');
 IF f IS NULL OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=f AND NOT prosecdef AND md5(prosrc)='c8c1bd7f427fddce5f3ddd3167b1482c') OR has_function_privilege('anon',f,'EXECUTE') OR NOT has_function_privilege('authenticated',f,'EXECUTE') THEN RAISE EXCEPTION 'Staged weekly preview changed'; END IF;
 f:=to_regprocedure('public.weekly_worker_preview_base_inputs(date)');
 IF f IS NULL OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=f AND NOT prosecdef AND md5(prosrc)='e94e19cb53dbeb677bf02b24dd43cb13') OR to_regprocedure('public.weekly_worker_time_preview_inputs(date)') IS NOT NULL THEN RAISE EXCEPTION 'Weekly base changed'; END IF;
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r(role_name) WHERE has_table_privilege(r.role_name,'public.attendance_time_details','INSERT,UPDATE,DELETE,TRUNCATE') OR has_sequence_privilege(r.role_name,pg_get_serial_sequence('public.attendance_time_details','revision_id'),'USAGE,SELECT,UPDATE')) THEN RAISE EXCEPTION 'Staged time detail write access changed'; END IF;
END $staged_preflight$;

-- supabase/migrations/20261113000002_worker_allowances.sql sha256 718f8fa639104ce60683806e211716cb1fdca7ead316353288a0a13f6fc696d4
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


-- supabase/migrations/20261113000003_weekly_payroll_context.sql sha256 064d7bc51677d9e2acb87ed770676f76405e8cd17ecebce8af9c910961139251
-- Bounded, Founder-only read context for the planning preview. The source
-- records remain unchanged; a linked request is evidence, not proof of payment.
ALTER FUNCTION public.weekly_worker_preview_inputs(date) RENAME TO weekly_worker_time_preview_inputs;
CREATE FUNCTION public.weekly_worker_preview_inputs(p_start date)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $$
DECLARE v_base jsonb; v_workers jsonb; v_vouchers jsonb; v_allowances jsonb; v_advances jsonb; v_older jsonb; v_result jsonb; v_count bigint;
BEGIN
  -- Existing function enforces Founder, valid Sunday, limits and caller RLS.
  v_base:=public.weekly_worker_time_preview_inputs(p_start);
  SELECT count(*) INTO v_count FROM public.worker_allowances WHERE attendance_date BETWEEN p_start AND p_start+6;
  IF v_count>10000 THEN RAISE EXCEPTION 'Too many worker allowances for this preview' USING ERRCODE='54000'; END IF;
  SELECT count(*) INTO v_count FROM public.advances WHERE date BETWEEN p_start AND p_start+6;
  IF v_count>10000 THEN RAISE EXCEPTION 'Too many Bale records for this preview' USING ERRCODE='54000'; END IF;
  SELECT count(*) INTO v_count FROM public.advances WHERE date<p_start AND status IN ('active','partially_deducted');
  IF v_count>10000 THEN RAISE EXCEPTION 'Too many older Bale records for this preview' USING ERRCODE='54000'; END IF;
  SELECT count(*) INTO v_count FROM public.payroll WHERE period_start<=p_start+6 AND period_end>=p_start;
  IF v_count>10000 THEN RAISE EXCEPTION 'Too many overlapping vouchers for this preview' USING ERRCODE='54000'; END IF;

  WITH existing AS MATERIALIZED (SELECT x.value AS w FROM jsonb_array_elements(v_base->'workers') AS x),
  missing AS MATERIALIZED (
    SELECT w.id,w.name,w.position,w.active,w.pay_rate::text AS pay_rate,w.pay_rate_type,
      EXISTS(SELECT 1 FROM public.users u WHERE u.id=w.id AND u.role='supervisor') AS linked_supervisor,
      (strpos(lower(coalesce(w.position,'')),'supervisor')>0 OR EXISTS(SELECT 1 FROM public.users u WHERE u.role='supervisor' AND lower(btrim(u.name))=lower(btrim(w.name)))) AS possible_supervisor
    FROM public.workers w WHERE NOT EXISTS(SELECT 1 FROM existing e WHERE e.w->>'id'=w.id::text)
      AND (EXISTS(SELECT 1 FROM public.worker_allowances a WHERE a.worker_id=w.id AND a.attendance_date BETWEEN p_start AND p_start+6)
        OR EXISTS(SELECT 1 FROM public.advances a WHERE a.worker_id=w.id AND (a.date BETWEEN p_start AND p_start+6 OR (a.date<p_start AND a.status IN ('active','partially_deducted'))))
        OR EXISTS(SELECT 1 FROM public.payroll p WHERE p.worker_id=w.id AND p.period_start<=p_start+6 AND p.period_end>=p_start))
  ), all_workers AS (
    SELECT e.w AS value FROM existing e UNION ALL SELECT to_jsonb(m) FROM missing m
  ) SELECT coalesce(jsonb_agg(value ORDER BY value->>'name',value->>'id'),'[]'::jsonb) INTO v_workers FROM all_workers;
  IF jsonb_array_length(v_workers)>2000 THEN RAISE EXCEPTION 'Too many workers for this preview' USING ERRCODE='54000'; END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',p.id,'worker_id',p.worker_id,'status',p.status,'period_start',p.period_start,'period_end',p.period_end) ORDER BY p.id),'[]'::jsonb)
    INTO v_vouchers FROM public.payroll p WHERE p.period_start<=p_start+6 AND p.period_end>=p_start;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',w.id,'worker_id',w.worker_id,'project_id',w.project_id,'description',w.description,'amount',w.amount::text,'status',w.status,'date',w.attendance_date,
    'stale',(w.worker_id,w.project_id,w.attendance_date,w.attendance_status,w.attendance_hours,w.attendance_submitted_at)
      IS DISTINCT FROM (a.worker_id,a.project_id,a.date,a.status,a.hours_worked,a.submitted_at)) ORDER BY w.id),'[]'::jsonb)
    INTO v_allowances FROM public.worker_allowances w JOIN public.attendance a ON a.id=w.attendance_id
    WHERE w.attendance_date BETWEEN p_start AND p_start+6;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',a.id,'worker_id',a.worker_id,'project_id',a.project_id,'date',a.date,'amount',a.amount::text,
    'deducted',a.amount_deducted::text,'status',a.status,
    'linked_release',coalesce(r.status='issued' AND r.worker_id=a.worker_id AND r.project_id=a.project_id
      AND r.requested_amount=a.amount AND (r.issued_at AT TIME ZONE 'Asia/Manila')::date=a.date,false)) ORDER BY a.date,a.id),'[]'::jsonb)
    INTO v_advances FROM public.advances a LEFT JOIN public.advance_requests r ON r.issued_advance_id=a.id
    WHERE a.date BETWEEN p_start AND p_start+6;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',a.id,'worker_id',a.worker_id,'amount',a.amount::text,'deducted',a.amount_deducted::text,'status',a.status) ORDER BY a.date,a.id),'[]'::jsonb)
    INTO v_older FROM public.advances a WHERE a.date<p_start AND a.status IN ('active','partially_deducted');
  IF jsonb_array_length(v_allowances)<>(SELECT count(*) FROM public.worker_allowances WHERE attendance_date BETWEEN p_start AND p_start+6)
    OR jsonb_array_length(v_advances)<>(SELECT count(*) FROM public.advances WHERE date BETWEEN p_start AND p_start+6) THEN
    RAISE EXCEPTION 'Weekly financial context is incomplete' USING ERRCODE='42501'; END IF;
  v_result:=v_base || jsonb_build_object('workers',v_workers,'vouchers',v_vouchers,'allowances',v_allowances,'advances',v_advances,'older_advances',v_older);
  IF octet_length(v_result::text)>8388608 THEN RAISE EXCEPTION 'Weekly preview response too large' USING ERRCODE='54000'; END IF;
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.weekly_worker_preview_inputs(date) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.weekly_worker_preview_inputs(date) TO authenticated;


-- supabase/drafts/supervisor_rpc_rollout.sql sha256 e72c95f5092c6f479bd2db98a4f6beaf2f8290409b281fdcfe3172b3a23f4585
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


-- supabase/drafts/supervisor_day_founder_backfill.sql sha256 cb94acdf29a5ae2c99e670bfa708138e354e4f32d3019676765472de03fd4935
-- Coordinated Supervisor daily-attendance cutover component. Not installed.
-- A Founder may record a historical daily assertion for a current Supervisor;
-- it starts pending and must be reviewed separately. No payroll is changed.
-- Existing site attendance, paid periods and external evidence need review.
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
DO $preflight$
BEGIN
 IF to_regclass('public.supervisor_daily_attendance') IS NULL OR to_regclass('public.users') IS NULL
 OR to_regprocedure('public.submit_supervisor_day(uuid,date,text)') IS NULL
 OR to_regprocedure('public.review_supervisor_day(uuid,text)') IS NULL
 OR to_regprocedure('public.is_founder()') IS NULL OR to_regprocedure('public.session_assurance_satisfied()') IS NULL THEN
  RAISE EXCEPTION 'Supervisor backfill prerequisites missing'; END IF;
 IF to_regclass('public.supervisor_day_founder_backfills') IS NOT NULL OR to_regprocedure('public.record_supervisor_day_backfill(uuid,uuid,date,text,text)') IS NOT NULL OR to_regprocedure('public.supervisor_day_backfill_lookup(uuid)') IS NOT NULL OR to_regprocedure('public.supervisor_day_backfill_catalog()') IS NOT NULL THEN RAISE EXCEPTION 'Supervisor backfill already exists'; END IF;
END;
$preflight$;
CREATE TABLE public.supervisor_day_founder_backfills(
 day_id uuid PRIMARY KEY REFERENCES public.supervisor_daily_attendance(id) ON DELETE RESTRICT,
 founder_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 300 AND reason=btrim(reason)),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.supervisor_day_founder_backfills ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.supervisor_day_founder_backfills FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.guard_supervisor_day_backfill_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN RAISE EXCEPTION 'Supervisor backfill evidence is immutable' USING ERRCODE='22023'; END;
$$;
REVOKE ALL ON FUNCTION public.guard_supervisor_day_backfill_immutable() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER guard_supervisor_day_backfill_immutable BEFORE UPDATE OR DELETE ON public.supervisor_day_founder_backfills FOR EACH ROW EXECUTE FUNCTION public.guard_supervisor_day_backfill_immutable();
CREATE FUNCTION public.supervisor_day_backfill_catalog() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_items jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access required' USING ERRCODE='42501'; END IF;
 IF (SELECT count(*) FROM public.users WHERE role='supervisor')>2000 THEN RAISE EXCEPTION 'Supervisor catalog too large' USING ERRCODE='54000'; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name) ORDER BY name,id),'[]'::jsonb) INTO v_items FROM public.users WHERE role='supervisor';
 RETURN jsonb_build_object('supervisors',v_items);
END;
$$;
CREATE FUNCTION public.record_supervisor_day_backfill(p_id uuid,p_supervisor uuid,p_date date,p_work_status text,p_reason text) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid:=auth.uid();v_prev public.supervisor_daily_attendance%ROWTYPE;v_evidence public.supervisor_day_founder_backfills%ROWTYPE;v_now timestamptz;
BEGIN
 IF v_actor IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access required' USING ERRCODE='42501'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Daily attendance requires read committed' USING ERRCODE='P1002'; END IF;
 IF p_id IS NULL OR p_supervisor IS NULL OR p_date IS NULL OR NOT isfinite(p_date) OR p_date<DATE '1900-01-01' OR p_date>DATE '9998-12-31' OR p_work_status IS NULL OR p_work_status NOT IN ('present','half_day','absent') OR p_reason IS NULL OR p_reason<>btrim(p_reason) OR length(p_reason) NOT BETWEEN 1 AND 300 OR p_reason ~ '[[:cntrl:]]' THEN RAISE EXCEPTION 'Invalid backfill' USING ERRCODE='22023'; END IF;
 PERFORM 1 FROM public.users WHERE id=v_actor AND role='founder' FOR SHARE;
 IF NOT FOUND OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access required' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM public.users WHERE id=p_supervisor AND role='supervisor' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Supervisor unavailable' USING ERRCODE='22023'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('supervisor-day:'||p_id::text,0));
 SELECT * INTO v_prev FROM public.supervisor_daily_attendance WHERE id=p_id;
 IF FOUND THEN
  SELECT * INTO v_evidence FROM public.supervisor_day_founder_backfills WHERE day_id=p_id;
  IF NOT FOUND OR (v_prev.supervisor_id,v_prev.work_date,v_prev.work_status,v_evidence.founder_id,v_evidence.reason) IS DISTINCT FROM (p_supervisor,p_date,p_work_status,v_actor,p_reason) THEN RAISE EXCEPTION 'Request ID used for different attendance' USING ERRCODE='22023'; END IF;
  RETURN jsonb_build_object('id',p_id,'status',v_prev.status,'replayed',true);
 END IF;
 v_now:=clock_timestamp();
 IF p_date>(v_now AT TIME ZONE 'Asia/Manila')::date THEN RAISE EXCEPTION 'Cannot backfill a future Manila date' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM public.supervisor_daily_attendance WHERE supervisor_id=p_supervisor AND work_date=p_date AND status IN ('pending','approved')) THEN RAISE EXCEPTION 'A pending or approved daily record already exists' USING ERRCODE='22023'; END IF;
 INSERT INTO public.supervisor_daily_attendance(id,supervisor_id,work_date,work_status,submitted_at) VALUES(p_id,p_supervisor,p_date,p_work_status,v_now);
 INSERT INTO public.supervisor_day_founder_backfills(day_id,founder_id,reason) VALUES(p_id,v_actor,p_reason);
 RETURN jsonb_build_object('id',p_id,'status','pending','replayed',false);
END;
$$;
-- Lookup is available to any Founder for audit/reconciliation, never to other roles.
CREATE FUNCTION public.supervisor_day_backfill_lookup(p_id uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_result jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access required' USING ERRCODE='42501'; END IF;
 IF p_id IS NULL THEN RAISE EXCEPTION 'Invalid backfill ID' USING ERRCODE='22023'; END IF;
 SELECT jsonb_build_object('id',d.id,'supervisor_id',d.supervisor_id,'date',d.work_date,'work_status',d.work_status,'status',d.status,'founder_id',b.founder_id,'reason',b.reason,'recorded_at',b.recorded_at) INTO v_result FROM public.supervisor_day_founder_backfills b JOIN public.supervisor_daily_attendance d ON d.id=b.day_id WHERE b.day_id=p_id;
 RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.supervisor_day_backfill_catalog(),public.record_supervisor_day_backfill(uuid,uuid,date,text,text),public.supervisor_day_backfill_lookup(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.supervisor_day_backfill_catalog(),public.record_supervisor_day_backfill(uuid,uuid,date,text,text),public.supervisor_day_backfill_lookup(uuid) TO authenticated;
DO $postflight$
DECLARE v text;
BEGIN
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r(role_name) WHERE has_table_privilege(r.role_name,'public.supervisor_day_founder_backfills','SELECT,INSERT,UPDATE,DELETE,TRUNCATE') OR EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid='public.supervisor_day_founder_backfills'::regclass AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege(r.role_name,a.attrelid,a.attname,'SELECT,INSERT,UPDATE'))) THEN RAISE EXCEPTION 'Unexpected Supervisor backfill table privilege'; END IF;
 FOREACH v IN ARRAY ARRAY['public.supervisor_day_backfill_catalog()','public.record_supervisor_day_backfill(uuid,uuid,date,text,text)','public.supervisor_day_backfill_lookup(uuid)'] LOOP
  IF has_function_privilege('anon',v,'EXECUTE') OR has_function_privilege('service_role',v,'EXECUTE') OR NOT has_function_privilege('authenticated',v,'EXECUTE') THEN RAISE EXCEPTION 'Unexpected Supervisor backfill function privilege: %',v; END IF;
 END LOOP;
END;
$postflight$;


-- supabase/drafts/guard_legacy_bale_payment.sql sha256 47b62a435ebc6dc0dea77c10fa554f407d78e9f1e8559319e5b53e010a891696
-- Draft safety gate for the existing paid transition. This does not implement
-- the new payroll generator, real transfers, historical reconciliation, actual
-- payment dates or the weekly request/release schedule. It never rewrites rows.
-- Existing paid vouchers stay authoritative; ambiguous cases require review.

-- Serialize ordinary client advance insertion with payroll finalization using
-- the worker lock shared by existing payroll and manual-deduction functions.
-- A late advance for an approved/paid period must go through a separately
-- designed correction/reconciliation workflow, not silently affect history.
CREATE FUNCTION public.guard_new_advance_finalized_payroll()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  -- Privileged imports/service/database-owner work is outside this guard.
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  IF current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'Bale recording requires read committed isolation' USING ERRCODE='P1002'; END IF;
  PERFORM 1 FROM public.workers WHERE id=NEW.worker_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Worker unavailable' USING ERRCODE='22023'; END IF;
  IF EXISTS(SELECT 1 FROM public.payroll p WHERE p.worker_id=NEW.worker_id AND NEW.date BETWEEN p.period_start AND p.period_end AND p.status IN ('approved','paid')) THEN
    RAISE EXCEPTION 'Approved or paid payroll covers this Bale date; review a separate correction for the original period' USING ERRCODE='22023'; END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_new_advance_finalized_payroll() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER guard_new_advance_finalized_payroll BEFORE INSERT ON public.advances
FOR EACH ROW EXECUTE FUNCTION public.guard_new_advance_finalized_payroll();

-- Keep the atomic implementation and its audit behavior, but do not expose an
-- unguarded callable alias to API roles after renaming it.
ALTER FUNCTION public.set_payroll_status_atomic(uuid,text) RENAME TO legacy_set_payroll_status_atomic_unchecked;
REVOKE ALL ON FUNCTION public.legacy_set_payroll_status_atomic_unchecked(uuid,text) FROM PUBLIC,anon,authenticated,service_role;
DO $$
BEGIN
  IF has_function_privilege('anon','public.legacy_set_payroll_status_atomic_unchecked(uuid,text)','EXECUTE')
    OR has_function_privilege('authenticated','public.legacy_set_payroll_status_atomic_unchecked(uuid,text)','EXECUTE')
    OR has_function_privilege('service_role','public.legacy_set_payroll_status_atomic_unchecked(uuid,text)','EXECUTE') THEN
    RAISE EXCEPTION 'Unchecked payroll transition remains executable through inherited privileges'; END IF;
END;
$$;

CREATE FUNCTION public.set_payroll_status_atomic(p_payroll_id uuid,p_status text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_worker uuid; v_pay public.payroll%ROWTYPE; v_period_total numeric; v_has_period_bale boolean;
BEGIN
  IF NOT coalesce(public.is_founder(),false) THEN RAISE EXCEPTION 'Founder access is required' USING ERRCODE='42501'; END IF;
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Payroll status requires read committed isolation' USING ERRCODE='P1002'; END IF;
  IF p_status IS NULL OR p_status NOT IN ('approved','paid') THEN RAISE EXCEPTION 'Unsupported payroll transition' USING ERRCODE='22023'; END IF;
  SELECT worker_id INTO v_worker FROM public.payroll WHERE id=p_payroll_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payroll voucher not found' USING ERRCODE='P0002'; END IF;
  PERFORM 1 FROM public.workers WHERE id=v_worker FOR UPDATE;
  SELECT * INTO v_pay FROM public.payroll WHERE id=p_payroll_id FOR UPDATE;
  IF NOT FOUND OR v_pay.worker_id<>v_worker THEN RAISE EXCEPTION 'Payroll voucher changed; refresh and retry' USING ERRCODE='40001'; END IF;
  -- Preserve harmless already-paid retries and leave invalid transitions to the
  -- legacy implementation; never re-run deductions for a paid voucher.
  IF p_status='paid' AND v_pay.status='approved' THEN
    IF EXISTS(SELECT 1 FROM public.payroll p WHERE p.id<>v_pay.id AND p.worker_id=v_worker AND p.status IN ('approved','paid')
      AND p.period_start<=v_pay.period_end AND p.period_end>=v_pay.period_start) THEN
      RAISE EXCEPTION 'Another approved or paid voucher overlaps this period; review before recording payment' USING ERRCODE='22023'; END IF;
    IF v_pay.gross_pay-v_pay.bale_deduction-v_pay.other_deductions<0 OR v_pay.net_pay<>v_pay.gross_pay-v_pay.bale_deduction-v_pay.other_deductions THEN
      RAISE EXCEPTION 'Voucher totals need review before recording payment' USING ERRCODE='22023'; END IF;
    PERFORM 1 FROM public.advances WHERE worker_id=v_worker ORDER BY id FOR UPDATE;
    SELECT EXISTS(SELECT 1 FROM public.advances a WHERE a.worker_id=v_worker AND a.date BETWEEN v_pay.period_start AND v_pay.period_end
      AND (a.status<>'cancelled' OR a.amount_deducted<>0)) INTO v_has_period_bale;
    IF (v_pay.bale_deduction>0 OR v_has_period_bale) AND
      (v_pay.period_end<>v_pay.period_start+6 OR extract(dow FROM v_pay.period_start)<>0) THEN
      RAISE EXCEPTION 'Bale on a non-weekly voucher requires separate Founder reconciliation' USING ERRCODE='22023'; END IF;
    -- The legacy payment function consumes oldest outstanding balances first.
    -- Never let it silently draw a different period to satisfy this voucher.
    IF v_pay.bale_deduction>0 AND EXISTS(SELECT 1 FROM public.advances a WHERE a.worker_id=v_worker
      AND a.status IN ('active','partially_deducted') AND (a.date<v_pay.period_start OR a.date>v_pay.period_end)) THEN
      RAISE EXCEPTION 'Outstanding Bale outside this period requires separate Founder reconciliation; it will not be carried forward' USING ERRCODE='22023'; END IF;
    IF EXISTS(SELECT 1 FROM public.advances a WHERE a.worker_id=v_worker AND a.date BETWEEN v_pay.period_start AND v_pay.period_end
      AND ((a.status='cancelled' AND a.amount_deducted<>0) OR (a.status<>'cancelled' AND (
        a.status<>'active' OR a.amount_deducted<>0 OR extract(dow FROM a.date)<>3 OR NOT EXISTS(
          SELECT 1 FROM public.advance_requests r WHERE r.issued_advance_id=a.id AND r.status='issued'
            AND r.worker_id=a.worker_id AND r.project_id=a.project_id AND r.requested_amount=a.amount
            AND (r.issued_at AT TIME ZONE 'Asia/Manila')::date=a.date))))) THEN
      RAISE EXCEPTION 'Recorded Bale release, date or previous deduction needs Founder reconciliation' USING ERRCODE='22023'; END IF;
    IF EXISTS(SELECT 1 FROM public.advances a WHERE a.worker_id=v_worker AND a.date BETWEEN v_pay.period_start AND v_pay.period_end AND a.status<>'cancelled'
      GROUP BY a.project_id,a.date,a.amount HAVING count(*)>1) THEN
      RAISE EXCEPTION 'Possible duplicate Bale releases require Founder reconciliation' USING ERRCODE='22023'; END IF;
    SELECT coalesce(sum(a.amount),0) INTO v_period_total FROM public.advances a
      WHERE a.worker_id=v_worker AND a.date BETWEEN v_pay.period_start AND v_pay.period_end AND a.status='active';
    IF v_period_total<>v_pay.bale_deduction THEN
      RAISE EXCEPTION 'Voucher Bale deduction does not match all recorded releases for this period; review before payment' USING ERRCODE='22023'; END IF;
  END IF;
  RETURN public.legacy_set_payroll_status_atomic_unchecked(p_payroll_id,p_status);
END;
$$;
REVOKE ALL ON FUNCTION public.set_payroll_status_atomic(uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.set_payroll_status_atomic(uuid,text) TO authenticated,service_role;


-- supabase/drafts/weekly_payment_date.sql sha256 844df64f2a44861089e1abae7dd1194d7d23ed1405d54e1645e2f39c4721e9ee
-- DRAFT ONLY: coordinated cutover candidate, NOT a migration to apply alone.
-- Prerequisite: guard_legacy_bale_payment.sql must be installed and reviewed,
-- and every client must use record_guarded_weekly_payment before this cutover.
-- The prerequisite string checks below are tripwires, not proof that installed
-- functions/triggers match the reviewed source; inspect the full catalog and
-- test the release sequence before any deployment.
-- Old clients attempting to mark paid are deliberately rejected. No transfer
-- is sent; this records the Founder's statement that an external payment occurred.
-- This does not implement weekly payroll generation, allocation, historical
-- payment-date annotation, or the Bale request/release schedule.

DO $$
DECLARE v_definition text;
BEGIN
  IF to_regprocedure('public.legacy_set_payroll_status_atomic_unchecked(uuid,text)') IS NULL
     OR to_regprocedure('public.guard_new_advance_finalized_payroll()') IS NULL
     OR to_regprocedure('public.set_payroll_status_atomic(uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'The reviewed Bale payment guard is required before this draft';
  END IF;
  SELECT pg_get_functiondef('public.set_payroll_status_atomic(uuid,text)'::regprocedure) INTO v_definition;
  IF position('Voucher Bale deduction does not match all recorded releases' IN v_definition)=0
     OR position('Outstanding Bale outside this period' IN v_definition)=0 THEN
    RAISE EXCEPTION 'Expected guarded payroll transition not found';
  END IF;
END;
$$;

-- Never guess dates for existing paid vouchers; no backfill is performed.
CREATE TABLE public.payroll_payment_dates (
  payroll_id uuid PRIMARY KEY REFERENCES public.payroll(id) ON DELETE RESTRICT,
  payment_date date NOT NULL CHECK (payment_date >= DATE '1900-01-01'),
  recorded_by uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.payroll_payment_dates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.payroll_payment_dates FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.payroll_payment_dates TO authenticated;
CREATE POLICY founder_reads_payroll_payment_dates ON public.payroll_payment_dates
  FOR SELECT TO authenticated USING (coalesce(public.is_founder(),false));
DO $$
BEGIN
  IF has_table_privilege('anon','public.payroll_payment_dates','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
     OR has_table_privilege('authenticated','public.payroll_payment_dates','INSERT,UPDATE,DELETE,TRUNCATE')
     OR EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid='public.payroll_payment_dates'::regclass
       AND a.attnum>0 AND NOT a.attisdropped AND (
         has_column_privilege('anon',a.attrelid,a.attname,'SELECT,INSERT,UPDATE') OR
         has_column_privilege('authenticated',a.attrelid,a.attname,'INSERT,UPDATE'))) THEN
    RAISE EXCEPTION 'Unexpected inherited privileges on payroll payment dates';
  END IF;
END;
$$;

ALTER FUNCTION public.set_payroll_status_atomic(uuid,text) RENAME TO weekly_guarded_status_internal;
REVOKE ALL ON FUNCTION public.weekly_guarded_status_internal(uuid,text) FROM PUBLIC,anon,authenticated,service_role;
DO $$
BEGIN
  IF has_function_privilege('anon','public.weekly_guarded_status_internal(uuid,text)','EXECUTE')
     OR has_function_privilege('authenticated','public.weekly_guarded_status_internal(uuid,text)','EXECUTE')
     OR has_function_privilege('service_role','public.weekly_guarded_status_internal(uuid,text)','EXECUTE') THEN
    RAISE EXCEPTION 'Guarded internal transition remains callable through inherited privileges';
  END IF;
END;
$$;

-- Retain the old approval API; disallow its undated paid transition.
CREATE FUNCTION public.set_payroll_status_atomic(p_payroll_id uuid,p_status text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF NOT coalesce(public.is_founder(),false) THEN RAISE EXCEPTION 'Founder access required' USING ERRCODE='42501'; END IF;
  IF p_status IS DISTINCT FROM 'approved' THEN
    RAISE EXCEPTION 'Record payment with its actual date using the updated payment action; refresh the page and check the ledger before retrying' USING ERRCODE='22023';
  END IF;
  RETURN public.weekly_guarded_status_internal(p_payroll_id,p_status);
END;
$$;
REVOKE ALL ON FUNCTION public.set_payroll_status_atomic(uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.set_payroll_status_atomic(uuid,text) TO authenticated;

CREATE FUNCTION public.record_guarded_weekly_payment(p_payroll_id uuid,p_payment_date date)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  v_worker uuid; v_status text; v_start date; v_end date;
  v_existing public.payroll_payment_dates%ROWTYPE; v_result jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false)
     OR NOT coalesce(public.session_assurance_satisfied(),false) THEN
    RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501';
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Payment recording requires read committed isolation' USING ERRCODE='P1002';
  END IF;
  IF p_payment_date IS NULL OR p_payment_date < DATE '1900-01-01'
     OR p_payment_date > (statement_timestamp() AT TIME ZONE 'Asia/Manila')::date THEN
    RAISE EXCEPTION 'Enter the actual payment date, not a future date' USING ERRCODE='22023';
  END IF;
  SELECT worker_id INTO v_worker FROM public.payroll WHERE id=p_payroll_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payroll voucher not found' USING ERRCODE='P0002'; END IF;
  PERFORM 1 FROM public.workers WHERE id=v_worker FOR UPDATE;
  SELECT status,period_start,period_end INTO v_status,v_start,v_end
    FROM public.payroll WHERE id=p_payroll_id AND worker_id=v_worker FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payroll voucher changed; refresh and retry' USING ERRCODE='40001'; END IF;
  IF v_end <> v_start+6 OR extract(dow FROM v_start) <> 0 THEN
    RAISE EXCEPTION 'Only Sunday–Saturday worker vouchers are supported by this payment action' USING ERRCODE='22023';
  END IF;
  -- Conservative existing-identity heuristic, not proof of worker identity.
  -- A coordinated release still needs a reliable Supervisor/worker link.
  IF EXISTS(SELECT 1 FROM public.workers w WHERE w.id=v_worker AND (
      strpos(lower(w.position),'supervisor')>0 OR EXISTS(SELECT 1 FROM public.users u WHERE u.role='supervisor'
        AND (u.id=w.id OR lower(btrim(u.name))=lower(btrim(w.name))))))
     OR EXISTS(SELECT 1 FROM public.attendance a WHERE a.worker_id=v_worker AND a.date BETWEEN v_start AND v_end
       AND (a.worker_id=a.recorded_by OR strpos(coalesce(a.notes,''),'Pending Founder Review')>0
         OR strpos(coalesce(a.notes,''),'Founder Review:')>0)) THEN
    RAISE EXCEPTION 'Possible Supervisor identity requires separate payroll review' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_existing FROM public.payroll_payment_dates WHERE payroll_id=p_payroll_id;
  IF FOUND THEN
    IF v_status <> 'paid' OR v_existing.payment_date <> p_payment_date THEN
      RAISE EXCEPTION 'Existing payment date or status differs; review before retrying' USING ERRCODE='22023';
    END IF;
    RETURN jsonb_build_object('outcome','already_recorded','payroll',
      (SELECT to_jsonb(p) FROM public.payroll p WHERE p.id=p_payroll_id),
      'advances','[]'::jsonb,'payment_date',v_existing.payment_date);
  END IF;
  IF v_status <> 'approved' THEN
    RAISE EXCEPTION 'Only an approved, not-yet-paid voucher can be recorded here; review historical payments separately' USING ERRCODE='22023';
  END IF;
  -- A deduction cannot represent repayment of money released after the claimed
  -- payment date. This is checked under the same worker lock as release/payment.
  IF EXISTS(SELECT 1 FROM public.advances a WHERE a.worker_id=v_worker
    AND a.date BETWEEN v_start AND v_end AND a.status<>'cancelled' AND a.date>p_payment_date) THEN
    RAISE EXCEPTION 'Payment date precedes a recorded Bale release; review both dates' USING ERRCODE='22023';
  END IF;
  -- The prerequisite guard checks same-period Bale, overlapping final vouchers,
  -- amounts, and prior deductions; its nested transition and this evidence
  -- insert commit or roll back as one transaction.
  v_result := public.weekly_guarded_status_internal(p_payroll_id,'paid');
  IF v_result->>'outcome' IS DISTINCT FROM 'updated' THEN
    RAISE EXCEPTION 'Payment transition was not confirmed' USING ERRCODE='22023';
  END IF;
  INSERT INTO public.payroll_payment_dates(payroll_id,payment_date,recorded_by)
    VALUES(p_payroll_id,p_payment_date,auth.uid());
  RETURN v_result || jsonb_build_object('payment_date',p_payment_date);
END;
$$;
REVOKE ALL ON FUNCTION public.record_guarded_weekly_payment(uuid,date) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.record_guarded_weekly_payment(uuid,date) TO authenticated;


-- supabase/drafts/weekly_worker_generator.sql sha256 ea3774903746b0c89ae9189a519bb77a67186906ebb3352c132b9d14507bf730
-- DRAFT ONLY. This creates frozen, non-payable weekly draft vouchers in a
-- coordinated test database; it is NOT a release migration. It depends on all
-- weekly preview/time-detail/allowance migrations and the legacy payroll table.
-- No existing voucher is replaced, refreshed, approved, paid or deleted.
-- Until an approval path checks the source snapshot and coordinates the payment
-- and allocation cutover, generated vouchers are intentionally non-payable.
-- Its table-level locks temporarily block unrelated source writes and require
-- load/deadlock review before a hosted deployment; never apply in production as-is.

CREATE TABLE public.weekly_worker_draft_sources (
  payroll_id uuid PRIMARY KEY REFERENCES public.payroll(id) ON DELETE RESTRICT,
  worker_id uuid NOT NULL REFERENCES public.workers(id) ON DELETE RESTRICT,
  period_start date NOT NULL,
  recorded_by uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  source_snapshot jsonb NOT NULL,
  calculation jsonb NOT NULL,
  UNIQUE (worker_id,period_start)
);
ALTER TABLE public.weekly_worker_draft_sources ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.weekly_worker_draft_sources FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.weekly_worker_draft_sources TO authenticated;
CREATE POLICY founder_reads_weekly_worker_draft_sources ON public.weekly_worker_draft_sources
 FOR SELECT TO authenticated USING (coalesce(public.is_founder(),false) AND coalesce(public.session_assurance_satisfied(),false));
DO $$ BEGIN
 IF has_table_privilege('anon','public.weekly_worker_draft_sources','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
 OR has_table_privilege('authenticated','public.weekly_worker_draft_sources','INSERT,UPDATE,DELETE,TRUNCATE')
 OR has_table_privilege('service_role','public.weekly_worker_draft_sources','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid='public.weekly_worker_draft_sources'::regclass AND a.attnum>0 AND NOT a.attisdropped AND
  (has_column_privilege('anon',a.attrelid,a.attname,'SELECT,INSERT,UPDATE') OR has_column_privilege('authenticated',a.attrelid,a.attname,'INSERT,UPDATE') OR has_column_privilege('service_role',a.attrelid,a.attname,'SELECT,INSERT,UPDATE'))) THEN
  RAISE EXCEPTION 'Unexpected inherited privileges on weekly draft sources'; END IF;
END $$;

-- Existing clients can edit drafts and call legacy approval. Neither is safe
-- for these source-bound vouchers. Do not relax this without atomic source
-- revalidation, finalized-input protection and the coordinated payment path.
CREATE FUNCTION public.guard_weekly_worker_draft()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.weekly_worker_draft_sources s WHERE s.payroll_id=OLD.id) THEN
  RAISE EXCEPTION 'Weekly source-bound draft is frozen pending the reviewed approval workflow' USING ERRCODE='22023';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_weekly_worker_draft() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER guard_weekly_worker_draft BEFORE UPDATE OR DELETE ON public.payroll
 FOR EACH ROW EXECUTE FUNCTION public.guard_weekly_worker_draft();

-- Private evidence check. A pre-entered future day is not completed work or a
-- confirmed future disbursement. Never silently convert it to a payable wage.
CREATE FUNCTION public.weekly_worker_source_has_future(p_sources jsonb,p_today date) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM jsonb_array_elements(p_sources->'attendance') a WHERE (a->'record'->>'date')::date>p_today)
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_sources->'allowances') a WHERE a->>'status'<>'rejected' AND (a->>'attendance_date')::date>p_today)
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_sources->'advances') a WHERE a->'advance'->>'status'<>'cancelled' AND (a->'advance'->>'date')::date>p_today)
$$;
REVOKE ALL ON FUNCTION public.weekly_worker_source_has_future(jsonb,date) FROM PUBLIC,anon,authenticated,service_role;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r(role_name) WHERE has_function_privilege(r.role_name,'public.weekly_worker_source_has_future(jsonb,date)','EXECUTE')) THEN RAISE EXCEPTION 'Unexpected inherited weekly source helper privilege'; END IF; END $$;

-- Private shared calculator; caller must hold the generator's source locks and
-- validate authorization/period. Never expose this helper as a standalone RPC.
CREATE FUNCTION public.compute_weekly_worker_draft_locked(p_worker uuid,p_start date)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
 v_snapshot jsonb; v_worker jsonb; v_att jsonb; v_allow jsonb; v_adv jsonb; v_old jsonb;
 v_entry jsonb; v_item jsonb; v_detail jsonb; v_regular numeric:=0; v_ot numeric:=0;
 v_day_regular numeric; v_day_ot numeric; v_allowance numeric:=0; v_bale numeric:=0;
 v_rate numeric; v_wage numeric; v_gross numeric; v_net numeric; v_days numeric;
 v_unmarked jsonb; v_sources jsonb; v_calculation jsonb; v_dates date[]:='{}';
BEGIN
 v_snapshot:=public.weekly_worker_preview_inputs(p_start);
 IF coalesce(jsonb_typeof(v_snapshot),'')<>'object' OR v_snapshot->>'start' IS DISTINCT FROM p_start::text OR v_snapshot->>'end' IS DISTINCT FROM (p_start+6)::text
   OR coalesce(jsonb_typeof(v_snapshot->'workers'),'')<>'array'
   OR coalesce(jsonb_typeof(v_snapshot->'attendance'),'')<>'array'
   OR coalesce(jsonb_typeof(v_snapshot->'allowances'),'')<>'array'
   OR coalesce(jsonb_typeof(v_snapshot->'advances'),'')<>'array'
   OR coalesce(jsonb_typeof(v_snapshot->'older_advances'),'')<>'array' THEN
  RAISE EXCEPTION 'Incomplete weekly inputs; no voucher was created' USING ERRCODE='22023'; END IF;
 SELECT value INTO v_worker FROM jsonb_array_elements(v_snapshot->'workers') WHERE value->>'id'=p_worker::text;
 IF v_worker IS NULL OR coalesce((v_worker->>'linked_supervisor')::boolean,true) OR coalesce((v_worker->>'possible_supervisor')::boolean,true) THEN
  RAISE EXCEPTION 'Worker unavailable or possible Supervisor identity requires review' USING ERRCODE='22023'; END IF;
 IF coalesce(v_worker->>'pay_rate_type','') NOT IN ('daily','hourly') OR coalesce(v_worker->>'pay_rate','') !~ '^(0|[1-9][0-9]{0,7})(\.[0-9]{1,2})?$' THEN
  RAISE EXCEPTION 'Invalid worker rate' USING ERRCODE='22023'; END IF;
 v_rate:=(v_worker->>'pay_rate')::numeric;
 SELECT coalesce(jsonb_agg(x.value ORDER BY x.value->>'date',x.value->>'id'),'[]'::jsonb) INTO v_att
 FROM jsonb_array_elements(v_snapshot->'attendance') x WHERE x.value->>'worker_id'=p_worker::text;
 IF jsonb_array_length(v_att)=0 THEN RAISE EXCEPTION 'No marked attendance; unmarked does not mean absent' USING ERRCODE='22023'; END IF;
 FOR v_entry IN SELECT value FROM jsonb_array_elements(v_att) LOOP
  IF coalesce(v_entry->>'id','')='' OR coalesce(v_entry->>'project_id','')=''
   OR coalesce(v_entry->>'hours_worked','') !~ '^(0|[1-9][0-9]{0,1})(\.[0-9]{1,2})?$'
   OR v_entry->>'date' IS NULL OR (v_entry->>'date')::date NOT BETWEEN p_start AND p_start+6 OR (v_entry->>'date')::date=ANY(v_dates) THEN
   RAISE EXCEPTION 'Conflicting attendance dates require review' USING ERRCODE='22023'; END IF;
  v_dates:=array_append(v_dates,(v_entry->>'date')::date);
  v_detail:=v_entry->'time_detail';
  IF v_detail IS NULL THEN RAISE EXCEPTION 'Incomplete time detail response' USING ERRCODE='22023'; END IF;
  IF v_entry->>'status' IN ('present','half_day') THEN
   IF v_detail='null'::jsonb THEN v_day_regular:=(v_entry->>'hours_worked')::numeric;v_day_ot:=0;
   ELSE
    IF coalesce((v_detail->>'stale')::boolean,true) THEN RAISE EXCEPTION 'Stale time details require review' USING ERRCODE='22023'; END IF;
    v_day_regular:=(v_detail->>'regular_hours')::numeric;v_day_ot:=(v_detail->>'overtime_hours')::numeric;
   END IF;
   IF v_day_regular IS NULL OR v_day_ot IS NULL OR v_day_regular='NaN'::numeric OR v_day_ot='NaN'::numeric
      OR v_day_regular<0 OR v_day_regular>8 OR v_day_ot<0 OR v_day_regular+v_day_ot<=0 OR v_day_regular+v_day_ot>24 THEN
    RAISE EXCEPTION 'Recorded hours require review' USING ERRCODE='22023'; END IF;
   v_regular:=v_regular+v_day_regular;v_ot:=v_ot+v_day_ot;
  ELSIF v_entry->>'status' IN ('absent','leave') THEN
   IF (v_entry->>'hours_worked')::numeric<>0 OR v_detail<>'null'::jsonb THEN RAISE EXCEPTION 'Unworked attendance requires review' USING ERRCODE='22023'; END IF;
  ELSE RAISE EXCEPTION 'Invalid attendance status' USING ERRCODE='22023'; END IF;
 END LOOP;
 SELECT coalesce(jsonb_agg(x.value ORDER BY x.value->>'id'),'[]'::jsonb) INTO v_allow
 FROM jsonb_array_elements(v_snapshot->'allowances') x WHERE x.value->>'worker_id'=p_worker::text;
 FOR v_item IN SELECT value FROM jsonb_array_elements(v_allow) LOOP
  IF coalesce(v_item->>'id','')='' OR coalesce(v_item->>'project_id','')='' OR coalesce(v_item->>'date','')=''
    OR coalesce(v_item->>'description','')='' OR coalesce(v_item->>'status','') NOT IN ('pending','approved','rejected')
    OR coalesce(v_item->>'amount','') !~ '^(0|[1-9][0-9]{0,7})(\.[0-9]{1,2})?$' THEN
   RAISE EXCEPTION 'Incomplete allowance requires review' USING ERRCODE='22023'; END IF;
  IF v_item->>'status'='pending' OR (v_item->>'status'='approved' AND coalesce((v_item->>'stale')::boolean,true)) THEN
   RAISE EXCEPTION 'Pending or stale allowance requires review' USING ERRCODE='22023'; END IF;
  IF v_item->>'status'='approved' THEN
   IF (v_item->>'amount')::numeric<=0 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_att) a WHERE a->>'project_id'=v_item->>'project_id'
     AND a->>'date'=v_item->>'date' AND a->>'status' IN ('present','half_day')) THEN
    RAISE EXCEPTION 'Allowance does not match worked attendance' USING ERRCODE='22023'; END IF;
   v_allowance:=v_allowance+(v_item->>'amount')::numeric;
  ELSIF v_item->>'status'<>'rejected' THEN RAISE EXCEPTION 'Invalid allowance state' USING ERRCODE='22023'; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_allow) a WHERE a->>'status'<>'rejected'
  GROUP BY a->>'date',a->>'project_id',(a->>'amount')::numeric,lower(btrim(a->>'description')) HAVING count(*)>1) THEN
  RAISE EXCEPTION 'Possible duplicate allowance requires review' USING ERRCODE='22023'; END IF;
 SELECT coalesce(jsonb_agg(x.value ORDER BY x.value->>'id'),'[]'::jsonb) INTO v_adv
 FROM jsonb_array_elements(v_snapshot->'advances') x WHERE x.value->>'worker_id'=p_worker::text;
 SELECT coalesce(jsonb_agg(x.value ORDER BY x.value->>'id'),'[]'::jsonb) INTO v_old
 FROM jsonb_array_elements(v_snapshot->'older_advances') x WHERE x.value->>'worker_id'=p_worker::text;
 IF jsonb_array_length(v_old)>0 THEN RAISE EXCEPTION 'Older outstanding Bale requires separate review, not carry-forward' USING ERRCODE='22023'; END IF;
 FOR v_item IN SELECT value FROM jsonb_array_elements(v_adv) LOOP
  IF coalesce(v_item->>'id','')='' OR coalesce(v_item->>'project_id','')='' OR coalesce(v_item->>'date','')=''
    OR coalesce(v_item->>'status','') NOT IN ('active','partially_deducted','fully_deducted','cancelled')
    OR coalesce(v_item->>'amount','') !~ '^(0|[1-9][0-9]{0,7})(\.[0-9]{1,2})?$'
    OR coalesce(v_item->>'deducted','') !~ '^(0|[1-9][0-9]{0,7})(\.[0-9]{1,2})?$' THEN
   RAISE EXCEPTION 'Incomplete Bale requires review' USING ERRCODE='22023'; END IF;
  IF v_item->>'status'='cancelled' THEN
   IF (v_item->>'deducted')::numeric<>0 THEN RAISE EXCEPTION 'Cancelled Bale with deductions requires review' USING ERRCODE='22023'; END IF;
  ELSIF v_item->>'status'<>'active' OR (v_item->>'deducted')::numeric<>0 OR NOT coalesce((v_item->>'linked_release')::boolean,false)
    OR extract(dow FROM (v_item->>'date')::date)<>3 OR (v_item->>'amount')::numeric<=0 THEN
   RAISE EXCEPTION 'Bale release, timing or previous deduction requires review' USING ERRCODE='22023';
  ELSE v_bale:=v_bale+(v_item->>'amount')::numeric;
  END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_adv) a WHERE a->>'status'<>'cancelled'
  GROUP BY a->>'project_id',a->>'date',(a->>'amount')::numeric HAVING count(*)>1) THEN
  RAISE EXCEPTION 'Possible duplicate Bale requires review' USING ERRCODE='22023'; END IF;
 IF v_bale>0 AND EXISTS(SELECT 1 FROM public.advances a WHERE a.worker_id=p_worker AND a.date>p_start+6 AND a.status IN ('active','partially_deducted')) THEN
  RAISE EXCEPTION 'Outstanding Bale outside this period requires review, not carry-forward' USING ERRCODE='22023'; END IF;
 v_wage:=round(v_rate*(v_regular+v_ot)/CASE WHEN v_worker->>'pay_rate_type'='daily' THEN 8 ELSE 1 END,2);
 v_gross:=v_wage+v_allowance;v_net:=v_gross-v_bale;v_days:=round(v_regular/8,2);
 IF v_net<0 OR v_gross>=100000000 OR v_bale>=100000000 THEN RAISE EXCEPTION 'Bale exceeds earnings or amount exceeds voucher limit; review required' USING ERRCODE='22023'; END IF;
 SELECT coalesce(jsonb_agg(d::date ORDER BY d),'[]'::jsonb) INTO v_unmarked
 FROM generate_series(p_start::timestamp,(p_start+6)::timestamp,interval '1 day') d WHERE NOT d::date=ANY(v_dates);
 v_calculation:=jsonb_build_object('regular_hours',v_regular::numeric(10,2)::text,'overtime_hours',v_ot::numeric(10,2)::text,'wage',v_wage::numeric(10,2)::text,
  'allowance',v_allowance::numeric(10,2)::text,'gross',v_gross::numeric(10,2)::text,'bale',v_bale::numeric(10,2)::text,'net',v_net::numeric(10,2)::text,'unmarked_dates',v_unmarked);
 -- Preserve raw provenance including exact source snapshots and revisions.
 v_sources:=jsonb_build_object('version',1,'worker',v_worker,'attendance',
  (SELECT coalesce(jsonb_agg(jsonb_build_object('record',to_jsonb(a),'latest_detail',d.detail) ORDER BY a.date,a.id),'[]'::jsonb)
   FROM public.attendance a LEFT JOIN LATERAL (SELECT to_jsonb(t) detail FROM public.attendance_time_details t WHERE t.attendance_id=a.id ORDER BY t.revision_id DESC LIMIT 1) d ON true
   WHERE a.worker_id=p_worker AND a.date BETWEEN p_start AND p_start+6),
  'allowances',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.id),'[]'::jsonb) FROM public.worker_allowances a WHERE a.worker_id=p_worker AND a.attendance_date BETWEEN p_start AND p_start+6),
  'advances',(SELECT coalesce(jsonb_agg(jsonb_build_object('advance',to_jsonb(a),'request',to_jsonb(r)) ORDER BY a.id),'[]'::jsonb) FROM public.advances a LEFT JOIN public.advance_requests r ON r.issued_advance_id=a.id WHERE a.worker_id=p_worker AND a.date BETWEEN p_start AND p_start+6));
 IF octet_length(v_sources::text)>1048576 THEN RAISE EXCEPTION 'Source snapshot is too large; review before generation' USING ERRCODE='54000'; END IF;
 IF public.weekly_worker_source_has_future(v_sources,(statement_timestamp() AT TIME ZONE 'Asia/Manila')::date) THEN RAISE EXCEPTION 'Future-dated attendance, allowance or Bale requires review before generation' USING ERRCODE='22023'; END IF;
 RETURN jsonb_build_object('sources',v_sources,'calculation',v_calculation,'days',v_days,'hours',v_regular+v_ot);
END;
$$;
REVOKE ALL ON FUNCTION public.compute_weekly_worker_draft_locked(uuid,date) FROM PUBLIC,anon,authenticated,service_role;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r(role_name) WHERE has_function_privilege(r.role_name,'public.compute_weekly_worker_draft_locked(uuid,date)','EXECUTE')) THEN RAISE EXCEPTION 'Unexpected inherited weekly calculator privilege'; END IF; END $$;

CREATE FUNCTION public.create_weekly_worker_draft(p_id uuid,p_worker uuid,p_start date)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
 v_computed jsonb; v_sources jsonb; v_calculation jsonb;
 v_prev public.weekly_worker_draft_sources%ROWTYPE; v_pay public.payroll%ROWTYPE; v_email text;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN
  RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Weekly generation requires read committed isolation' USING ERRCODE='P1002'; END IF;
 IF p_id IS NULL OR p_worker IS NULL OR p_start IS NULL OR p_start<DATE '1900-01-01' OR p_start>DATE '9998-12-24' OR extract(dow FROM p_start)<>0 THEN
  RAISE EXCEPTION 'Choose a worker, a Sunday, and a request ID' USING ERRCODE='22023'; END IF;
 -- All source snapshots and duplicate checks must precede a single insert.
 -- Lock order is deliberately global and conservative; bound waiting, allow
 -- deadlock abort/retry, and test old client interactions before rollout.
 PERFORM pg_catalog.set_config('lock_timeout','3s',true);
 LOCK TABLE public.users,public.workers,public.attendance,public.attendance_time_details,
   public.worker_allowances,public.advances,public.advance_requests,public.payroll
   IN SHARE ROW EXCLUSIVE MODE;
 -- The actor's role may have changed while this statement waited for locks.
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN
  RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 SELECT * INTO v_prev FROM public.weekly_worker_draft_sources WHERE payroll_id=p_id;
 IF FOUND THEN
  IF (v_prev.worker_id,v_prev.period_start,v_prev.recorded_by) IS DISTINCT FROM (p_worker,p_start,auth.uid()) THEN
   RAISE EXCEPTION 'Draft ID already used for another request' USING ERRCODE='22023'; END IF;
  RETURN jsonb_build_object('replayed',true,'payroll_id',p_id,'calculation',v_prev.calculation);
 END IF;
 IF EXISTS(SELECT 1 FROM public.payroll WHERE id=p_id) OR EXISTS(SELECT 1 FROM public.weekly_worker_draft_sources WHERE worker_id=p_worker AND period_start=p_start) THEN
  RAISE EXCEPTION 'An existing voucher or weekly draft requires review; no record was overwritten' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM public.payroll p WHERE p.worker_id=p_worker AND p.period_start<=p_start+6 AND p.period_end>=p_start) THEN
  RAISE EXCEPTION 'An existing overlapping voucher requires review; no record was overwritten' USING ERRCODE='22023'; END IF;
 v_computed:=public.compute_weekly_worker_draft_locked(p_worker,p_start);
 v_sources:=v_computed->'sources'; v_calculation:=v_computed->'calculation';
 INSERT INTO public.payroll(id,worker_id,period_start,period_end,gross_pay,bale_deduction,other_deductions,net_pay,status,days_worked,hours_worked,notes)
 VALUES(p_id,p_worker,p_start,p_start+6,(v_calculation->>'gross')::numeric,(v_calculation->>'bale')::numeric,0,(v_calculation->>'net')::numeric,'draft',(v_computed->>'days')::numeric,(v_computed->>'hours')::numeric,'Weekly source-bound draft; approval workflow not yet available') RETURNING * INTO v_pay;
 INSERT INTO public.weekly_worker_draft_sources(payroll_id,worker_id,period_start,recorded_by,source_snapshot,calculation)
 VALUES(p_id,p_worker,p_start,auth.uid(),v_sources,v_calculation);
 SELECT email INTO v_email FROM public.users WHERE id=auth.uid();
 INSERT INTO public.audit_log(actor_id,actor_email,action,table_name,record_id,before_row,after_row)
 VALUES(auth.uid(),v_email,'insert','payroll',p_id,NULL,to_jsonb(v_pay));
 RETURN jsonb_build_object('replayed',false,'payroll_id',p_id,'calculation',v_calculation);
END;
$$;
REVOKE ALL ON FUNCTION public.create_weekly_worker_draft(uuid,uuid,date) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.create_weekly_worker_draft(uuid,uuid,date) TO authenticated;


-- supabase/drafts/weekly_worker_approval.sql sha256 90f2caa206d154febc83b4564d2849a1fd59c5b576e20661e9e417c5dc116d68
-- DRAFT ONLY: an approval candidate for source-bound weekly drafts. Requires
-- weekly_worker_generator.sql, its exact reviewed prerequisites and the existing
-- atomic status RPC. It deliberately leaves payment blocked: project posting,
-- late-edit protections, release policy and payment integration are unfinished.
-- Do not install this draft on a hosted database or treat it as a cutover script.

ALTER TABLE public.weekly_worker_draft_sources
 ADD COLUMN approved_by uuid REFERENCES public.users(id) ON DELETE RESTRICT,
 ADD COLUMN approved_at timestamptz,
 ADD COLUMN approval_xid bigint,
 ADD CONSTRAINT weekly_draft_approval_fields CHECK ((approved_by IS NULL)=(approved_at IS NULL));

-- The only permissible status transition is the narrow transition explicitly
-- authorized by the Founder-only function below in the CURRENT transaction.
-- Authenticated clients cannot write the source row or mint the marker.
CREATE OR REPLACE FUNCTION public.guard_weekly_worker_draft()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_source public.weekly_worker_draft_sources%ROWTYPE;
BEGIN
 SELECT * INTO v_source FROM public.weekly_worker_draft_sources WHERE payroll_id=OLD.id;
 IF FOUND THEN
  IF TG_OP='UPDATE' AND v_source.approval_xid=txid_current() AND v_source.approved_by=auth.uid()
    AND OLD.status='draft' AND NEW.status='approved'
    AND (to_jsonb(NEW)-'status') IS NOT DISTINCT FROM (to_jsonb(OLD)-'status') THEN
   RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Weekly source-bound voucher is frozen outside the reviewed approval workflow' USING ERRCODE='22023';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_weekly_worker_draft() FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.approve_weekly_worker_draft(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
 v_source public.weekly_worker_draft_sources%ROWTYPE; v_pay public.payroll%ROWTYPE;
 v_snapshot jsonb; v_worker jsonb; v_sources jsonb; v_result jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN
  RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Weekly approval requires read committed isolation' USING ERRCODE='P1002'; END IF;
 IF p_id IS NULL THEN RAISE EXCEPTION 'Choose a weekly draft' USING ERRCODE='22023'; END IF;
 PERFORM pg_catalog.set_config('lock_timeout','3s',true);
 LOCK TABLE public.users,public.workers,public.attendance,public.attendance_time_details,
  public.worker_allowances,public.advances,public.advance_requests,public.payroll,
  public.weekly_worker_draft_sources IN SHARE ROW EXCLUSIVE MODE;
 -- The actor's role may have changed while this statement waited for locks.
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN
  RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 SELECT * INTO v_source FROM public.weekly_worker_draft_sources WHERE payroll_id=p_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Weekly source-bound draft unavailable' USING ERRCODE='P0002'; END IF;
 SELECT * INTO v_pay FROM public.payroll WHERE id=p_id FOR UPDATE;
 IF NOT FOUND OR v_pay.worker_id<>v_source.worker_id OR v_pay.period_start<>v_source.period_start OR v_pay.period_end<>v_source.period_start+6 THEN
  RAISE EXCEPTION 'Weekly voucher changed; review' USING ERRCODE='40001'; END IF;
 -- A lost response may be retried, but an old-client approval or corrupted
 -- marker is never retroactively accepted as one of these approvals.
 IF v_pay.status='approved' AND v_source.approved_by IS NOT NULL AND v_source.approval_xid IS NULL THEN
  RETURN jsonb_build_object('outcome','already_approved','payroll',to_jsonb(v_pay));
 END IF;
 IF v_pay.status<>'draft' OR v_source.approved_by IS NOT NULL OR v_source.approval_xid IS NOT NULL THEN
  RAISE EXCEPTION 'Weekly voucher state requires review' USING ERRCODE='22023'; END IF;
 IF public.weekly_worker_source_has_future(v_source.source_snapshot,(statement_timestamp() AT TIME ZONE 'Asia/Manila')::date) THEN RAISE EXCEPTION 'Future-dated attendance, allowance or Bale requires review before approval' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM public.payroll p WHERE p.id<>p_id AND p.worker_id=v_pay.worker_id AND p.period_start<=v_pay.period_end AND p.period_end>=v_pay.period_start) THEN
  RAISE EXCEPTION 'Another overlapping voucher requires review' USING ERRCODE='22023'; END IF;
 IF v_pay.gross_pay IS DISTINCT FROM (v_source.calculation->>'gross')::numeric
  OR v_pay.bale_deduction IS DISTINCT FROM (v_source.calculation->>'bale')::numeric
  OR v_pay.other_deductions IS DISTINCT FROM 0::numeric
  OR v_pay.net_pay IS DISTINCT FROM (v_source.calculation->>'net')::numeric
  OR v_pay.days_worked IS DISTINCT FROM round((v_source.calculation->>'regular_hours')::numeric/8,2)
  OR v_pay.hours_worked IS DISTINCT FROM ((v_source.calculation->>'regular_hours')::numeric+(v_source.calculation->>'overtime_hours')::numeric) THEN
  RAISE EXCEPTION 'Weekly voucher totals changed; review' USING ERRCODE='40001'; END IF;
 IF EXISTS(SELECT 1 FROM public.advances a WHERE a.worker_id=v_pay.worker_id AND a.date<v_pay.period_start AND a.status IN ('active','partially_deducted'))
  OR (v_pay.bale_deduction>0 AND EXISTS(SELECT 1 FROM public.advances a WHERE a.worker_id=v_pay.worker_id AND a.date>v_pay.period_end AND a.status IN ('active','partially_deducted'))) THEN
  RAISE EXCEPTION 'Outstanding Bale outside the period requires separate review' USING ERRCODE='22023'; END IF;
 v_snapshot:=public.weekly_worker_preview_inputs(v_pay.period_start);
 IF coalesce(jsonb_typeof(v_snapshot->'workers'),'')<>'array' THEN RAISE EXCEPTION 'Weekly source snapshot unavailable' USING ERRCODE='22023'; END IF;
 SELECT value INTO v_worker FROM jsonb_array_elements(v_snapshot->'workers') WHERE value->>'id'=v_pay.worker_id::text;
 v_sources:=jsonb_build_object('version',1,'worker',v_worker,'attendance',
  (SELECT coalesce(jsonb_agg(jsonb_build_object('record',to_jsonb(a),'latest_detail',d.detail) ORDER BY a.date,a.id),'[]'::jsonb)
   FROM public.attendance a LEFT JOIN LATERAL (SELECT to_jsonb(t) detail FROM public.attendance_time_details t WHERE t.attendance_id=a.id ORDER BY t.revision_id DESC LIMIT 1) d ON true
   WHERE a.worker_id=v_pay.worker_id AND a.date BETWEEN v_pay.period_start AND v_pay.period_end),
  'allowances',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.id),'[]'::jsonb) FROM public.worker_allowances a WHERE a.worker_id=v_pay.worker_id AND a.attendance_date BETWEEN v_pay.period_start AND v_pay.period_end),
  'advances',(SELECT coalesce(jsonb_agg(jsonb_build_object('advance',to_jsonb(a),'request',to_jsonb(r)) ORDER BY a.id),'[]'::jsonb) FROM public.advances a LEFT JOIN public.advance_requests r ON r.issued_advance_id=a.id WHERE a.worker_id=v_pay.worker_id AND a.date BETWEEN v_pay.period_start AND v_pay.period_end));
 IF v_sources IS DISTINCT FROM v_source.source_snapshot THEN
  RAISE EXCEPTION 'Weekly source data changed since generation; review before approval' USING ERRCODE='40001'; END IF;
 UPDATE public.weekly_worker_draft_sources SET approved_by=auth.uid(),approved_at=clock_timestamp(),approval_xid=txid_current() WHERE payroll_id=p_id;
 v_result:=public.set_payroll_status_atomic(p_id,'approved');
 IF v_result->>'outcome' IS DISTINCT FROM 'updated' OR v_result->'payroll'->>'status' IS DISTINCT FROM 'approved' THEN
  RAISE EXCEPTION 'Weekly approval was not confirmed' USING ERRCODE='22023'; END IF;
 UPDATE public.weekly_worker_draft_sources SET approval_xid=NULL WHERE payroll_id=p_id;
 RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.approve_weekly_worker_draft(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.approve_weekly_worker_draft(uuid) TO authenticated;


-- supabase/drafts/weekly_worker_paid_allocation.sql sha256 ceabb64b5fcf8e502e21a22005111c73604466e72bdce229e3a3fbbf2ea6af9b
-- DRAFT ONLY, NOT A DEPLOYABLE MIGRATION. Requires the exact, reviewed weekly
-- generator, approval, legacy Bale guard and dated-payment candidates. This
-- experimental integration intentionally disables the standalone dated-payment
-- RPC, including for legacy vouchers, until a coordinated client cutover exists.
-- It records an external payment; it does not transfer money. Project entries
-- are gross payroll attribution, NOT a combined project expense total. Legacy
-- expenses may already include Bale; adding these entries to expense totals
-- without explicit reconciliation can double-count. Do not install on a host.

CREATE TABLE public.weekly_worker_paid_allocations (
 payroll_id uuid NOT NULL REFERENCES public.payroll(id) ON DELETE RESTRICT,
 project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE RESTRICT,
 hours numeric(8,2) NOT NULL CHECK (hours>0),
 wage numeric(10,2) NOT NULL CHECK (wage>=0),
 allowance numeric(10,2) NOT NULL CHECK (allowance>=0),
 gross numeric(10,2) NOT NULL CHECK (gross=wage+allowance),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(payroll_id,project_id)
);
ALTER TABLE public.weekly_worker_paid_allocations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.weekly_worker_paid_allocations FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.weekly_worker_paid_allocations TO authenticated;
CREATE POLICY founder_reads_weekly_paid_allocations ON public.weekly_worker_paid_allocations
 FOR SELECT TO authenticated USING (coalesce(public.is_founder(),false) AND coalesce(public.session_assurance_satisfied(),false));
DO $$ BEGIN
 IF has_table_privilege('anon','public.weekly_worker_paid_allocations','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
 OR has_table_privilege('authenticated','public.weekly_worker_paid_allocations','INSERT,UPDATE,DELETE,TRUNCATE')
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid='public.weekly_worker_paid_allocations'::regclass AND a.attnum>0 AND NOT a.attisdropped AND
  (has_column_privilege('anon',a.attrelid,a.attname,'SELECT,INSERT,UPDATE') OR has_column_privilege('authenticated',a.attrelid,a.attname,'INSERT,UPDATE'))) THEN
  RAISE EXCEPTION 'Unexpected inherited privileges on weekly paid allocations'; END IF;
END $$;
CREATE FUNCTION public.guard_weekly_paid_allocation_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN RAISE EXCEPTION 'Paid allocation is immutable; review a separate correction' USING ERRCODE='22023'; END;
$$;
REVOKE ALL ON FUNCTION public.guard_weekly_paid_allocation_immutable() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER guard_weekly_paid_allocation_immutable BEFORE UPDATE OR DELETE ON public.weekly_worker_paid_allocations
 FOR EACH ROW EXECUTE FUNCTION public.guard_weekly_paid_allocation_immutable();

ALTER TABLE public.weekly_worker_draft_sources
 ADD COLUMN payment_xid bigint,
 ADD COLUMN payment_actor uuid REFERENCES public.users(id) ON DELETE RESTRICT;

-- Keep the dated-payment routine internal: otherwise older clients could pay a
-- voucher without creating project allocations. The function's existing guard
-- and audit semantics still apply; only the integrated action may invoke it.
ALTER FUNCTION public.record_guarded_weekly_payment(uuid,date) RENAME TO weekly_payment_date_internal;
REVOKE ALL ON FUNCTION public.weekly_payment_date_internal(uuid,date) FROM PUBLIC,anon,authenticated,service_role;
DO $$ BEGIN
 IF has_function_privilege('anon','public.weekly_payment_date_internal(uuid,date)','EXECUTE')
 OR has_function_privilege('authenticated','public.weekly_payment_date_internal(uuid,date)','EXECUTE')
 OR has_function_privilege('service_role','public.weekly_payment_date_internal(uuid,date)','EXECUTE') THEN
  RAISE EXCEPTION 'Internal payment remains callable through inherited privileges'; END IF;
END $$;

CREATE OR REPLACE FUNCTION public.guard_weekly_worker_draft()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_source public.weekly_worker_draft_sources%ROWTYPE;
BEGIN
 SELECT * INTO v_source FROM public.weekly_worker_draft_sources WHERE payroll_id=OLD.id;
 IF FOUND THEN
  IF TG_OP='UPDATE' AND (to_jsonb(NEW)-'status') IS NOT DISTINCT FROM (to_jsonb(OLD)-'status') AND (
     (v_source.approval_xid=txid_current() AND v_source.approved_by=auth.uid() AND OLD.status='draft' AND NEW.status='approved') OR
     (v_source.payment_xid=txid_current() AND v_source.payment_actor=auth.uid() AND OLD.status='approved' AND NEW.status='paid')) THEN
   RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Weekly source-bound voucher is frozen outside the reviewed workflow' USING ERRCODE='22023';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_weekly_worker_draft() FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.record_weekly_worker_payment(p_id uuid,p_payment_date date)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
 v_source public.weekly_worker_draft_sources%ROWTYPE; v_pay public.payroll%ROWTYPE;
 v_snapshot jsonb; v_worker jsonb; v_sources jsonb; v_result jsonb;
 v_wage numeric; v_allowance numeric; v_hours numeric; v_alloc_wage numeric; v_alloc_allowance numeric; v_alloc_gross numeric; v_alloc_hours numeric; v_count bigint;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN
  RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Weekly payment requires read committed isolation' USING ERRCODE='P1002'; END IF;
 IF p_id IS NULL THEN RAISE EXCEPTION 'Choose a weekly voucher' USING ERRCODE='22023'; END IF;
 PERFORM pg_catalog.set_config('lock_timeout','3s',true);
 LOCK TABLE public.users,public.workers,public.projects,public.attendance,public.attendance_time_details,
  public.worker_allowances,public.advances,public.advance_requests,public.payroll,
  public.weekly_worker_draft_sources,public.payroll_payment_dates,public.weekly_worker_paid_allocations IN SHARE ROW EXCLUSIVE MODE;
 -- The actor's role may have changed while this statement waited for locks.
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN
  RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 SELECT * INTO v_source FROM public.weekly_worker_draft_sources WHERE payroll_id=p_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Source-bound weekly voucher unavailable; review older vouchers separately' USING ERRCODE='P0002'; END IF;
 SELECT * INTO v_pay FROM public.payroll WHERE id=p_id FOR UPDATE;
 IF NOT FOUND OR v_pay.worker_id<>v_source.worker_id OR v_pay.period_start<>v_source.period_start OR v_pay.period_end<>v_source.period_start+6 THEN
  RAISE EXCEPTION 'Weekly voucher changed; review' USING ERRCODE='40001'; END IF;
 v_wage:=(v_source.calculation->>'wage')::numeric;
 v_allowance:=(v_source.calculation->>'allowance')::numeric;
 v_hours:=(v_source.calculation->>'regular_hours')::numeric+(v_source.calculation->>'overtime_hours')::numeric;
 IF v_wage IS NULL OR v_allowance IS NULL OR v_hours IS NULL OR v_wage<0 OR v_allowance<0 OR v_hours<0
  OR v_pay.gross_pay IS DISTINCT FROM v_wage+v_allowance
  OR v_pay.gross_pay IS DISTINCT FROM (v_source.calculation->>'gross')::numeric
  OR v_pay.bale_deduction IS DISTINCT FROM (v_source.calculation->>'bale')::numeric
  OR v_pay.other_deductions IS DISTINCT FROM 0::numeric OR v_pay.net_pay IS DISTINCT FROM (v_source.calculation->>'net')::numeric
  OR v_pay.days_worked IS DISTINCT FROM round((v_source.calculation->>'regular_hours')::numeric/8,2)
  OR v_pay.hours_worked IS DISTINCT FROM v_hours THEN
  RAISE EXCEPTION 'Weekly voucher totals changed; review' USING ERRCODE='40001'; END IF;
 SELECT count(*),coalesce(sum(wage),0),coalesce(sum(allowance),0),coalesce(sum(gross),0),coalesce(sum(hours),0)
  INTO v_count,v_alloc_wage,v_alloc_allowance,v_alloc_gross,v_alloc_hours FROM public.weekly_worker_paid_allocations WHERE payroll_id=p_id;
 IF v_pay.status='paid' THEN
  IF v_source.approved_by IS NULL OR v_source.approved_at IS NULL OR v_source.approval_xid IS NOT NULL OR v_source.payment_actor IS NULL OR v_source.payment_xid IS NOT NULL
   OR NOT EXISTS(SELECT 1 FROM public.payroll_payment_dates d WHERE d.payroll_id=p_id AND d.recorded_by=v_source.payment_actor)
   OR (v_hours>0 AND v_count=0) OR (v_hours=0 AND v_count<>0)
   OR (v_alloc_wage,v_alloc_allowance,v_alloc_gross,v_alloc_hours) IS DISTINCT FROM (v_wage,v_allowance,v_pay.gross_pay,v_hours) THEN
   RAISE EXCEPTION 'Recorded payment allocation is incomplete; review before retrying' USING ERRCODE='22023'; END IF;
  RETURN public.weekly_payment_date_internal(p_id,p_payment_date);
 END IF;
 IF v_pay.status<>'approved' OR v_source.approved_by IS NULL OR v_source.approved_at IS NULL OR v_source.approval_xid IS NOT NULL
  OR v_source.payment_actor IS NOT NULL OR v_source.payment_xid IS NOT NULL OR v_count<>0
  OR EXISTS(SELECT 1 FROM public.payroll_payment_dates WHERE payroll_id=p_id) THEN
  RAISE EXCEPTION 'Weekly payment state requires review' USING ERRCODE='22023'; END IF;
 IF public.weekly_worker_source_has_future(v_source.source_snapshot,(statement_timestamp() AT TIME ZONE 'Asia/Manila')::date) THEN RAISE EXCEPTION 'Future-dated attendance, allowance or Bale requires review before payment recording' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM public.payroll p WHERE p.id<>p_id AND p.worker_id=v_pay.worker_id AND p.period_start<=v_pay.period_end AND p.period_end>=v_pay.period_start) THEN
  RAISE EXCEPTION 'Another overlapping voucher requires review' USING ERRCODE='22023'; END IF;
 -- Legacy Roll Call can still edit attendance after approval. Do not pay a
 -- silently changed snapshot: the change needs original-period review instead.
 v_snapshot:=public.weekly_worker_preview_inputs(v_pay.period_start);
 IF coalesce(jsonb_typeof(v_snapshot->'workers'),'')<>'array' THEN RAISE EXCEPTION 'Weekly source snapshot unavailable' USING ERRCODE='22023'; END IF;
 SELECT value INTO v_worker FROM jsonb_array_elements(v_snapshot->'workers') WHERE value->>'id'=v_pay.worker_id::text;
 v_sources:=jsonb_build_object('version',1,'worker',v_worker,'attendance',
  (SELECT coalesce(jsonb_agg(jsonb_build_object('record',to_jsonb(a),'latest_detail',d.detail) ORDER BY a.date,a.id),'[]'::jsonb)
   FROM public.attendance a LEFT JOIN LATERAL (SELECT to_jsonb(t) detail FROM public.attendance_time_details t WHERE t.attendance_id=a.id ORDER BY t.revision_id DESC LIMIT 1) d ON true
   WHERE a.worker_id=v_pay.worker_id AND a.date BETWEEN v_pay.period_start AND v_pay.period_end),
  'allowances',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.id),'[]'::jsonb) FROM public.worker_allowances a WHERE a.worker_id=v_pay.worker_id AND a.attendance_date BETWEEN v_pay.period_start AND v_pay.period_end),
  'advances',(SELECT coalesce(jsonb_agg(jsonb_build_object('advance',to_jsonb(a),'request',to_jsonb(r)) ORDER BY a.id),'[]'::jsonb) FROM public.advances a LEFT JOIN public.advance_requests r ON r.issued_advance_id=a.id WHERE a.worker_id=v_pay.worker_id AND a.date BETWEEN v_pay.period_start AND v_pay.period_end));
 IF v_sources IS DISTINCT FROM v_source.source_snapshot THEN RAISE EXCEPTION 'Weekly source data changed since approval; review before recording payment' USING ERRCODE='40001'; END IF;
 IF v_hours=0 AND (v_wage<>0 OR v_allowance<>0) THEN RAISE EXCEPTION 'No worked hours for a positive allocation' USING ERRCODE='22023'; END IF;
 -- Compute site shares from the approved source, not from current assignments.
 -- Wages are first rounded for the worker, then split into whole centavos by
 -- largest remainder; deterministic UUID order breaks ties. Allowances stay at
 -- their recorded site. Bale is not added or subtracted from gross attribution.
 WITH worked AS (
  SELECT (x->'record'->>'project_id')::uuid AS project_id,
   sum(CASE WHEN jsonb_typeof(x->'latest_detail')='object'
     THEN (x->'latest_detail'->>'regular_hours')::numeric+(x->'latest_detail'->>'overtime_hours')::numeric
     ELSE (x->'record'->>'hours_worked')::numeric END) AS hours
  FROM jsonb_array_elements(v_source.source_snapshot->'attendance') x
  WHERE x->'record'->>'status' IN ('present','half_day') GROUP BY 1
 ), allowances AS (
  SELECT (x->>'project_id')::uuid AS project_id,sum((x->>'amount')::numeric) AS amount
  FROM jsonb_array_elements(v_source.source_snapshot->'allowances') x WHERE x->>'status'='approved' GROUP BY 1
 ), weighted AS (
  SELECT w.project_id,w.hours,coalesce(a.amount,0) AS allowance,
   floor(v_wage*100*w.hours/NULLIF(v_hours,0)) AS base_cents,
   mod(v_wage*100*w.hours,NULLIF(v_hours,0)) AS remainder
  FROM worked w LEFT JOIN allowances a ON a.project_id=w.project_id
 ), ranked AS (
  SELECT *,row_number() OVER(ORDER BY remainder DESC,project_id) AS position,
   v_wage*100-sum(base_cents) OVER() AS remainder_cents FROM weighted
 )
 INSERT INTO public.weekly_worker_paid_allocations(payroll_id,project_id,hours,wage,allowance,gross)
 SELECT p_id,project_id,hours,(base_cents+CASE WHEN position<=remainder_cents THEN 1 ELSE 0 END)/100,allowance,
   (base_cents+CASE WHEN position<=remainder_cents THEN 1 ELSE 0 END)/100+allowance
 FROM ranked ORDER BY project_id;
 SELECT count(*),coalesce(sum(wage),0),coalesce(sum(allowance),0),coalesce(sum(gross),0),coalesce(sum(hours),0)
  INTO v_count,v_alloc_wage,v_alloc_allowance,v_alloc_gross,v_hours FROM public.weekly_worker_paid_allocations WHERE payroll_id=p_id;
 IF (v_pay.hours_worked>0 AND v_count=0) OR (v_pay.hours_worked=0 AND v_count<>0)
  OR (v_alloc_wage,v_alloc_allowance,v_alloc_gross,v_hours) IS DISTINCT FROM
   (v_wage,v_allowance,v_pay.gross_pay,v_pay.hours_worked) THEN
  RAISE EXCEPTION 'Project allocation does not reconcile with the approved voucher' USING ERRCODE='22023'; END IF;
 UPDATE public.weekly_worker_draft_sources SET payment_xid=txid_current(),payment_actor=auth.uid() WHERE payroll_id=p_id;
 v_result:=public.weekly_payment_date_internal(p_id,p_payment_date);
 IF v_result->>'outcome' IS DISTINCT FROM 'updated' OR v_result->'payroll'->>'status' IS DISTINCT FROM 'paid' THEN
  RAISE EXCEPTION 'Weekly payment was not confirmed' USING ERRCODE='22023'; END IF;
 UPDATE public.weekly_worker_draft_sources SET payment_xid=NULL WHERE payroll_id=p_id;
 RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.record_weekly_worker_payment(uuid,date) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.record_weekly_worker_payment(uuid,date) TO authenticated;


-- supabase/drafts/weekly_worker_draft_details.sql sha256 d796cd31585565f9395d2391b75a5962b29537f243e0308a42e185eff5525377
-- DRAFT ONLY, NOT A RELEASE MIGRATION. Read-only support for the experimental
-- weekly workflow. Requires the exact uninstalled generator, approval, payment
-- and allocation drafts. This does not install or enable the workflow.
CREATE FUNCTION public.weekly_worker_draft_details(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_result jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN
  RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 SELECT jsonb_build_object(
  'payroll_id',p.id,'worker_id',p.worker_id,'period_start',p.period_start,'period_end',p.period_end,
  'status',p.status,'calculation',s.calculation,
  'gross',p.gross_pay::numeric(10,2)::text,'bale',p.bale_deduction::numeric(10,2)::text,
  'other',p.other_deductions::numeric(10,2)::text,'net',p.net_pay::numeric(10,2)::text,
  'payment_date',d.payment_date,'approved',s.approved_by IS NOT NULL,
  'allocations',(SELECT coalesce(jsonb_agg(jsonb_build_object('project_id',a.project_id,
    'hours',a.hours::text,'wage',a.wage::text,'allowance',a.allowance::text,'gross',a.gross::text)
    ORDER BY a.project_id),'[]'::jsonb) FROM public.weekly_worker_paid_allocations a WHERE a.payroll_id=p.id))
 INTO v_result FROM public.weekly_worker_draft_sources s JOIN public.payroll p ON p.id=s.payroll_id
 LEFT JOIN public.payroll_payment_dates d ON d.payroll_id=p.id WHERE s.payroll_id=p_id;
 IF v_result IS NULL THEN RAISE EXCEPTION 'Source-bound weekly voucher unavailable; review legacy history separately' USING ERRCODE='P0002'; END IF;
 RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.weekly_worker_draft_details(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.weekly_worker_draft_details(uuid) TO authenticated;
DO $$ BEGIN
 IF has_function_privilege('anon','public.weekly_worker_draft_details(uuid)','EXECUTE')
 OR has_function_privilege('service_role','public.weekly_worker_draft_details(uuid)','EXECUTE') THEN
  RAISE EXCEPTION 'Unexpected inherited privilege on weekly voucher details'; END IF;
END $$;


-- supabase/drafts/weekly_paid_attendance_change_review.sql sha256 2f5437d8bee25e3e16ff2dfaa9eb1f481a8723bbc440d494f49e4add1f7baea8
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


-- supabase/drafts/weekly_worker_draft_refresh.sql sha256 f4b0290f9c4a10f79fd543b946a7725389147bb307a34f361317c9161a45470d
-- DRAFT ONLY. Requires the exact generator, approval, payment/allocation and
-- details candidates. Not a migration; do not install on a hosted database.
-- Refreshes only unapproved drafts. Approved/paid changes need a separately
-- reviewed original-period process. Requires a coordinated new approval client:
-- the old approval signature is revoked so a stale screen cannot approve a
-- refreshed amount it never reviewed. Broad source locks need load review.

ALTER TABLE public.weekly_worker_draft_sources
 ADD COLUMN draft_revision bigint NOT NULL DEFAULT 0 CHECK (draft_revision>=0),
 ADD COLUMN refresh_xid bigint,
 ADD COLUMN refresh_actor uuid REFERENCES public.users(id) ON DELETE RESTRICT;

CREATE TABLE public.weekly_worker_draft_refreshes (
 request_id uuid PRIMARY KEY,
 payroll_id uuid NOT NULL REFERENCES public.payroll(id) ON DELETE RESTRICT,
 actor_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 expected_revision bigint NOT NULL CHECK (expected_revision>=0),
 new_revision bigint NOT NULL CHECK (new_revision=expected_revision+1),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 before_payroll jsonb NOT NULL,
 after_payroll jsonb NOT NULL,
 before_sources jsonb NOT NULL,
 after_sources jsonb NOT NULL,
 before_calculation jsonb NOT NULL,
 after_calculation jsonb NOT NULL,
 UNIQUE(payroll_id,new_revision)
);
ALTER TABLE public.weekly_worker_draft_refreshes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.weekly_worker_draft_refreshes FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.weekly_worker_draft_refreshes TO authenticated;
CREATE POLICY founder_reads_weekly_refreshes ON public.weekly_worker_draft_refreshes
 FOR SELECT TO authenticated USING (coalesce(public.is_founder(),false) AND coalesce(public.session_assurance_satisfied(),false));
DO $$ BEGIN
 IF has_table_privilege('anon','public.weekly_worker_draft_refreshes','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
 OR has_table_privilege('authenticated','public.weekly_worker_draft_refreshes','INSERT,UPDATE,DELETE,TRUNCATE')
 OR has_table_privilege('service_role','public.weekly_worker_draft_refreshes','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid='public.weekly_worker_draft_refreshes'::regclass AND a.attnum>0 AND NOT a.attisdropped AND
  (has_column_privilege('anon',a.attrelid,a.attname,'SELECT,INSERT,UPDATE') OR has_column_privilege('authenticated',a.attrelid,a.attname,'INSERT,UPDATE') OR has_column_privilege('service_role',a.attrelid,a.attname,'SELECT,INSERT,UPDATE'))) THEN
  RAISE EXCEPTION 'Unexpected inherited weekly refresh history privileges'; END IF;
END $$;
CREATE FUNCTION public.guard_weekly_refresh_history() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN RAISE EXCEPTION 'Weekly refresh history is immutable' USING ERRCODE='22023'; END;
$$;
REVOKE ALL ON FUNCTION public.guard_weekly_refresh_history() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER guard_weekly_refresh_history BEFORE UPDATE OR DELETE ON public.weekly_worker_draft_refreshes
 FOR EACH ROW EXECUTE FUNCTION public.guard_weekly_refresh_history();

CREATE OR REPLACE FUNCTION public.guard_weekly_worker_draft()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_source public.weekly_worker_draft_sources%ROWTYPE;
BEGIN
 SELECT * INTO v_source FROM public.weekly_worker_draft_sources WHERE payroll_id=OLD.id;
 IF FOUND THEN
  IF TG_OP='UPDATE' AND (to_jsonb(NEW)-'status') IS NOT DISTINCT FROM (to_jsonb(OLD)-'status') AND (
     (v_source.approval_xid=txid_current() AND v_source.approved_by=auth.uid() AND OLD.status='draft' AND NEW.status='approved') OR
     (v_source.payment_xid=txid_current() AND v_source.payment_actor=auth.uid() AND OLD.status='approved' AND NEW.status='paid')) THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND v_source.refresh_xid=txid_current() AND v_source.refresh_actor=auth.uid()
     AND OLD.status='draft' AND NEW.status='draft'
     AND (to_jsonb(NEW)-ARRAY['gross_pay','bale_deduction','net_pay','days_worked','hours_worked'])
       IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['gross_pay','bale_deduction','net_pay','days_worked','hours_worked']) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Weekly source-bound voucher is frozen outside the reviewed workflow' USING ERRCODE='22023';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_weekly_worker_draft() FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.refresh_weekly_worker_draft(p_request uuid,p_id uuid,p_expected_revision bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
 v_source public.weekly_worker_draft_sources%ROWTYPE; v_pay public.payroll%ROWTYPE; v_new public.payroll%ROWTYPE;
 v_previous public.weekly_worker_draft_refreshes%ROWTYPE; v_computed jsonb; v_calc jsonb; v_email text;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN
  RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Weekly refresh requires read committed isolation' USING ERRCODE='P1002'; END IF;
 IF p_request IS NULL OR p_id IS NULL OR p_expected_revision IS NULL OR p_expected_revision<0 OR p_expected_revision>=9223372036854775807 THEN
  RAISE EXCEPTION 'Choose a draft, revision and request ID' USING ERRCODE='22023'; END IF;
 PERFORM pg_catalog.set_config('lock_timeout','3s',true);
 LOCK TABLE public.users,public.workers,public.projects,public.attendance,public.attendance_time_details,
  public.worker_allowances,public.advances,public.advance_requests,public.payroll,
  public.weekly_worker_draft_sources,public.payroll_payment_dates,public.weekly_worker_paid_allocations,
  public.weekly_worker_draft_refreshes IN SHARE ROW EXCLUSIVE MODE;
 -- The actor's role may have changed while this statement waited for locks.
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN
  RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 SELECT * INTO v_previous FROM public.weekly_worker_draft_refreshes WHERE request_id=p_request;
 IF FOUND THEN
  IF (v_previous.payroll_id,v_previous.actor_id,v_previous.expected_revision) IS DISTINCT FROM (p_id,auth.uid(),p_expected_revision) THEN
   RAISE EXCEPTION 'Refresh request ID was used for another action' USING ERRCODE='22023'; END IF;
  RETURN jsonb_build_object('replayed',true,'payroll_id',p_id,'revision',v_previous.new_revision,'calculation',v_previous.after_calculation);
 END IF;
 SELECT * INTO v_source FROM public.weekly_worker_draft_sources WHERE payroll_id=p_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Weekly source-bound draft unavailable' USING ERRCODE='P0002'; END IF;
 SELECT * INTO v_pay FROM public.payroll WHERE id=p_id FOR UPDATE;
 IF NOT FOUND OR v_pay.worker_id IS DISTINCT FROM v_source.worker_id OR v_pay.period_start IS DISTINCT FROM v_source.period_start OR v_pay.period_end IS DISTINCT FROM v_source.period_start+6 THEN
  RAISE EXCEPTION 'Weekly voucher changed; review' USING ERRCODE='40001'; END IF;
 IF v_source.draft_revision<>p_expected_revision THEN RAISE EXCEPTION 'Draft revision changed; reload before refresh' USING ERRCODE='40001'; END IF;
 IF v_pay.status<>'draft' OR v_source.approved_by IS NOT NULL OR v_source.approved_at IS NOT NULL OR v_source.approval_xid IS NOT NULL
  OR v_source.payment_actor IS NOT NULL OR v_source.payment_xid IS NOT NULL OR v_source.refresh_actor IS NOT NULL OR v_source.refresh_xid IS NOT NULL
  OR EXISTS(SELECT 1 FROM public.payroll_payment_dates WHERE payroll_id=p_id)
  OR EXISTS(SELECT 1 FROM public.weekly_worker_paid_allocations WHERE payroll_id=p_id) THEN
  RAISE EXCEPTION 'Only an unapproved, unpaid weekly draft can be refreshed' USING ERRCODE='22023'; END IF;
 IF v_pay.gross_pay IS DISTINCT FROM (v_source.calculation->>'gross')::numeric OR v_pay.bale_deduction IS DISTINCT FROM (v_source.calculation->>'bale')::numeric
  OR v_pay.other_deductions IS DISTINCT FROM 0::numeric OR v_pay.net_pay IS DISTINCT FROM (v_source.calculation->>'net')::numeric
  OR v_pay.days_worked IS DISTINCT FROM round((v_source.calculation->>'regular_hours')::numeric/8,2)
  OR v_pay.hours_worked IS DISTINCT FROM (v_source.calculation->>'regular_hours')::numeric+(v_source.calculation->>'overtime_hours')::numeric THEN
  RAISE EXCEPTION 'Weekly voucher totals changed; review' USING ERRCODE='40001'; END IF;
 IF EXISTS(SELECT 1 FROM public.payroll p WHERE p.id<>p_id AND p.worker_id=v_pay.worker_id AND p.period_start<=v_pay.period_end AND p.period_end>=v_pay.period_start) THEN
  RAISE EXCEPTION 'Another overlapping voucher requires review' USING ERRCODE='22023'; END IF;
 v_computed:=public.compute_weekly_worker_draft_locked(v_pay.worker_id,v_pay.period_start);v_calc:=v_computed->'calculation';
 UPDATE public.weekly_worker_draft_sources SET refresh_xid=txid_current(),refresh_actor=auth.uid() WHERE payroll_id=p_id;
 UPDATE public.payroll SET gross_pay=(v_calc->>'gross')::numeric,bale_deduction=(v_calc->>'bale')::numeric,net_pay=(v_calc->>'net')::numeric,
  days_worked=(v_computed->>'days')::numeric,hours_worked=(v_computed->>'hours')::numeric WHERE id=p_id RETURNING * INTO v_new;
 UPDATE public.weekly_worker_draft_sources SET source_snapshot=v_computed->'sources',calculation=v_calc,draft_revision=p_expected_revision+1,refresh_xid=NULL,refresh_actor=NULL WHERE payroll_id=p_id;
 INSERT INTO public.weekly_worker_draft_refreshes(request_id,payroll_id,actor_id,expected_revision,new_revision,before_payroll,after_payroll,before_sources,after_sources,before_calculation,after_calculation)
 VALUES(p_request,p_id,auth.uid(),p_expected_revision,p_expected_revision+1,to_jsonb(v_pay),to_jsonb(v_new),v_source.source_snapshot,v_computed->'sources',v_source.calculation,v_calc);
 SELECT email INTO v_email FROM public.users WHERE id=auth.uid();
 INSERT INTO public.audit_log(actor_id,actor_email,action,table_name,record_id,before_row,after_row)
 VALUES(auth.uid(),v_email,'update','payroll',p_id,to_jsonb(v_pay),to_jsonb(v_new));
 RETURN jsonb_build_object('replayed',false,'payroll_id',p_id,'revision',p_expected_revision+1,'calculation',v_calc);
END;
$$;
REVOKE ALL ON FUNCTION public.refresh_weekly_worker_draft(uuid,uuid,bigint) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.refresh_weekly_worker_draft(uuid,uuid,bigint) TO authenticated;
DO $$ BEGIN IF has_function_privilege('anon','public.refresh_weekly_worker_draft(uuid,uuid,bigint)','EXECUTE') OR has_function_privilege('service_role','public.refresh_weekly_worker_draft(uuid,uuid,bigint)','EXECUTE') THEN RAISE EXCEPTION 'Unexpected inherited refresh privilege'; END IF; END $$;

-- Approval must bind to the revision the Founder reviewed. The wrapper locks in
-- the same order as payment/refresh before checking it. Internal approval keeps
-- all source, totals, authorization and overlap checks; clients cannot call it.
ALTER FUNCTION public.approve_weekly_worker_draft(uuid) RENAME TO weekly_worker_approval_internal;
REVOKE ALL ON FUNCTION public.weekly_worker_approval_internal(uuid) FROM PUBLIC,anon,authenticated,service_role;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r(role_name) WHERE has_function_privilege(r.role_name,'public.weekly_worker_approval_internal(uuid)','EXECUTE')) THEN RAISE EXCEPTION 'Unexpected inherited internal approval privilege'; END IF; END $$;
CREATE FUNCTION public.approve_weekly_worker_draft(p_id uuid,p_expected_revision bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_revision bigint;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Weekly approval requires read committed isolation' USING ERRCODE='P1002'; END IF;
 IF p_id IS NULL OR p_expected_revision IS NULL OR p_expected_revision<0 THEN RAISE EXCEPTION 'Choose a weekly draft and revision' USING ERRCODE='22023'; END IF;
 PERFORM pg_catalog.set_config('lock_timeout','3s',true);
 LOCK TABLE public.users,public.workers,public.projects,public.attendance,public.attendance_time_details,
  public.worker_allowances,public.advances,public.advance_requests,public.payroll,public.weekly_worker_draft_sources IN SHARE ROW EXCLUSIVE MODE;
 -- The actor's role may have changed while this statement waited for locks.
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN
  RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 SELECT draft_revision INTO v_revision FROM public.weekly_worker_draft_sources WHERE payroll_id=p_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Weekly source-bound draft unavailable' USING ERRCODE='P0002'; END IF;
 IF v_revision<>p_expected_revision THEN RAISE EXCEPTION 'Draft revision changed; reload before approval' USING ERRCODE='40001'; END IF;
 RETURN public.weekly_worker_approval_internal(p_id);
END;
$$;
REVOKE ALL ON FUNCTION public.approve_weekly_worker_draft(uuid,bigint) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.approve_weekly_worker_draft(uuid,bigint) TO authenticated;
DO $$ BEGIN IF has_function_privilege('anon','public.approve_weekly_worker_draft(uuid,bigint)','EXECUTE') OR has_function_privilege('service_role','public.approve_weekly_worker_draft(uuid,bigint)','EXECUTE') THEN RAISE EXCEPTION 'Unexpected inherited approval privilege'; END IF; END $$;

-- Existing details shape is extended without exposing private snapshots.
ALTER FUNCTION public.weekly_worker_draft_details(uuid) RENAME TO weekly_worker_draft_details_internal;
REVOKE ALL ON FUNCTION public.weekly_worker_draft_details_internal(uuid) FROM PUBLIC,anon,authenticated,service_role;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r(role_name) WHERE has_function_privilege(r.role_name,'public.weekly_worker_draft_details_internal(uuid)','EXECUTE')) THEN RAISE EXCEPTION 'Unexpected inherited internal details privilege'; END IF; END $$;
CREATE FUNCTION public.weekly_worker_draft_details(p_id uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_details jsonb; v_revision bigint;
BEGIN
 v_details:=public.weekly_worker_draft_details_internal(p_id);
 SELECT draft_revision INTO v_revision FROM public.weekly_worker_draft_sources WHERE payroll_id=p_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Weekly source-bound draft unavailable' USING ERRCODE='P0002'; END IF;
 RETURN v_details||jsonb_build_object('draft_revision',v_revision);
END;
$$;
REVOKE ALL ON FUNCTION public.weekly_worker_draft_details(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.weekly_worker_draft_details(uuid) TO authenticated;
DO $$ BEGIN IF has_function_privilege('anon','public.weekly_worker_draft_details(uuid)','EXECUTE') OR has_function_privilege('service_role','public.weekly_worker_draft_details(uuid)','EXECUTE') THEN RAISE EXCEPTION 'Unexpected inherited details privilege'; END IF; END $$;


-- supabase/drafts/weekly_worker_return_to_draft.sql sha256 fd4c7db0454fdb834f081df9c69a8d276f8da0f8e2d7fc9e978d849ac23a1c67
-- DRAFT ONLY: NOT a hosted migration. Requires the exact generator, approval,
-- allocation, details and revision-aware refresh candidates. This candidate
-- deliberately disables the old payment signature and needs a coordinated
-- revision-aware client. It records no payment and cannot know whether money
-- was paid externally. Do NOT use when external payment may already have
-- occurred: investigate and handle it as a paid-period case instead.

ALTER TABLE public.weekly_worker_draft_sources
 ADD COLUMN return_xid bigint,
 ADD COLUMN return_actor uuid REFERENCES public.users(id) ON DELETE RESTRICT;
CREATE TABLE public.weekly_worker_approval_returns (
 request_id uuid PRIMARY KEY,
 payroll_id uuid NOT NULL REFERENCES public.payroll(id) ON DELETE RESTRICT,
 actor_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 expected_revision bigint NOT NULL CHECK(expected_revision>=0),
 new_revision bigint NOT NULL CHECK(new_revision=expected_revision+1),
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 500),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 previous_approved_by uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 previous_approved_at timestamptz NOT NULL,
 approved_payroll jsonb NOT NULL,
 approved_sources jsonb NOT NULL,
 approved_calculation jsonb NOT NULL,
 UNIQUE(payroll_id,new_revision)
);
ALTER TABLE public.weekly_worker_approval_returns ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.weekly_worker_approval_returns FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.weekly_worker_approval_returns TO authenticated;
CREATE POLICY founder_reads_weekly_approval_returns ON public.weekly_worker_approval_returns
 FOR SELECT TO authenticated USING (coalesce(public.is_founder(),false) AND coalesce(public.session_assurance_satisfied(),false));
DO $$ BEGIN
 IF has_table_privilege('anon','public.weekly_worker_approval_returns','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
 OR has_table_privilege('authenticated','public.weekly_worker_approval_returns','INSERT,UPDATE,DELETE,TRUNCATE')
 OR has_table_privilege('service_role','public.weekly_worker_approval_returns','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid='public.weekly_worker_approval_returns'::regclass AND a.attnum>0 AND NOT a.attisdropped AND
  (has_column_privilege('anon',a.attrelid,a.attname,'SELECT,INSERT,UPDATE') OR has_column_privilege('authenticated',a.attrelid,a.attname,'INSERT,UPDATE') OR has_column_privilege('service_role',a.attrelid,a.attname,'SELECT,INSERT,UPDATE'))) THEN
  RAISE EXCEPTION 'Unexpected inherited approval-return history privileges'; END IF;
END $$;
CREATE FUNCTION public.guard_weekly_approval_return_history() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN RAISE EXCEPTION 'Approval-return history is immutable' USING ERRCODE='22023'; END;
$$;
REVOKE ALL ON FUNCTION public.guard_weekly_approval_return_history() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER guard_weekly_approval_return_history BEFORE UPDATE OR DELETE ON public.weekly_worker_approval_returns
 FOR EACH ROW EXECUTE FUNCTION public.guard_weekly_approval_return_history();

CREATE OR REPLACE FUNCTION public.guard_weekly_worker_draft()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_source public.weekly_worker_draft_sources%ROWTYPE;
BEGIN
 SELECT * INTO v_source FROM public.weekly_worker_draft_sources WHERE payroll_id=OLD.id;
 IF FOUND THEN
  IF TG_OP='UPDATE' AND (to_jsonb(NEW)-'status') IS NOT DISTINCT FROM (to_jsonb(OLD)-'status') AND (
     (v_source.approval_xid=txid_current() AND v_source.approved_by=auth.uid() AND OLD.status='draft' AND NEW.status='approved') OR
     (v_source.payment_xid=txid_current() AND v_source.payment_actor=auth.uid() AND OLD.status='approved' AND NEW.status='paid') OR
     (v_source.return_xid=txid_current() AND v_source.return_actor=auth.uid() AND OLD.status='approved' AND NEW.status='draft')) THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND v_source.refresh_xid=txid_current() AND v_source.refresh_actor=auth.uid() AND OLD.status='draft' AND NEW.status='draft'
     AND (to_jsonb(NEW)-ARRAY['gross_pay','bale_deduction','net_pay','days_worked','hours_worked'])
       IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['gross_pay','bale_deduction','net_pay','days_worked','hours_worked']) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Weekly source-bound voucher is frozen outside the reviewed workflow' USING ERRCODE='22023';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_weekly_worker_draft() FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.return_weekly_worker_to_draft(p_request uuid,p_id uuid,p_expected_revision bigint,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_source public.weekly_worker_draft_sources%ROWTYPE; v_pay public.payroll%ROWTYPE; v_after public.payroll%ROWTYPE;
 v_previous public.weekly_worker_approval_returns%ROWTYPE; v_reason text; v_email text;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN
  RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Weekly return requires read committed isolation' USING ERRCODE='P1002'; END IF;
 IF p_request IS NULL OR p_id IS NULL OR p_expected_revision IS NULL OR p_expected_revision<0 OR p_expected_revision>=9223372036854775807
  OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 500 THEN
  RAISE EXCEPTION 'Choose a voucher, revision, request ID and reason' USING ERRCODE='22023'; END IF;
 v_reason:=btrim(p_reason);
 PERFORM pg_catalog.set_config('lock_timeout','3s',true);
 LOCK TABLE public.users,public.workers,public.projects,public.attendance,public.attendance_time_details,
  public.worker_allowances,public.advances,public.advance_requests,public.payroll,public.weekly_worker_draft_sources,
  public.payroll_payment_dates,public.weekly_worker_paid_allocations,public.weekly_worker_draft_refreshes,
  public.weekly_worker_approval_returns IN SHARE ROW EXCLUSIVE MODE;
 -- The actor's role may have changed while this statement waited for locks.
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN
  RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 SELECT * INTO v_previous FROM public.weekly_worker_approval_returns WHERE request_id=p_request;
 IF FOUND THEN
  IF (v_previous.payroll_id,v_previous.actor_id,v_previous.expected_revision,v_previous.reason) IS DISTINCT FROM (p_id,auth.uid(),p_expected_revision,v_reason) THEN
   RAISE EXCEPTION 'Return request ID used for a different action' USING ERRCODE='22023'; END IF;
  RETURN jsonb_build_object('replayed',true,'payroll_id',p_id,'revision',v_previous.new_revision);
 END IF;
 SELECT * INTO v_source FROM public.weekly_worker_draft_sources WHERE payroll_id=p_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Weekly source-bound voucher unavailable' USING ERRCODE='P0002'; END IF;
 SELECT * INTO v_pay FROM public.payroll WHERE id=p_id FOR UPDATE;
 IF NOT FOUND OR v_pay.worker_id IS DISTINCT FROM v_source.worker_id OR v_pay.period_start IS DISTINCT FROM v_source.period_start OR v_pay.period_end IS DISTINCT FROM v_source.period_start+6 THEN
  RAISE EXCEPTION 'Weekly voucher changed; review' USING ERRCODE='40001'; END IF;
 IF v_source.draft_revision<>p_expected_revision THEN RAISE EXCEPTION 'Voucher revision changed; review' USING ERRCODE='40001'; END IF;
 IF v_pay.status<>'approved' OR v_source.approved_by IS NULL OR v_source.approved_at IS NULL OR v_source.approval_xid IS NOT NULL
  OR v_source.payment_actor IS NOT NULL OR v_source.payment_xid IS NOT NULL OR v_source.refresh_actor IS NOT NULL OR v_source.refresh_xid IS NOT NULL
  OR v_source.return_actor IS NOT NULL OR v_source.return_xid IS NOT NULL
  OR EXISTS(SELECT 1 FROM public.payroll_payment_dates WHERE payroll_id=p_id)
  OR EXISTS(SELECT 1 FROM public.weekly_worker_paid_allocations WHERE payroll_id=p_id) THEN
  RAISE EXCEPTION 'Only an approved voucher without recorded payment may return to draft' USING ERRCODE='22023'; END IF;
 IF v_pay.gross_pay IS DISTINCT FROM (v_source.calculation->>'gross')::numeric OR v_pay.bale_deduction IS DISTINCT FROM (v_source.calculation->>'bale')::numeric
  OR v_pay.other_deductions IS DISTINCT FROM 0::numeric OR v_pay.net_pay IS DISTINCT FROM (v_source.calculation->>'net')::numeric
  OR v_pay.days_worked IS DISTINCT FROM round((v_source.calculation->>'regular_hours')::numeric/8,2)
  OR v_pay.hours_worked IS DISTINCT FROM (v_source.calculation->>'regular_hours')::numeric+(v_source.calculation->>'overtime_hours')::numeric THEN
  RAISE EXCEPTION 'Weekly voucher totals changed; investigate' USING ERRCODE='40001'; END IF;
 UPDATE public.weekly_worker_draft_sources SET return_xid=txid_current(),return_actor=auth.uid() WHERE payroll_id=p_id;
 UPDATE public.payroll SET status='draft' WHERE id=p_id RETURNING * INTO v_after;
 UPDATE public.weekly_worker_draft_sources SET approved_by=NULL,approved_at=NULL,draft_revision=p_expected_revision+1,return_xid=NULL,return_actor=NULL WHERE payroll_id=p_id;
 INSERT INTO public.weekly_worker_approval_returns(request_id,payroll_id,actor_id,expected_revision,new_revision,reason,previous_approved_by,previous_approved_at,approved_payroll,approved_sources,approved_calculation)
 VALUES(p_request,p_id,auth.uid(),p_expected_revision,p_expected_revision+1,v_reason,v_source.approved_by,v_source.approved_at,to_jsonb(v_pay),v_source.source_snapshot,v_source.calculation);
 SELECT email INTO v_email FROM public.users WHERE id=auth.uid();
 INSERT INTO public.audit_log(actor_id,actor_email,action,table_name,record_id,before_row,after_row)
 VALUES(auth.uid(),v_email,'update','payroll',p_id,to_jsonb(v_pay),to_jsonb(v_after));
 RETURN jsonb_build_object('replayed',false,'payroll_id',p_id,'revision',p_expected_revision+1);
END;
$$;
REVOKE ALL ON FUNCTION public.return_weekly_worker_to_draft(uuid,uuid,bigint,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.return_weekly_worker_to_draft(uuid,uuid,bigint,text) TO authenticated;
DO $$ BEGIN IF has_function_privilege('anon','public.return_weekly_worker_to_draft(uuid,uuid,bigint,text)','EXECUTE') OR has_function_privilege('service_role','public.return_weekly_worker_to_draft(uuid,uuid,bigint,text)','EXECUTE') THEN RAISE EXCEPTION 'Unexpected inherited return privilege'; END IF; END $$;

-- Revision bind payment too: an old payment screen must not pay a voucher
-- returned, refreshed and reapproved since the amount was reviewed. Replays
-- of an already recorded payment are allowed only for the same revision.
ALTER FUNCTION public.record_weekly_worker_payment(uuid,date) RENAME TO weekly_worker_payment_internal;
REVOKE ALL ON FUNCTION public.weekly_worker_payment_internal(uuid,date) FROM PUBLIC,anon,authenticated,service_role;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r(role_name) WHERE has_function_privilege(r.role_name,'public.weekly_worker_payment_internal(uuid,date)','EXECUTE')) THEN RAISE EXCEPTION 'Unexpected inherited internal payment privilege'; END IF; END $$;
CREATE FUNCTION public.record_weekly_worker_payment(p_id uuid,p_payment_date date,p_expected_revision bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_revision bigint;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Weekly payment requires read committed isolation' USING ERRCODE='P1002'; END IF;
 IF p_id IS NULL OR p_expected_revision IS NULL OR p_expected_revision<0 THEN RAISE EXCEPTION 'Choose a voucher and reviewed revision' USING ERRCODE='22023'; END IF;
 PERFORM pg_catalog.set_config('lock_timeout','3s',true);
 LOCK TABLE public.users,public.workers,public.projects,public.attendance,public.attendance_time_details,public.worker_allowances,
  public.advances,public.advance_requests,public.payroll,public.weekly_worker_draft_sources,public.payroll_payment_dates,public.weekly_worker_paid_allocations IN SHARE ROW EXCLUSIVE MODE;
 -- The actor's role may have changed while this statement waited for locks.
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN
  RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 SELECT draft_revision INTO v_revision FROM public.weekly_worker_draft_sources WHERE payroll_id=p_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Weekly source-bound voucher unavailable' USING ERRCODE='P0002'; END IF;
 IF v_revision<>p_expected_revision THEN RAISE EXCEPTION 'Voucher revision changed; review before recording payment' USING ERRCODE='40001'; END IF;
 RETURN public.weekly_worker_payment_internal(p_id,p_payment_date);
END;
$$;
REVOKE ALL ON FUNCTION public.record_weekly_worker_payment(uuid,date,bigint) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.record_weekly_worker_payment(uuid,date,bigint) TO authenticated;
DO $$ BEGIN IF has_function_privilege('anon','public.record_weekly_worker_payment(uuid,date,bigint)','EXECUTE') OR has_function_privilege('service_role','public.record_weekly_worker_payment(uuid,date,bigint)','EXECUTE') THEN RAISE EXCEPTION 'Unexpected inherited payment privilege'; END IF; END $$;


-- supabase/drafts/weekly_bale_schedule.sql sha256 f02c9b9b3d7238a0045a3a2a4552e9214609713a29f5f9a1310e05da091ed6a8
-- DRAFT ONLY: never install alone or on a shared database. This experiment
-- applies only to requests newly created after installation. Old open requests
-- must be reconciled separately, not silently expired or paid. Requires the
-- reviewed site guard, audit/notification triggers and legacy Bale payment
-- guard. A projected expiry is NOT a persisted rejection or notification; a
-- compatible UI and a reliable scheduler/materializer remain required.

DO $$ BEGIN
 IF to_regprocedure('public.guard_advance_request_site()') IS NULL OR
    to_regprocedure('public.guard_new_advance_finalized_payroll()') IS NULL OR
    NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.advance_requests'::regclass AND tgname='guard_advance_request_site' AND tgenabled='O' AND NOT tgisinternal) OR
    NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.advances'::regclass AND tgname='guard_new_advance_finalized_payroll' AND tgenabled='O' AND NOT tgisinternal) THEN
  RAISE EXCEPTION 'Reviewed request and payroll guards required'; END IF;
END $$;

-- Kept private so callers cannot supply or forge the policy clock. The actual
-- clock is read after lock waits rather than trusting transaction start time.
CREATE FUNCTION public.weekly_bale_clock() RETURNS timestamptz
LANGUAGE sql VOLATILE SET search_path='' AS $$ SELECT pg_catalog.clock_timestamp() $$;
REVOKE ALL ON FUNCTION public.weekly_bale_clock() FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.weekly_bale_week(p_at timestamptz) RETURNS date
LANGUAGE sql IMMUTABLE STRICT SET search_path='' AS $$
 SELECT ((p_at AT TIME ZONE 'Asia/Manila')::date - extract(dow FROM (p_at AT TIME ZONE 'Asia/Manila')::date)::int)::date
$$;
REVOKE ALL ON FUNCTION public.weekly_bale_week(timestamptz) FROM PUBLIC,anon,authenticated,service_role;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r(role_name)
  WHERE has_function_privilege(r.role_name,'public.weekly_bale_clock()','EXECUTE') OR has_function_privilege(r.role_name,'public.weekly_bale_week(timestamptz)','EXECUTE')) THEN
  RAISE EXCEPTION 'Unexpected inherited private weekly Bale clock privilege'; END IF;
END $$;

CREATE TABLE public.weekly_bale_requests (
 request_id uuid PRIMARY KEY REFERENCES public.advance_requests(id) ON DELETE RESTRICT,
 period_start date NOT NULL CHECK (extract(dow FROM period_start)=0),
 scheduled_at timestamptz NOT NULL,
 release_xid bigint,
 release_actor uuid REFERENCES public.users(id) ON DELETE RESTRICT
);
ALTER TABLE public.weekly_bale_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.weekly_bale_requests FROM PUBLIC,anon,authenticated,service_role;
DO $$ BEGIN
 IF has_table_privilege('anon','public.weekly_bale_requests','SELECT,INSERT,UPDATE,DELETE,TRUNCATE') OR
    has_table_privilege('authenticated','public.weekly_bale_requests','SELECT,INSERT,UPDATE,DELETE,TRUNCATE') OR
    has_table_privilege('service_role','public.weekly_bale_requests','SELECT,INSERT,UPDATE,DELETE,TRUNCATE') OR
    EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid='public.weekly_bale_requests'::regclass AND a.attnum>0 AND NOT a.attisdropped AND
      (has_column_privilege('anon',a.attrelid,a.attname,'SELECT,INSERT,UPDATE') OR has_column_privilege('authenticated',a.attrelid,a.attname,'SELECT,INSERT,UPDATE') OR has_column_privilege('service_role',a.attrelid,a.attname,'SELECT,INSERT,UPDATE'))) THEN
  RAISE EXCEPTION 'Unexpected inherited weekly Bale privileges'; END IF;
END $$;

CREATE FUNCTION public.guard_weekly_bale_submission() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_now timestamptz:=public.weekly_bale_clock();
BEGIN
 IF extract(dow FROM (v_now AT TIME ZONE 'Asia/Manila')::date)>2 THEN
  RAISE EXCEPTION 'Bale requests are open Sunday through Tuesday Philippine time' USING ERRCODE='22023'; END IF;
 NEW.created_at:=v_now; NEW.updated_at:=v_now;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_weekly_bale_submission() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER guard_weekly_bale_submission BEFORE INSERT ON public.advance_requests FOR EACH ROW EXECUTE FUNCTION public.guard_weekly_bale_submission();

CREATE FUNCTION public.register_weekly_bale_submission() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_now timestamptz:=public.weekly_bale_clock();
BEGIN
 -- If a statement straddles midnight or waits on locks, reject instead of
 -- attributing an insertion to a different week/window than its policy check.
 IF extract(dow FROM (v_now AT TIME ZONE 'Asia/Manila')::date)>2 OR public.weekly_bale_week(NEW.created_at)<>public.weekly_bale_week(v_now) THEN RAISE EXCEPTION 'Bale request window closed; retry in the next window' USING ERRCODE='22023'; END IF;
 INSERT INTO public.weekly_bale_requests(request_id,period_start,scheduled_at) VALUES(NEW.id,public.weekly_bale_week(v_now),NEW.created_at);
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.register_weekly_bale_submission() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER register_weekly_bale_submission AFTER INSERT ON public.advance_requests FOR EACH ROW EXECUTE FUNCTION public.register_weekly_bale_submission();

CREATE FUNCTION public.guard_weekly_bale_transition() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_rule public.weekly_bale_requests%ROWTYPE; v_now timestamptz:=public.weekly_bale_clock();v_date date:=(v_now AT TIME ZONE 'Asia/Manila')::date;
BEGIN
 SELECT * INTO v_rule FROM public.weekly_bale_requests WHERE request_id=OLD.id;
 IF NOT FOUND THEN RETURN NEW; END IF; -- Existing historical requests remain untouched.
 IF (to_jsonb(NEW)-ARRAY['status','approved_by','approved_at','rejected_by','rejected_at','issued_by','issued_at','issued_advance_id','updated_at']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['status','approved_by','approved_at','rejected_by','rejected_at','issued_by','issued_at','issued_advance_id','updated_at']) THEN
  RAISE EXCEPTION 'Weekly request details are immutable' USING ERRCODE='22023'; END IF;
 IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RAISE EXCEPTION 'Weekly request requires a controlled status transition' USING ERRCODE='22023'; END IF;
 IF OLD.status='pending_approval' AND NEW.status IN ('approved_pending_payment','rejected') THEN
  IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access required' USING ERRCODE='42501'; END IF;
  IF v_date NOT BETWEEN v_rule.period_start AND v_rule.period_start+2 THEN RAISE EXCEPTION 'Request expired after Tuesday; cannot review this period' USING ERRCODE='22023'; END IF;
  IF NEW.status='approved_pending_payment' AND (NEW.approved_by IS DISTINCT FROM auth.uid() OR NEW.approved_at IS NULL) OR
     NEW.status='rejected' AND (NEW.rejected_by IS DISTINCT FROM auth.uid() OR NEW.rejected_at IS NULL) THEN RAISE EXCEPTION 'Decision evidence missing' USING ERRCODE='22023'; END IF;
 ELSIF OLD.status='approved_pending_payment' AND NEW.status='issued' THEN
  IF v_date<>v_rule.period_start+3 OR v_rule.release_xid IS DISTINCT FROM txid_current() OR v_rule.release_actor IS DISTINCT FROM auth.uid() OR
   NEW.issued_by IS DISTINCT FROM auth.uid() OR NEW.issued_at IS NULL OR (NEW.issued_at AT TIME ZONE 'Asia/Manila')::date<>v_date OR
   NOT EXISTS(SELECT 1 FROM public.advances a WHERE a.id=NEW.issued_advance_id AND a.worker_id=NEW.worker_id AND a.project_id=NEW.project_id AND a.date=v_date AND a.amount=NEW.requested_amount AND a.amount_deducted=0 AND a.status='active') THEN
   RAISE EXCEPTION 'Use the controlled Wednesday external-release action; refresh the page and check the records before retrying. If cash was already given, do not pay again; ask the Founder to review' USING ERRCODE='22023'; END IF;
 ELSE RAISE EXCEPTION 'Unsupported weekly Bale transition' USING ERRCODE='22023'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_weekly_bale_transition() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER guard_weekly_bale_transition BEFORE UPDATE ON public.advance_requests FOR EACH ROW EXECUTE FUNCTION public.guard_weekly_bale_transition();

-- Founder or currently assigned Supervisor can record an actual same-week
-- Wednesday release, never send money. Request, advance, audit and existing
-- notification trigger commit together; no duplicate ledger row on retry.
CREATE FUNCTION public.record_weekly_bale_release(p_request_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_request public.advance_requests%ROWTYPE;v_rule public.weekly_bale_requests%ROWTYPE;v_worker uuid;v_advance public.advances%ROWTYPE;v_now timestamptz;v_date date;v_email text;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Authorized access required' USING ERRCODE='42501'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Bale release requires read committed isolation' USING ERRCODE='P1002'; END IF;
 -- Pin the actor's profile before the worker/request locks. Role changes must
 -- wait for this decision, and a role revoked while waiting must fail closed.
 PERFORM pg_catalog.set_config('lock_timeout','3s',true);
 PERFORM 1 FROM public.users WHERE id=auth.uid() FOR SHARE;
 IF NOT FOUND OR auth.uid() IS NULL OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Authorized access required' USING ERRCODE='42501'; END IF;
 SELECT worker_id INTO v_worker FROM public.advance_requests WHERE id=p_request_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Request unavailable' USING ERRCODE='P0002'; END IF;
 -- Shared worker lock serializes with the guarded payroll paid transition.
 PERFORM 1 FROM public.workers WHERE id=v_worker FOR UPDATE;
 SELECT * INTO v_request FROM public.advance_requests WHERE id=p_request_id AND worker_id=v_worker FOR UPDATE;
 SELECT * INTO v_rule FROM public.weekly_bale_requests WHERE request_id=p_request_id FOR UPDATE;
 IF v_request.id IS NULL OR v_rule.request_id IS NULL THEN RAISE EXCEPTION 'Weekly request unavailable; review legacy records separately' USING ERRCODE='P0002'; END IF;
 IF auth.uid() IS NULL OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Authorized access required' USING ERRCODE='42501'; END IF;
 IF NOT coalesce(public.is_founder(),false) THEN
  PERFORM 1 FROM public.project_supervisors WHERE project_id=v_request.project_id AND supervisor_id=auth.uid() FOR KEY SHARE;
  IF NOT FOUND OR NOT coalesce(public.current_user_role()='supervisor',false) OR NOT coalesce(public.is_supervisor_assigned(v_request.project_id),false) THEN RAISE EXCEPTION 'Site authorization required' USING ERRCODE='42501'; END IF;
 END IF;
 IF v_request.status='issued' THEN
  SELECT * INTO v_advance FROM public.advances WHERE id=v_request.issued_advance_id;
  IF v_rule.release_actor IS NULL OR v_rule.release_xid IS NOT NULL OR v_advance.id IS NULL OR v_advance.worker_id<>v_request.worker_id OR v_advance.project_id<>v_request.project_id OR v_advance.amount<>v_request.requested_amount OR v_advance.date<>v_rule.period_start+3 THEN
   RAISE EXCEPTION 'Recorded release needs reconciliation' USING ERRCODE='22023'; END IF;
  RETURN jsonb_build_object('outcome','already_recorded','request_id',p_request_id,'advance_id',v_advance.id);
 END IF;
 v_now:=public.weekly_bale_clock();v_date:=(v_now AT TIME ZONE 'Asia/Manila')::date;
 IF v_request.status<>'approved_pending_payment' OR v_date<>v_rule.period_start+3 THEN RAISE EXCEPTION 'Only an approved same-week Wednesday release can be recorded' USING ERRCODE='22023'; END IF;
 -- A request can outlive the worker's assignment. Pinning the worker above
 -- serializes with the reviewed guarded move/removal paths; a site Supervisor
 -- must not record a NEW release for somebody who has since moved or been
 -- archived. Founder retains authority to resolve an approved request. The
 -- already-issued replay above intentionally remains readable after a move.
 IF NOT coalesce(public.is_founder(),false) AND (
  NOT EXISTS(SELECT 1 FROM public.workers w WHERE w.id=v_worker AND w.active IS TRUE)
  OR EXISTS(SELECT 1 FROM public.users u WHERE u.id=v_worker AND u.role='supervisor')
  OR NOT EXISTS(SELECT 1 FROM public.project_worker_assignments a WHERE a.worker_id=v_worker AND a.project_id=v_request.project_id AND a.active IS TRUE)
  OR EXISTS(SELECT 1 FROM public.project_worker_assignments a WHERE a.worker_id=v_worker AND a.project_id<>v_request.project_id AND a.active IS TRUE)
 ) THEN RAISE EXCEPTION 'Worker is unavailable, is a Supervisor, or is no longer uniquely assigned to this site; Founder review required' USING ERRCODE='42501'; END IF;
 IF EXISTS(SELECT 1 FROM public.payroll p WHERE p.worker_id=v_worker AND v_date BETWEEN p.period_start AND p.period_end AND p.status IN ('approved','paid')) THEN RAISE EXCEPTION 'Finalized payroll covers this release; review the original period' USING ERRCODE='22023'; END IF;
 INSERT INTO public.advances(worker_id,project_id,amount,amount_deducted,reason,date,status)
 VALUES(v_worker,v_request.project_id,v_request.requested_amount,0,'Approved Bale request',v_date,'active') RETURNING * INTO v_advance;
 UPDATE public.weekly_bale_requests SET release_xid=txid_current(),release_actor=auth.uid() WHERE request_id=p_request_id;
 UPDATE public.advance_requests SET status='issued',issued_by=auth.uid(),issued_at=v_now,issued_advance_id=v_advance.id,updated_at=v_now WHERE id=p_request_id;
 SELECT email INTO v_email FROM public.users WHERE id=auth.uid();
 INSERT INTO public.audit_log(actor_id,actor_email,action,table_name,record_id,before_row,after_row) VALUES(auth.uid(),v_email,'insert','advances',v_advance.id,NULL,to_jsonb(v_advance));
 UPDATE public.weekly_bale_requests SET release_xid=NULL WHERE request_id=p_request_id;
 RETURN jsonb_build_object('outcome','updated','request_id',p_request_id,'advance_id',v_advance.id);
END $$;
REVOKE ALL ON FUNCTION public.record_weekly_bale_release(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.record_weekly_bale_release(uuid) TO authenticated;

-- Virtual automatic expiry: the underlying row is intentionally untouched.
-- Compatible clients must query this rather than the old status column. No
-- scheduler or rejection notification is installed by this experiment.
CREATE FUNCTION public.weekly_bale_effective_status(p_request_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r public.advance_requests%ROWTYPE; w public.weekly_bale_requests%ROWTYPE; v_date date:=(public.weekly_bale_clock() AT TIME ZONE 'Asia/Manila')::date;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Authorized access required' USING ERRCODE='42501'; END IF;
 SELECT * INTO r FROM public.advance_requests WHERE id=p_request_id;
 IF NOT FOUND OR NOT (coalesce(public.is_founder(),false) OR r.submitted_by=auth.uid() OR coalesce(public.current_user_role()='supervisor' AND public.is_supervisor_assigned(r.project_id),false)) THEN RAISE EXCEPTION 'Request unavailable' USING ERRCODE='P0002'; END IF;
 SELECT * INTO w FROM public.weekly_bale_requests WHERE request_id=r.id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Legacy request requires separate review' USING ERRCODE='P0002'; END IF;
 RETURN jsonb_build_object('request_id',r.id,'period_start',w.period_start,'stored_status',r.status,
  'effective_status',CASE WHEN r.status='pending_approval' AND v_date>w.period_start+2 THEN 'expired_unapproved' ELSE r.status END,
  'release_date',w.period_start+3);
END $$;
REVOKE ALL ON FUNCTION public.weekly_bale_effective_status(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.weekly_bale_effective_status(uuid) TO authenticated;


-- supabase/drafts/weekly_bale_expiration.sql sha256 12250593db0d1be746d8bf3af4a548d69b78059c3515716ea27d3d82253b0a03
-- DRAFT ONLY. Requires the exact reviewed weekly_bale_schedule.sql candidate
-- and the original request audit/notification schema; not a standalone migration.
-- This adds a bounded worker for durable automatic rejections but does NOT
-- install a scheduler, grant it to API roles, or handle legacy requests.
-- A reliable operator-managed scheduler, correct job identity, downtime/retry,
-- old clients, Auth, audit and catalog must be reviewed before any deployment.

ALTER TABLE public.weekly_bale_requests ADD COLUMN expired_at timestamptz, ADD COLUMN expiry_xid bigint;
ALTER TABLE public.advance_requests ADD COLUMN auto_expired boolean NOT NULL DEFAULT false;
ALTER TABLE public.advance_requests DROP CONSTRAINT advance_request_rejection_fields;
ALTER TABLE public.advance_requests ADD CONSTRAINT advance_request_rejection_fields CHECK (
 (NOT auto_expired OR status='rejected') AND
 (status<>'rejected' OR (rejected_at IS NOT NULL AND ((rejected_by IS NOT NULL AND NOT auto_expired) OR (rejected_by IS NULL AND auto_expired))))
);
-- Rejected-by NULL is reserved for the narrow marked automatic transition by
-- the trigger below. Legacy privileged modifications remain outside its scope.
CREATE OR REPLACE FUNCTION public.guard_weekly_bale_transition() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_rule public.weekly_bale_requests%ROWTYPE; v_now timestamptz:=public.weekly_bale_clock();v_date date:=(v_now AT TIME ZONE 'Asia/Manila')::date;
BEGIN
 SELECT * INTO v_rule FROM public.weekly_bale_requests WHERE request_id=OLD.id;
 IF NOT FOUND THEN RETURN NEW; END IF;
 IF (to_jsonb(NEW)-ARRAY['status','approved_by','approved_at','rejected_by','rejected_at','issued_by','issued_at','issued_advance_id','updated_at','auto_expired']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['status','approved_by','approved_at','rejected_by','rejected_at','issued_by','issued_at','issued_advance_id','updated_at','auto_expired']) THEN
  RAISE EXCEPTION 'Weekly request details are immutable' USING ERRCODE='22023'; END IF;
 IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RAISE EXCEPTION 'Weekly request requires a controlled status transition' USING ERRCODE='22023'; END IF;
 IF OLD.status='pending_approval' AND NEW.status='rejected' AND v_rule.expiry_xid=txid_current() AND v_rule.expired_at IS NOT NULL THEN
  IF auth.uid() IS NOT NULL OR v_date<=v_rule.period_start+2 OR NEW.rejected_by IS NOT NULL OR NOT NEW.auto_expired OR NEW.rejected_at IS DISTINCT FROM v_rule.expired_at THEN
   RAISE EXCEPTION 'Automatic expiry evidence invalid' USING ERRCODE='22023'; END IF;
 ELSIF OLD.status='pending_approval' AND NEW.status IN ('approved_pending_payment','rejected') THEN
  IF NEW.auto_expired IS DISTINCT FROM OLD.auto_expired THEN RAISE EXCEPTION 'Automatic expiry flag cannot be set by a user' USING ERRCODE='22023'; END IF;
  IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access required' USING ERRCODE='42501'; END IF;
  IF v_date NOT BETWEEN v_rule.period_start AND v_rule.period_start+2 THEN RAISE EXCEPTION 'Request expired after Tuesday; cannot review this period' USING ERRCODE='22023'; END IF;
  IF NEW.status='approved_pending_payment' AND (NEW.approved_by IS DISTINCT FROM auth.uid() OR NEW.approved_at IS NULL) OR
     NEW.status='rejected' AND (NEW.rejected_by IS DISTINCT FROM auth.uid() OR NEW.rejected_at IS NULL) THEN RAISE EXCEPTION 'Decision evidence missing' USING ERRCODE='22023'; END IF;
 ELSIF OLD.status='approved_pending_payment' AND NEW.status='issued' THEN
  IF NEW.auto_expired IS DISTINCT FROM OLD.auto_expired THEN RAISE EXCEPTION 'Automatic expiry flag cannot be set by a user' USING ERRCODE='22023'; END IF;
  IF v_date<>v_rule.period_start+3 OR v_rule.release_xid IS DISTINCT FROM txid_current() OR v_rule.release_actor IS DISTINCT FROM auth.uid() OR
   NEW.issued_by IS DISTINCT FROM auth.uid() OR NEW.issued_at IS NULL OR (NEW.issued_at AT TIME ZONE 'Asia/Manila')::date<>v_date OR
   NOT EXISTS(SELECT 1 FROM public.advances a WHERE a.id=NEW.issued_advance_id AND a.worker_id=NEW.worker_id AND a.project_id=NEW.project_id AND a.date=v_date AND a.amount=NEW.requested_amount AND a.amount_deducted=0 AND a.status='active') THEN
   RAISE EXCEPTION 'Use the controlled Wednesday external-release action; refresh the page and check the records before retrying. If cash was already given, do not pay again; ask the Founder to review' USING ERRCODE='22023'; END IF;
 ELSE RAISE EXCEPTION 'Unsupported weekly Bale transition' USING ERRCODE='22023'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_weekly_bale_transition() FROM PUBLIC,anon,authenticated,service_role;

-- The legacy audit trigger otherwise attributes unauthenticated updates to the
-- submitter. A system expiry must never be misrepresented as their decision.
CREATE OR REPLACE FUNCTION public.audit_advance_request_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid;v_email text;v_action text;v_before jsonb;
BEGIN
 IF TG_OP='UPDATE' AND auth.uid() IS NULL AND EXISTS(SELECT 1 FROM public.weekly_bale_requests w WHERE w.request_id=NEW.id AND w.expiry_xid=txid_current() AND w.expired_at IS NOT NULL) THEN
  v_actor:=NULL;
 ELSE v_actor:=coalesce(auth.uid(),NEW.submitted_by,OLD.submitted_by); END IF;
 SELECT email INTO v_email FROM public.users WHERE id=v_actor;
 IF TG_OP='INSERT' THEN v_action:='insert';v_before:=NULL; ELSE v_action:='update';v_before:=to_jsonb(OLD); END IF;
 INSERT INTO public.audit_log(actor_id,actor_email,action,table_name,record_id,before_row,after_row)
 VALUES(v_actor,v_email,v_action,'advance_requests',NEW.id,v_before,to_jsonb(NEW));
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.audit_advance_request_change() FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.materialize_weekly_bale_expiry(p_limit integer DEFAULT 100) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_id uuid;v_week date;v_now timestamptz;v_count integer:=0;
BEGIN
 IF auth.uid() IS NOT NULL THEN RAISE EXCEPTION 'Expiry worker must run as a system job, not a user session' USING ERRCODE='42501'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Expiry requires read committed isolation' USING ERRCODE='P1002'; END IF;
 IF p_limit IS NULL OR p_limit<1 OR p_limit>500 THEN RAISE EXCEPTION 'Invalid expiry batch size' USING ERRCODE='22023'; END IF;
 FOR v_id,v_week IN
  SELECT r.id,w.period_start FROM public.advance_requests r JOIN public.weekly_bale_requests w ON w.request_id=r.id
  WHERE r.status='pending_approval' AND (public.weekly_bale_clock() AT TIME ZONE 'Asia/Manila')::date>w.period_start+2
  ORDER BY w.period_start,r.id LIMIT p_limit FOR UPDATE OF r SKIP LOCKED
 LOOP
  v_now:=public.weekly_bale_clock();
  IF (v_now AT TIME ZONE 'Asia/Manila')::date<=v_week+2 THEN CONTINUE; END IF;
  UPDATE public.weekly_bale_requests SET expired_at=v_now,expiry_xid=txid_current() WHERE request_id=v_id AND expired_at IS NULL AND expiry_xid IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Expiry marker inconsistent; review request' USING ERRCODE='22023'; END IF;
  UPDATE public.advance_requests SET status='rejected',rejected_by=NULL,rejected_at=v_now,updated_at=v_now,auto_expired=true WHERE id=v_id AND status='pending_approval';
  IF NOT FOUND THEN RAISE EXCEPTION 'Expiry request changed; retry' USING ERRCODE='40001'; END IF;
  UPDATE public.weekly_bale_requests SET expiry_xid=NULL WHERE request_id=v_id;
  v_count:=v_count+1;
 END LOOP;
 RETURN v_count;
END $$;
REVOKE ALL ON FUNCTION public.materialize_weekly_bale_expiry(integer) FROM PUBLIC,anon,authenticated,service_role;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r(role_name) WHERE has_function_privilege(r.role_name,'public.materialize_weekly_bale_expiry(integer)','EXECUTE')) THEN
  RAISE EXCEPTION 'Expiry worker exposed through inherited privilege'; END IF;
END $$;


-- supabase/drafts/weekly_bale_release_list.sql sha256 050719166d64f8a242267a0964c0b7a3bcb491d6191a82b1146fb3d2b941e7bf
-- DRAFT ONLY. Requires the exact weekly Bale schedule + expiry drafts.
-- Authorized current-site Supervisors can see approved/issued requests from
-- their sites, not all requests or sites. This does not install a scheduler.
CREATE FUNCTION public.weekly_bale_release_list(p_start date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_count integer; v_items jsonb; v_founder boolean; v_role text;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Authorized access required' USING ERRCODE='42501'; END IF;
 v_founder:=coalesce(public.is_founder(),false);v_role:=public.current_user_role();
 IF NOT v_founder AND v_role IS DISTINCT FROM 'supervisor' THEN RAISE EXCEPTION 'Authorized access required' USING ERRCODE='42501'; END IF;
 IF p_start IS NULL OR p_start<DATE '1900-01-01' OR p_start>DATE '9998-12-24' OR extract(dow FROM p_start)<>0 THEN RAISE EXCEPTION 'Choose a Sunday' USING ERRCODE='22023'; END IF;
 -- Use a single snapshot and reject rather than silently truncate at the cap.
 SELECT count(*)::integer,coalesce(jsonb_agg(jsonb_build_object('request_id',q.id,'worker_id',q.worker_id,'worker_name',q.worker_name,
  'project_id',q.project_id,'project_name',q.project_name,'amount',q.requested_amount::numeric(10,2)::text,'status',q.status,
  'release_date',q.release_date,'issued_advance_id',q.issued_advance_id,'assignment_review_required',q.assignment_review_required) ORDER BY q.project_id,q.worker_name,q.id),'[]'::jsonb)
 INTO v_count,v_items FROM (
  SELECT r.id,r.worker_id,worker.name worker_name,r.project_id,project.name project_name,r.requested_amount,r.status,
   w.period_start+3 release_date,r.issued_advance_id,
   (worker.active IS NOT TRUE OR EXISTS(SELECT 1 FROM public.users u WHERE u.id=r.worker_id AND u.role='supervisor') OR NOT EXISTS(SELECT 1 FROM public.project_worker_assignments a WHERE a.worker_id=r.worker_id AND a.project_id=r.project_id AND a.active IS TRUE)
    OR EXISTS(SELECT 1 FROM public.project_worker_assignments a WHERE a.worker_id=r.worker_id AND a.project_id<>r.project_id AND a.active IS TRUE)) AS assignment_review_required
  FROM public.weekly_bale_requests w JOIN public.advance_requests r ON r.id=w.request_id
  JOIN public.workers worker ON worker.id=r.worker_id JOIN public.projects project ON project.id=r.project_id
  WHERE w.period_start=p_start AND r.status IN ('approved_pending_payment','issued')
   AND (v_founder OR (v_role='supervisor' AND coalesce(public.is_supervisor_assigned(r.project_id),false)))
  ORDER BY r.id LIMIT 501
 ) q;
 IF v_count>500 THEN RAISE EXCEPTION 'Too many weekly requests; use a reviewed paginated interface' USING ERRCODE='54000'; END IF;
 RETURN jsonb_build_object('start',p_start,'end',p_start+6,'items',v_items);
END $$;
REVOKE ALL ON FUNCTION public.weekly_bale_release_list(date) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.weekly_bale_release_list(date) TO authenticated;
DO $$ BEGIN
 IF has_function_privilege('anon','public.weekly_bale_release_list(date)','EXECUTE') OR has_function_privilege('service_role','public.weekly_bale_release_list(date)','EXECUTE') THEN
  RAISE EXCEPTION 'Unexpected inherited weekly release-list privilege'; END IF;
END $$;


-- supabase/drafts/weekly_bale_status_batch.sql sha256 717ced3993cf522553e7e6a3c6b9a8c55924a3138de8858da1c5ce8901b81f13
-- DRAFT ONLY: requires the reviewed weekly Bale schedule and expiry drafts.
-- Bounded status enrichment for IDs already visible in the existing request
-- list. Founder sees all; Supervisor sees only their own submissions, matching
-- existing request RLS. Missing or unauthorized IDs fail the entire request.
-- This read function does not run or schedule expiry.
CREATE FUNCTION public.weekly_bale_status_batch(p_ids uuid[]) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_now timestamptz:=public.weekly_bale_clock(); v_date date:=(v_now AT TIME ZONE 'Asia/Manila')::date;
 v_founder boolean; v_role text; v_count integer; v_items jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Authorized access required' USING ERRCODE='42501'; END IF;
 v_founder:=coalesce(public.is_founder(),false);v_role:=public.current_user_role();
 IF NOT v_founder AND v_role IS DISTINCT FROM 'supervisor' THEN RAISE EXCEPTION 'Authorized access required' USING ERRCODE='42501'; END IF;
 IF p_ids IS NULL OR cardinality(p_ids)>500 OR EXISTS(SELECT 1 FROM unnest(p_ids) x WHERE x IS NULL)
  OR cardinality(p_ids)<>(SELECT count(DISTINCT x) FROM unnest(p_ids) x) THEN RAISE EXCEPTION 'Invalid request ID list' USING ERRCODE='22023'; END IF;
 SELECT count(*)::integer,coalesce(jsonb_agg(jsonb_build_object('id',r.id,'stored_status',r.status,
  'kind',CASE WHEN w.request_id IS NULL THEN 'legacy' ELSE 'weekly' END,'period_start',w.period_start,
  'effective_status',CASE WHEN w.request_id IS NOT NULL AND r.status='pending_approval' AND v_date>w.period_start+2 THEN 'expired_unapproved' ELSE r.status END,
  'auto_expired',r.auto_expired,
  'can_review',coalesce(w.request_id IS NOT NULL AND r.status='pending_approval' AND v_date BETWEEN w.period_start AND w.period_start+2,false)) ORDER BY r.id),'[]'::jsonb)
 INTO v_count,v_items FROM public.advance_requests r LEFT JOIN public.weekly_bale_requests w ON w.request_id=r.id
 WHERE r.id=ANY(p_ids) AND (v_founder OR (v_role='supervisor' AND r.submitted_by=auth.uid()));
 IF v_count<>cardinality(p_ids) THEN RAISE EXCEPTION 'One or more requests are unavailable' USING ERRCODE='P0002'; END IF;
 RETURN jsonb_build_object('as_of',v_now,'items',v_items);
END $$;
REVOKE ALL ON FUNCTION public.weekly_bale_status_batch(uuid[]) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.weekly_bale_status_batch(uuid[]) TO authenticated;
DO $$ BEGIN
 IF has_function_privilege('anon','public.weekly_bale_status_batch(uuid[])','EXECUTE') OR has_function_privilege('service_role','public.weekly_bale_status_batch(uuid[])','EXECUTE') THEN
  RAISE EXCEPTION 'Unexpected inherited weekly Bale status privilege'; END IF;
END $$;


-- supabase/drafts/weekly_bale_scheduler.sql sha256 6e134b7a3eb61243151e7019ab93068b38fd3d5ef7a42c00016aef6318146b94
-- DRAFT ONLY. This is the bounded scheduler runner and health view, not an
-- installed job. Requires the reviewed schedule + expiry candidates and their
-- exact dependencies. It neither creates an extension nor schedules anything.
-- No API/service role may invoke the worker. A separate, reviewed pg_cron
-- installation must run under an authorized database operator identity.

CREATE TABLE public.weekly_bale_expiry_health (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 last_success timestamptz NOT NULL,
 processed integer NOT NULL CHECK(processed>=0 AND processed<=500),
 remaining_due bigint NOT NULL CHECK(remaining_due>=0)
);
ALTER TABLE public.weekly_bale_expiry_health ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.weekly_bale_expiry_health FROM PUBLIC,anon,authenticated,service_role;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r(role_name)
  WHERE has_table_privilege(r.role_name,'public.weekly_bale_expiry_health','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
   OR EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid='public.weekly_bale_expiry_health'::regclass AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege(r.role_name,a.attrelid,a.attname,'SELECT,INSERT,UPDATE'))) THEN
  RAISE EXCEPTION 'Unexpected inherited weekly Bale scheduler table privilege'; END IF;
END $$;

CREATE FUNCTION public.run_weekly_bale_expiry_job() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_total integer:=0;v_n integer;v_due bigint;v_now timestamptz;
BEGIN
 IF auth.uid() IS NOT NULL THEN RAISE EXCEPTION 'Expiry job must not use a user session' USING ERRCODE='42501'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Expiry job requires read committed isolation' USING ERRCODE='P1002'; END IF;
 IF NOT pg_catalog.pg_try_advisory_xact_lock(733829,24001) THEN RETURN jsonb_build_object('outcome','already_running'); END IF;
 PERFORM pg_catalog.set_config('lock_timeout','3s',true);
 -- A maximum of 500 rows per job transaction. Later executions catch up after
 -- downtime and retry rows skipped because they were locked by another writer.
 FOR i IN 1..5 LOOP
  v_n:=public.materialize_weekly_bale_expiry(100);v_total:=v_total+v_n;
  EXIT WHEN v_n<100;
 END LOOP;
 v_now:=public.weekly_bale_clock();
 SELECT count(*) INTO v_due FROM public.advance_requests r JOIN public.weekly_bale_requests w ON w.request_id=r.id
  WHERE r.status='pending_approval' AND (v_now AT TIME ZONE 'Asia/Manila')::date>w.period_start+2;
 INSERT INTO public.weekly_bale_expiry_health(singleton,last_success,processed,remaining_due) VALUES(true,v_now,v_total,v_due)
 ON CONFLICT(singleton) DO UPDATE SET last_success=EXCLUDED.last_success,processed=EXCLUDED.processed,remaining_due=EXCLUDED.remaining_due;
 RETURN jsonb_build_object('outcome','completed','processed',v_total,'remaining_due',v_due);
END $$;
REVOKE ALL ON FUNCTION public.run_weekly_bale_expiry_job() FROM PUBLIC,anon,authenticated,service_role;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r(role_name) WHERE has_function_privilege(r.role_name,'public.run_weekly_bale_expiry_job()','EXECUTE')) THEN
  RAISE EXCEPTION 'Expiry runner exposed through inherited privilege'; END IF;
END $$;

-- Health is an observation, not proof that cron is configured or that any
-- notification reached a user. Backlog is queried afresh, not from the last run.
CREATE FUNCTION public.weekly_bale_expiry_health_status() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_now timestamptz:=public.weekly_bale_clock();v_health public.weekly_bale_expiry_health%ROWTYPE;v_due bigint;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access required' USING ERRCODE='42501'; END IF;
 SELECT * INTO v_health FROM public.weekly_bale_expiry_health WHERE singleton;
 SELECT count(*) INTO v_due FROM public.advance_requests r JOIN public.weekly_bale_requests w ON w.request_id=r.id
  WHERE r.status='pending_approval' AND (v_now AT TIME ZONE 'Asia/Manila')::date>w.period_start+2;
 RETURN jsonb_build_object('checked_at',v_now,'last_success',v_health.last_success,'last_processed',v_health.processed,'last_remaining_due',v_health.remaining_due,'current_remaining_due',v_due,
  'healthy',coalesce(v_health.last_success<=v_now AND v_health.last_success>=v_now-interval '3 minutes' AND v_due=0,false));
END $$;
REVOKE ALL ON FUNCTION public.weekly_bale_expiry_health_status() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.weekly_bale_expiry_health_status() TO authenticated;
DO $$ BEGIN
 IF has_function_privilege('anon','public.weekly_bale_expiry_health_status()','EXECUTE') OR has_function_privilege('service_role','public.weekly_bale_expiry_health_status()','EXECUTE') THEN
  RAISE EXCEPTION 'Unexpected inherited expiry health privilege'; END IF;
END $$;


-- supabase/drafts/attendance_history_time_batch.sql sha256 39ddf4e245e756bf7d343ef53ee8489315e3b4a557b2ac22c5551b37bb75f254
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


-- supabase/drafts/supervisor_leave_notification.sql sha256 da73f80b03eb9a2ee94d95f41a3b6763ceecf23702545884052e32751b91c6c1
-- UNINSTALLED DRAFT. Requires the separately reviewed Supervisor RPC rollout.
-- A live pending-queue indicator, not an event delivery or read receipt.
-- Run only in one reviewed transaction on a compatible target, never blindly.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
DO $preflight$
BEGIN
 IF to_regclass('public.supervisor_leave_requests') IS NULL
    OR to_regprocedure('public.supervisor_leave_list(integer)') IS NULL
    OR to_regprocedure('public.review_supervisor_leave(uuid,text)') IS NULL
    OR to_regprocedure('public.is_founder()') IS NULL
    OR to_regprocedure('public.session_assurance_satisfied()') IS NULL
    OR to_regprocedure('auth.uid()') IS NULL THEN
  RAISE EXCEPTION 'Reviewed Supervisor leave prerequisites missing';
 END IF;
 IF to_regprocedure('public.supervisor_leave_pending_summary()') IS NOT NULL THEN
  RAISE EXCEPTION 'Supervisor leave summary already exists';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class WHERE oid='public.supervisor_leave_requests'::regclass AND relkind='r' AND relrowsecurity)
    OR has_table_privilege('anon','public.supervisor_leave_requests','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    OR has_table_privilege('authenticated','public.supervisor_leave_requests','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN
  RAISE EXCEPTION 'Supervisor leave table not safely locked';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid='public.supervisor_leave_requests'::regclass AND attname='status' AND atttypid='text'::regtype AND NOT attisdropped) THEN
  RAISE EXCEPTION 'Supervisor leave status column differs';
 END IF;
END;
$preflight$;

CREATE FUNCTION public.supervisor_leave_pending_summary()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_count bigint;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN
  RAISE EXCEPTION 'Founder access required' USING ERRCODE='42501';
 END IF;
 SELECT count(*) INTO v_count FROM public.supervisor_leave_requests WHERE status='pending';
 RETURN jsonb_build_object('pending_count',v_count);
END;
$$;
REVOKE ALL ON FUNCTION public.supervisor_leave_pending_summary() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.supervisor_leave_pending_summary() TO authenticated;
DO $postflight$
BEGIN
 IF has_function_privilege('anon','public.supervisor_leave_pending_summary()','EXECUTE')
    OR NOT has_function_privilege('authenticated','public.supervisor_leave_pending_summary()','EXECUTE') THEN
  RAISE EXCEPTION 'Unexpected Supervisor leave summary execution privileges';
 END IF;
END;
$postflight$;


-- supabase/drafts/project_paid_payroll_evidence.sql sha256 85c351bdd60c666c0749b1633e89aeac98969771189f5717cac9966feef71979
-- DRAFT ONLY, not a migration. Requires the exact reviewed weekly generator,
-- approval, payment-date and paid-allocation drafts. Read-only evidence, NOT a
-- reconciled project cost total. Legacy payroll and later adjustments excluded.
-- Install only as part of a tested cutover and catalog/permission review.
CREATE INDEX weekly_paid_allocations_project_payroll_idx ON public.weekly_worker_paid_allocations(project_id,payroll_id);
CREATE FUNCTION public.project_paid_worker_evidence(p_project uuid,p_cursor_week date DEFAULT NULL,p_cursor_payroll uuid DEFAULT NULL,p_limit integer DEFAULT 25)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_result jsonb;v_bad boolean;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access required' USING ERRCODE='42501'; END IF;
 IF p_project IS NULL OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 OR (p_cursor_week IS NULL)<>(p_cursor_payroll IS NULL) OR (p_cursor_week IS NOT NULL AND (NOT isfinite(p_cursor_week) OR extract(dow FROM p_cursor_week)<>0)) THEN RAISE EXCEPTION 'Invalid project or cursor' USING ERRCODE='22023'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.projects WHERE id=p_project) THEN RAISE EXCEPTION 'Project unavailable' USING ERRCODE='42501'; END IF;
 -- Validate every row on this page, including the lookahead, before displaying
 -- anything. Joins are deliberately left joins so missing evidence fails closed.
 WITH candidate AS MATERIALIZED (
  SELECT a.*,p.worker_id,p.status,p.period_start,p.period_end,p.gross_pay,p.hours_worked,
   s.worker_id source_worker,s.period_start source_week,s.approved_by,s.approved_at,s.approval_xid,s.payment_actor,s.payment_xid,s.calculation,
   d.payment_date,d.recorded_by,w.name worker_name,
   (SELECT sum(x.wage) FROM public.weekly_worker_paid_allocations x WHERE x.payroll_id=a.payroll_id) total_wage,
   (SELECT sum(x.allowance) FROM public.weekly_worker_paid_allocations x WHERE x.payroll_id=a.payroll_id) total_allowance,
   (SELECT sum(x.gross) FROM public.weekly_worker_paid_allocations x WHERE x.payroll_id=a.payroll_id) total_gross,
   (SELECT sum(x.hours) FROM public.weekly_worker_paid_allocations x WHERE x.payroll_id=a.payroll_id) total_hours
  FROM public.weekly_worker_paid_allocations a LEFT JOIN public.payroll p ON p.id=a.payroll_id
  LEFT JOIN public.weekly_worker_draft_sources s ON s.payroll_id=a.payroll_id
  LEFT JOIN public.payroll_payment_dates d ON d.payroll_id=a.payroll_id
  LEFT JOIN public.workers w ON w.id=p.worker_id
  WHERE a.project_id=p_project AND (p_cursor_week IS NULL OR (p.period_start,a.payroll_id)<(p_cursor_week,p_cursor_payroll))
  ORDER BY p.period_start DESC NULLS FIRST,a.payroll_id DESC LIMIT p_limit+1
 ), checked AS MATERIALIZED (
  SELECT *,coalesce(status='paid' AND worker_id=source_worker AND period_start=source_week
   AND extract(dow FROM period_start)=0 AND period_end=period_start+6
   AND approved_by IS NOT NULL AND approved_at IS NOT NULL AND approval_xid IS NULL
   AND payment_actor IS NOT NULL AND payment_xid IS NULL AND payment_date IS NOT NULL AND recorded_by=payment_actor
   AND worker_name IS NOT NULL AND hours>0 AND wage>=0 AND allowance>=0 AND gross=wage+allowance
   AND total_hours=hours_worked AND total_gross=gross_pay AND total_wage=(calculation->>'wage')::numeric
   AND total_allowance=(calculation->>'allowance')::numeric AND total_gross=(calculation->>'gross')::numeric,false) valid
  FROM candidate
 )
 SELECT coalesce(bool_or(NOT valid),false),jsonb_build_object('project_id',p_project,'has_more',count(*)>p_limit,
  'items',coalesce((SELECT jsonb_agg(jsonb_build_object('payroll_id',payroll_id,'worker_id',worker_id,'worker_name',worker_name,
    'period_start',period_start,'period_end',period_end,'payment_date',payment_date,'hours',hours::text,'wage',wage::text,'allowance',allowance::text,'gross',gross::text)
    ORDER BY period_start DESC,payroll_id DESC) FROM (SELECT * FROM checked ORDER BY period_start DESC NULLS FIRST,payroll_id DESC LIMIT p_limit) page),'[]'::jsonb))
 INTO v_bad,v_result FROM checked;
 IF v_bad THEN RAISE EXCEPTION 'Paid project allocation evidence is inconsistent; review' USING ERRCODE='22023'; END IF;
 IF octet_length(v_result::text)>1048576 THEN RAISE EXCEPTION 'Project payroll page too large' USING ERRCODE='54000'; END IF;
 RETURN v_result;
END $$;
REVOKE ALL ON FUNCTION public.project_paid_worker_evidence(uuid,date,uuid,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.project_paid_worker_evidence(uuid,date,uuid,integer) TO authenticated;
DO $$ BEGIN
 IF has_function_privilege('anon','public.project_paid_worker_evidence(uuid,date,uuid,integer)','EXECUTE') OR has_function_privilege('service_role','public.project_paid_worker_evidence(uuid,date,uuid,integer)','EXECUTE') THEN RAISE EXCEPTION 'Unexpected inherited project payroll function privileges'; END IF;
END $$;


-- supabase/drafts/paid_payroll_adjustments.sql sha256 aafd27e46f29cf2c8158a239594b4e5288d2d571fad9e17094bdaf33710bfa25
-- DRAFT ONLY. Separate Founder-reviewed cases against original paid vouchers.
-- Not a payment system, an automatic reconciliation, or a hosted migration.
-- Do not apply until workflow, live compatibility and transaction tests are reviewed.
-- Requires public.users, public.workers, public.payroll, auth.uid() and
-- public.is_founder() and public.session_assurance_satisfied(). Existing payroll,
-- advances and accounts are not changed. Privileged owners can bypass triggers.

CREATE TABLE public.paid_payroll_adjustment_cases (
  id uuid PRIMARY KEY,
  payroll_id uuid NOT NULL REFERENCES public.payroll(id) ON DELETE RESTRICT,
  worker_id uuid NOT NULL REFERENCES public.workers(id) ON DELETE RESTRICT,
  original_voucher jsonb NOT NULL,
  difference numeric(12,2) NOT NULL CHECK (difference <> 0),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','settled_external','no_transfer')),
  created_by uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_by uuid REFERENCES public.users(id) ON DELETE RESTRICT,
  resolved_at timestamptz,
  settled_on date,
  resolution_note text,
  CHECK ((status='pending' AND resolved_by IS NULL AND resolved_at IS NULL AND settled_on IS NULL AND resolution_note IS NULL)
    OR (status='settled_external' AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL AND settled_on IS NOT NULL AND resolution_note IS NOT NULL AND length(resolution_note) BETWEEN 1 AND 500)
    OR (status='no_transfer' AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL AND settled_on IS NULL AND resolution_note IS NOT NULL AND length(resolution_note) BETWEEN 1 AND 500))
);
CREATE UNIQUE INDEX paid_adjustments_one_pending_per_voucher ON public.paid_payroll_adjustment_cases(payroll_id) WHERE status='pending';
CREATE INDEX paid_adjustments_voucher_history ON public.paid_payroll_adjustment_cases(payroll_id,created_at DESC,id);
ALTER TABLE public.paid_payroll_adjustment_cases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.paid_payroll_adjustment_cases FROM PUBLIC,anon,authenticated,service_role;

-- Separate append-only action evidence. Events do not establish that money was
-- transferred; privileged owners can still disable guards or rewrite history.
CREATE TABLE public.paid_payroll_adjustment_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 case_id uuid NOT NULL REFERENCES public.paid_payroll_adjustment_cases(id) ON DELETE RESTRICT,
 kind text NOT NULL CHECK(kind IN ('opened','resolved')),
 actor uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 before_row jsonb,
 after_row jsonb NOT NULL,
 UNIQUE(case_id,kind),
 CHECK ((kind='opened' AND before_row IS NULL) OR (kind='resolved' AND before_row IS NOT NULL))
);
ALTER TABLE public.paid_payroll_adjustment_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.paid_payroll_adjustment_events FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION app_private.guard_paid_adjustment_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF TG_TABLE_NAME='paid_payroll_adjustment_events' OR TG_OP='DELETE' THEN
  RAISE EXCEPTION 'Paid adjustment history is immutable' USING ERRCODE='22023'; END IF;
 IF OLD.status<>'pending' OR NEW.status NOT IN ('settled_external','no_transfer') OR
   (to_jsonb(NEW)-ARRAY['status','resolved_by','resolved_at','settled_on','resolution_note']) IS DISTINCT FROM
   (to_jsonb(OLD)-ARRAY['status','resolved_by','resolved_at','settled_on','resolution_note']) OR
   auth.uid() IS NULL OR NEW.resolved_by IS DISTINCT FROM auth.uid() OR
   NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN
  RAISE EXCEPTION 'Only a controlled final adjustment decision is allowed' USING ERRCODE='22023'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_private.guard_paid_adjustment_immutable() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER guard_paid_adjustment_case_history BEFORE UPDATE OR DELETE ON public.paid_payroll_adjustment_cases
 FOR EACH ROW EXECUTE FUNCTION app_private.guard_paid_adjustment_immutable();
CREATE TRIGGER guard_paid_adjustment_event_history BEFORE UPDATE OR DELETE ON public.paid_payroll_adjustment_events
 FOR EACH ROW EXECUTE FUNCTION app_private.guard_paid_adjustment_immutable();

-- This compact snapshot is the exact version the Founder reviewed. All money
-- is returned as text to avoid JavaScript floating-point loss. It is evidence of
-- a database record, not proof money was paid or a correction is owed.
CREATE FUNCTION app_private.paid_adjustment_voucher_snapshot(p public.payroll)
RETURNS jsonb LANGUAGE sql STABLE SET search_path='' AS $$
 SELECT jsonb_build_object('id',p.id,'worker_id',p.worker_id,'period_start',p.period_start,'period_end',p.period_end,
  'status',p.status,'gross_pay',p.gross_pay::text,'bale_deduction',p.bale_deduction::text,
  'other_deductions',p.other_deductions::text,'net_pay',p.net_pay::text)
$$;
REVOKE ALL ON FUNCTION app_private.paid_adjustment_voucher_snapshot(public.payroll) FROM PUBLIC,anon,authenticated,service_role;

-- Caller supplies an idempotency ID and the exact voucher version reviewed.
-- Positive difference means more due to the worker; negative means a possible
-- overpayment. Neither value is automatically paid, deducted or carried ahead.
CREATE FUNCTION public.open_paid_payroll_adjustment(p_id uuid,p_payroll_id uuid,p_expected jsonb,p_difference numeric,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_worker uuid; v_pay public.payroll%ROWTYPE; v_prev public.paid_payroll_adjustment_cases%ROWTYPE; v_snapshot jsonb; v_reason text;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance required' USING ERRCODE='42501'; END IF;
 IF current_setting('transaction_isolation') <> 'read committed' THEN RAISE EXCEPTION 'Adjustment review requires read committed isolation' USING ERRCODE='P1002'; END IF;
 IF p_id IS NULL OR p_payroll_id IS NULL OR p_expected IS NULL OR p_difference IS NULL OR p_difference='NaN'::numeric
   OR p_difference=0 OR abs(p_difference)>=10000000000 OR p_difference<>round(p_difference,2)
   OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 500 THEN
  RAISE EXCEPTION 'Enter a valid nonzero difference and review reason' USING ERRCODE='22023'; END IF;
 v_reason:=btrim(p_reason);
 PERFORM 1 FROM public.users WHERE id=auth.uid() AND role='founder' FOR SHARE;
 IF NOT FOUND OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance required' USING ERRCODE='42501'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('paid-payroll-adjustment:'||p_id::text,0));
 SELECT worker_id INTO v_worker FROM public.payroll WHERE id=p_payroll_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Paid voucher unavailable' USING ERRCODE='P0002'; END IF;
 -- Match the worker -> voucher lock order of the existing payroll status RPC.
 PERFORM 1 FROM public.workers WHERE id=v_worker FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Worker unavailable' USING ERRCODE='P0002'; END IF;
 SELECT * INTO v_pay FROM public.payroll WHERE id=p_payroll_id FOR UPDATE;
 IF NOT FOUND OR v_pay.worker_id<>v_worker THEN RAISE EXCEPTION 'Voucher changed; refresh' USING ERRCODE='40001'; END IF;
 SELECT * INTO v_prev FROM public.paid_payroll_adjustment_cases WHERE id=p_id;
 IF FOUND THEN
  IF (v_prev.created_by,v_prev.payroll_id,v_prev.original_voucher,v_prev.difference,v_prev.reason) IS DISTINCT FROM (auth.uid(),p_payroll_id,p_expected,p_difference,v_reason) THEN
   RAISE EXCEPTION 'Adjustment ID already used for different details' USING ERRCODE='22023'; END IF;
  RETURN jsonb_build_object('id',v_prev.id,'status',v_prev.status,'replayed',true);
 END IF;
 IF v_pay.status<>'paid' THEN RAISE EXCEPTION 'Only a paid voucher can have a paid-period review case' USING ERRCODE='22023'; END IF;
 v_snapshot:=app_private.paid_adjustment_voucher_snapshot(v_pay);
 IF v_snapshot IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'Voucher changed since review; refresh first' USING ERRCODE='40001'; END IF;
 IF EXISTS(SELECT 1 FROM public.paid_payroll_adjustment_cases WHERE payroll_id=p_payroll_id AND status='pending') THEN
  RAISE EXCEPTION 'This voucher already has a pending review case' USING ERRCODE='22023'; END IF;
 INSERT INTO public.paid_payroll_adjustment_cases(id,payroll_id,worker_id,original_voucher,difference,reason,created_by)
 VALUES(p_id,p_payroll_id,v_worker,v_snapshot,p_difference,v_reason,auth.uid()) RETURNING * INTO v_prev;
 INSERT INTO public.paid_payroll_adjustment_events(case_id,kind,actor,before_row,after_row) VALUES(p_id,'opened',auth.uid(),NULL,to_jsonb(v_prev));
 RETURN jsonb_build_object('id',p_id,'status','pending','replayed',false);
END;
$$;
REVOKE ALL ON FUNCTION public.open_paid_payroll_adjustment(uuid,uuid,jsonb,numeric,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.open_paid_payroll_adjustment(uuid,uuid,jsonb,numeric,text) TO authenticated;

-- External settlement is a human statement, not a money transfer. This narrow
-- draft records either a complete external settlement or no transfer; partial
-- settlements require a separate future design rather than silent aggregation.
CREATE FUNCTION public.resolve_paid_payroll_adjustment(p_id uuid,p_resolution text,p_settled_on date,p_note text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_payroll uuid; v_worker uuid; v_pay public.payroll%ROWTYPE; v_case public.paid_payroll_adjustment_cases%ROWTYPE; v_before jsonb; v_note text;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance required' USING ERRCODE='42501'; END IF;
 IF current_setting('transaction_isolation') <> 'read committed' THEN RAISE EXCEPTION 'Adjustment review requires read committed isolation' USING ERRCODE='P1002'; END IF;
 IF p_id IS NULL OR p_resolution IS NULL OR p_resolution NOT IN ('settled_external','no_transfer')
   OR p_note IS NULL OR length(btrim(p_note)) NOT BETWEEN 1 AND 500
   OR (p_resolution='no_transfer' AND p_settled_on IS NOT NULL)
   OR (p_resolution='settled_external' AND (p_settled_on IS NULL OR p_settled_on<'1900-01-01'::date OR p_settled_on>(clock_timestamp() AT TIME ZONE 'Asia/Manila')::date)) THEN
  RAISE EXCEPTION 'Enter a valid resolution, date and explanation' USING ERRCODE='22023'; END IF;
 v_note:=btrim(p_note);
 PERFORM 1 FROM public.users WHERE id=auth.uid() AND role='founder' FOR SHARE;
 IF NOT FOUND OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance required' USING ERRCODE='42501'; END IF;
 SELECT payroll_id,worker_id INTO v_payroll,v_worker FROM public.paid_payroll_adjustment_cases WHERE id=p_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Adjustment case unavailable' USING ERRCODE='P0002'; END IF;
 PERFORM 1 FROM public.workers WHERE id=v_worker FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Worker unavailable' USING ERRCODE='P0002'; END IF;
 SELECT * INTO v_pay FROM public.payroll WHERE id=v_payroll FOR UPDATE;
 IF NOT FOUND OR v_pay.worker_id<>v_worker THEN RAISE EXCEPTION 'Voucher changed; refresh' USING ERRCODE='40001'; END IF;
 SELECT * INTO v_case FROM public.paid_payroll_adjustment_cases WHERE id=p_id FOR UPDATE;
 IF NOT FOUND OR v_case.payroll_id<>v_payroll OR v_case.worker_id<>v_worker THEN RAISE EXCEPTION 'Adjustment changed; refresh' USING ERRCODE='40001'; END IF;
 IF p_resolution='settled_external' AND p_settled_on<v_pay.period_start THEN
  RAISE EXCEPTION 'Settlement date cannot precede the original payroll period' USING ERRCODE='22023'; END IF;
 IF v_case.status<>'pending' THEN
  IF (v_case.status,v_case.resolved_by,v_case.settled_on,v_case.resolution_note) IS NOT DISTINCT FROM (p_resolution,auth.uid(),p_settled_on,v_note) THEN
   RETURN jsonb_build_object('id',v_case.id,'status',v_case.status,'replayed',true); END IF;
  RAISE EXCEPTION 'Case already resolved; review recorded decision' USING ERRCODE='22023'; END IF;
 IF v_pay.status<>'paid' OR app_private.paid_adjustment_voucher_snapshot(v_pay) IS DISTINCT FROM v_case.original_voucher THEN
  RAISE EXCEPTION 'Original voucher changed since review; investigate before resolving' USING ERRCODE='40001'; END IF;
 v_before:=to_jsonb(v_case);
 UPDATE public.paid_payroll_adjustment_cases SET status=p_resolution,resolved_by=auth.uid(),resolved_at=clock_timestamp(),settled_on=p_settled_on,resolution_note=v_note WHERE id=p_id RETURNING * INTO v_case;
 INSERT INTO public.paid_payroll_adjustment_events(case_id,kind,actor,before_row,after_row) VALUES(p_id,'resolved',auth.uid(),v_before,to_jsonb(v_case));
 RETURN jsonb_build_object('id',p_id,'status',p_resolution,'replayed',false);
END;
$$;
REVOKE ALL ON FUNCTION public.resolve_paid_payroll_adjustment(uuid,text,date,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.resolve_paid_payroll_adjustment(uuid,text,date,text) TO authenticated;

CREATE FUNCTION public.paid_payroll_adjustment_list(p_payroll_id uuid,p_offset integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_total bigint; v_items jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance required' USING ERRCODE='42501'; END IF;
 IF p_payroll_id IS NULL OR p_offset IS NULL OR p_offset<0 OR p_offset>1000000 THEN RAISE EXCEPTION 'Invalid adjustment list request' USING ERRCODE='22023'; END IF;
 SELECT count(*) INTO v_total FROM public.paid_payroll_adjustment_cases WHERE payroll_id=p_payroll_id;
 SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.created_at DESC,x.id),'[]'::jsonb) INTO v_items FROM (
  SELECT c.id,c.payroll_id,c.worker_id,c.original_voucher,c.difference::text AS difference,c.reason,c.status,c.created_at,c.created_by,c.resolved_at,c.resolved_by,c.settled_on,c.resolution_note
  FROM public.paid_payroll_adjustment_cases c WHERE c.payroll_id=p_payroll_id ORDER BY c.created_at DESC,c.id LIMIT 100 OFFSET p_offset
 ) x;
 RETURN jsonb_build_object('total',v_total,'offset',p_offset,'items',v_items);
END;
$$;
REVOKE ALL ON FUNCTION public.paid_payroll_adjustment_list(uuid,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.paid_payroll_adjustment_list(uuid,integer) TO authenticated;

-- Fail closed if default or inherited role grants leave a client with table or
-- internal-helper access, or if anonymous execution remains effective.
DO $postflight$
DECLARE v_proc regprocedure; v_signature text;
BEGIN
 IF NOT (SELECT relrowsecurity FROM pg_catalog.pg_class WHERE oid='public.paid_payroll_adjustment_cases'::regclass)
  OR has_table_privilege('anon','public.paid_payroll_adjustment_cases','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  OR has_table_privilege('authenticated','public.paid_payroll_adjustment_cases','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  OR has_table_privilege('service_role','public.paid_payroll_adjustment_cases','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  OR EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r(role_name),
    unnest(ARRAY['public.paid_payroll_adjustment_cases'::regclass,'public.paid_payroll_adjustment_events'::regclass]) t(relid)
    WHERE has_table_privilege(r.role_name,t.relid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
       OR EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid=t.relid AND a.attnum>0 AND NOT a.attisdropped
         AND has_column_privilege(r.role_name,t.relid,a.attname,'SELECT,INSERT,UPDATE,REFERENCES'))) THEN
  RAISE EXCEPTION 'Unexpected direct adjustment-table client privilege'; END IF;
 v_proc:='app_private.paid_adjustment_voucher_snapshot(public.payroll)'::regprocedure;
 IF has_function_privilege('anon',v_proc,'EXECUTE') OR has_function_privilege('authenticated',v_proc,'EXECUTE') OR has_function_privilege('service_role',v_proc,'EXECUTE') THEN
  RAISE EXCEPTION 'Unexpected internal adjustment-helper privilege'; END IF;
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r(role_name) WHERE has_function_privilege(r.role_name,'app_private.guard_paid_adjustment_immutable()','EXECUTE')) THEN RAISE EXCEPTION 'Unexpected adjustment guard privilege'; END IF;
 FOREACH v_signature IN ARRAY ARRAY['public.open_paid_payroll_adjustment(uuid,uuid,jsonb,numeric,text)','public.resolve_paid_payroll_adjustment(uuid,text,date,text)','public.paid_payroll_adjustment_list(uuid,integer)'] LOOP
  v_proc:=v_signature::regprocedure;
  IF has_function_privilege('anon',v_proc,'EXECUTE') OR has_function_privilege('service_role',v_proc,'EXECUTE') OR NOT has_function_privilege('authenticated',v_proc,'EXECUTE')
    OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE oid=v_proc AND prosecdef AND proconfig @> ARRAY['search_path=""']) THEN
   RAISE EXCEPTION 'Unexpected adjustment RPC security: %',v_signature; END IF;
 END LOOP;
END;
$postflight$;


-- supabase/drafts/supervisor_payroll_preview.sql sha256 f7b061765ff88f63e2695ef3026ae5b8473cc9146847f51273c83039398c03d9
-- UNINSTALLED DRAFT: Founder-only, read-only planning inputs. Not a payroll
-- generator, ledger, rate history, payment, or legacy-to-new cutover. Run only
-- after reviewing dependencies and inside a single transaction.
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
DO $preflight$
DECLARE v_missing text;
BEGIN
 IF to_regprocedure('auth.uid()') IS NULL OR to_regprocedure('public.is_founder()') IS NULL OR to_regprocedure('public.session_assurance_satisfied()') IS NULL
   OR to_regprocedure('public.supervisor_day_list(integer)') IS NULL OR to_regprocedure('public.supervisor_leave_list(integer)') IS NULL
   OR to_regclass('public.users') IS NULL OR to_regclass('public.workers') IS NULL OR to_regclass('public.attendance') IS NULL OR to_regclass('public.payroll') IS NULL
   OR to_regclass('public.supervisor_daily_attendance') IS NULL OR to_regclass('public.supervisor_leave_requests') IS NULL THEN
  RAISE EXCEPTION 'Supervisor payroll preview prerequisites missing'; END IF;
 IF to_regprocedure('public.supervisor_payroll_preview_catalog()') IS NOT NULL OR to_regprocedure('public.supervisor_payroll_preview_inputs(uuid,date)') IS NOT NULL THEN
  RAISE EXCEPTION 'Supervisor payroll preview functions already exist'; END IF;
 LOCK TABLE public.supervisor_daily_attendance,public.supervisor_leave_requests IN SHARE MODE;
 SELECT string_agg(required.rel||'.'||required.col,', ' ORDER BY required.rel,required.col) INTO v_missing
 FROM (VALUES ('users','id','uuid'),('users','name','text'),('users','role','text'),('workers','id','uuid'),('workers','name','text'),
 ('attendance','worker_id','uuid'),('attendance','date','date'),('payroll','worker_id','uuid'),('payroll','period_start','date'),('payroll','period_end','date'),
 ('supervisor_daily_attendance','id','uuid'),('supervisor_daily_attendance','supervisor_id','uuid'),('supervisor_daily_attendance','work_date','date'),('supervisor_daily_attendance','work_status','text'),('supervisor_daily_attendance','status','text'),
 ('supervisor_leave_requests','id','uuid'),('supervisor_leave_requests','supervisor_id','uuid'),('supervisor_leave_requests','start_date','date'),('supervisor_leave_requests','end_date','date'),('supervisor_leave_requests','status','text')) AS required(rel,col,typ)
 LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=pg_catalog.to_regclass('public.'||required.rel) AND a.attname=required.col AND a.attnum>0 AND NOT a.attisdropped
 WHERE a.attname IS NULL OR pg_catalog.format_type(a.atttypid,a.atttypmod) IS DISTINCT FROM required.typ;
 IF v_missing IS NOT NULL THEN RAISE EXCEPTION 'Supervisor preview prerequisite columns missing or different: %',v_missing; END IF;
 IF EXISTS (SELECT 1 FROM pg_catalog.pg_class WHERE oid IN ('public.supervisor_daily_attendance'::regclass,'public.supervisor_leave_requests'::regclass) AND (NOT relrowsecurity OR relkind<>'r')) THEN RAISE EXCEPTION 'Supervisor preview tables not locked by RLS'; END IF;
 IF has_table_privilege('authenticated','public.supervisor_daily_attendance','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_table_privilege('anon','public.supervisor_daily_attendance','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
   OR has_table_privilege('authenticated','public.supervisor_leave_requests','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_table_privilege('anon','public.supervisor_leave_requests','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN
  RAISE EXCEPTION 'Unexpected Supervisor table privileges'; END IF;
END;
$preflight$;

CREATE FUNCTION public.supervisor_payroll_preview_catalog() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_items jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access required' USING ERRCODE='42501'; END IF;
 IF (SELECT count(*) FROM public.users WHERE role='supervisor')>2000 THEN RAISE EXCEPTION 'Supervisor catalog exceeds preview limit' USING ERRCODE='54000'; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name) ORDER BY name,id),'[]'::jsonb) INTO v_items FROM public.users WHERE role='supervisor';
 RETURN jsonb_build_object('supervisors',v_items);
END;
$$;
REVOKE ALL ON FUNCTION public.supervisor_payroll_preview_catalog() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.supervisor_payroll_preview_catalog() TO authenticated;

CREATE FUNCTION public.supervisor_payroll_preview_inputs(p_supervisor uuid,p_start date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_end date; v_name text; v_days jsonb; v_leave jsonb; v_legacy bigint; v_vouchers bigint; v_identity boolean;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access required' USING ERRCODE='42501'; END IF;
 IF p_start IS NULL OR p_start<'1900-01-01'::date OR p_start>'9998-12-16'::date OR extract(day from p_start) NOT IN (1,16) OR p_supervisor IS NULL THEN RAISE EXCEPTION 'Invalid Supervisor period' USING ERRCODE='22023'; END IF;
 v_end:=CASE WHEN extract(day from p_start)=1 THEN p_start+14 ELSE (p_start+interval '1 month' - interval '16 days')::date END;
 SELECT name INTO v_name FROM public.users WHERE id=p_supervisor AND role='supervisor';
 IF NOT FOUND THEN RAISE EXCEPTION 'Supervisor unavailable' USING ERRCODE='P0002'; END IF;
 IF (SELECT count(*) FROM public.supervisor_daily_attendance WHERE supervisor_id=p_supervisor AND work_date BETWEEN p_start AND v_end AND status IN ('pending','approved'))>100
 OR (SELECT count(*) FROM public.supervisor_leave_requests WHERE supervisor_id=p_supervisor AND start_date<=v_end AND end_date>=p_start AND status IN ('pending','approved'))>100 THEN
  RAISE EXCEPTION 'Supervisor payroll preview exceeds record limit' USING ERRCODE='54000'; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'date',work_date,'work_status',work_status,'status',status) ORDER BY work_date,id),'[]'::jsonb) INTO v_days
 FROM public.supervisor_daily_attendance WHERE supervisor_id=p_supervisor AND work_date BETWEEN p_start AND v_end AND status IN ('pending','approved');
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'start',start_date,'end',end_date,'status',status) ORDER BY start_date,id),'[]'::jsonb) INTO v_leave
 FROM public.supervisor_leave_requests WHERE supervisor_id=p_supervisor AND start_date<=v_end AND end_date>=p_start AND status IN ('pending','approved');
 -- UUID and case-folded names are warnings, not verified identity links. False
 -- negatives remain possible, so absence of these signals is never proof.
 SELECT NOT EXISTS(SELECT 1 FROM public.workers WHERE id=p_supervisor)
   OR EXISTS(SELECT 1 FROM public.workers WHERE id<>p_supervisor AND lower(btrim(name))=lower(btrim(v_name)))
   OR EXISTS(SELECT 1 FROM public.users WHERE id<>p_supervisor AND role='supervisor' AND lower(btrim(name))=lower(btrim(v_name))) INTO v_identity;
 SELECT count(*) INTO v_legacy FROM public.attendance a JOIN public.workers w ON w.id=a.worker_id
 WHERE (w.id=p_supervisor OR lower(btrim(w.name))=lower(btrim(v_name))) AND a.date BETWEEN p_start AND v_end;
 SELECT count(*) INTO v_vouchers FROM public.payroll p JOIN public.workers w ON w.id=p.worker_id
 WHERE (w.id=p_supervisor OR lower(btrim(w.name))=lower(btrim(v_name))) AND p.period_start<=v_end AND p.period_end>=p_start;
 -- All inputs in this STABLE function use one statement snapshot. The Manila
 -- date is server-provided, so device clock errors cannot make future work payable.
 RETURN jsonb_build_object('supervisor_id',p_supervisor,'start',p_start,'end',v_end,'as_of',(statement_timestamp() AT TIME ZONE 'Asia/Manila')::date,'days',v_days,'leave',v_leave,
   'identity_needs_review',v_identity,'legacy_count',v_legacy,'overlapping_vouchers',v_vouchers);
END;
$$;
REVOKE ALL ON FUNCTION public.supervisor_payroll_preview_inputs(uuid,date) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.supervisor_payroll_preview_inputs(uuid,date) TO authenticated;
DO $postflight$
DECLARE s text;
BEGIN
 FOREACH s IN ARRAY ARRAY['public.supervisor_payroll_preview_catalog()','public.supervisor_payroll_preview_inputs(uuid,date)'] LOOP
  IF has_function_privilege('anon',s,'EXECUTE') OR NOT has_function_privilege('authenticated',s,'EXECUTE') THEN RAISE EXCEPTION 'Unexpected Supervisor payroll preview function privileges'; END IF;
 END LOOP;
END;
$postflight$;


-- supabase/drafts/historical_paid_date_annotation.sql sha256 1894056d462890077022e7cae326329ada4daf62365bdc9c9e2a85870b2ef64c
-- DRAFT ONLY, NOT A DEPLOYABLE MIGRATION. This candidate annotates an existing
-- paid voucher whose real external payment date was not recorded. It does not
-- create a voucher, issue money, change Bale balances or establish project cost.
-- Never infer payment from a status or this Founder's statement. Requires the
-- exact reviewed payroll/payment-date schema and coordinated cutover. Evidence
-- here is deliberately separate from payroll_payment_dates, whose rows imply a
-- different payment workflow. Old clients do not display this annotation.

CREATE TABLE public.historical_paid_date_annotations (
 request_id uuid PRIMARY KEY,
 payroll_id uuid NOT NULL UNIQUE REFERENCES public.payroll(id) ON DELETE RESTRICT,
 recorded_by uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 payment_date date NOT NULL CHECK(payment_date>=DATE '1900-01-01'),
 evidence_note text NOT NULL CHECK(length(evidence_note) BETWEEN 1 AND 500),
 voucher_snapshot jsonb NOT NULL
);
ALTER TABLE public.historical_paid_date_annotations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.historical_paid_date_annotations FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.historical_paid_date_annotations TO authenticated;
CREATE POLICY founder_reads_historical_paid_dates ON public.historical_paid_date_annotations
 FOR SELECT TO authenticated USING (coalesce(public.is_founder(),false) AND coalesce(public.session_assurance_satisfied(),false));
DO $$ BEGIN
 IF has_table_privilege('anon','public.historical_paid_date_annotations','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
 OR has_table_privilege('authenticated','public.historical_paid_date_annotations','INSERT,UPDATE,DELETE,TRUNCATE')
 OR has_table_privilege('service_role','public.historical_paid_date_annotations','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid='public.historical_paid_date_annotations'::regclass AND a.attnum>0 AND NOT a.attisdropped AND
  (has_column_privilege('anon',a.attrelid,a.attname,'SELECT,INSERT,UPDATE') OR has_column_privilege('authenticated',a.attrelid,a.attname,'INSERT,UPDATE') OR has_column_privilege('service_role',a.attrelid,a.attname,'SELECT,INSERT,UPDATE'))) THEN
  RAISE EXCEPTION 'Unexpected inherited historical date privileges'; END IF;
END $$;
CREATE FUNCTION public.guard_historical_paid_date_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN RAISE EXCEPTION 'Historical date evidence is immutable; use a separate reviewed correction' USING ERRCODE='22023'; END;
$$;
REVOKE ALL ON FUNCTION public.guard_historical_paid_date_immutable() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER guard_historical_paid_date_immutable BEFORE UPDATE OR DELETE ON public.historical_paid_date_annotations
 FOR EACH ROW EXECUTE FUNCTION public.guard_historical_paid_date_immutable();

-- Compact, exact version explicitly reviewed by the Founder. Text monetary
-- values avoid JS float coercion; this is a database snapshot, not a receipt.
CREATE FUNCTION public.historical_paid_voucher_snapshot(p public.payroll) RETURNS jsonb LANGUAGE sql STABLE SET search_path='' AS $$
 SELECT jsonb_build_object('id',p.id,'worker_id',p.worker_id,'period_start',p.period_start,'period_end',p.period_end,'status',p.status,
 'gross_pay',p.gross_pay::text,'bale_deduction',p.bale_deduction::text,'other_deductions',p.other_deductions::text,'net_pay',p.net_pay::text)
$$;
REVOKE ALL ON FUNCTION public.historical_paid_voucher_snapshot(public.payroll) FROM PUBLIC,anon,authenticated,service_role;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r(role_name) WHERE has_function_privilege(r.role_name,'public.historical_paid_voucher_snapshot(public.payroll)','EXECUTE')) THEN RAISE EXCEPTION 'Unexpected inherited historical snapshot privilege'; END IF; END $$;

CREATE FUNCTION public.annotate_historical_paid_date(p_request uuid,p_payroll uuid,p_expected jsonb,p_date date,p_note text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_previous public.historical_paid_date_annotations%ROWTYPE; v_pay public.payroll%ROWTYPE; v_note text; v_email text;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Historical annotation requires read committed isolation' USING ERRCODE='P1002'; END IF;
 IF p_request IS NULL OR p_payroll IS NULL OR p_expected IS NULL OR p_date IS NULL OR NOT isfinite(p_date) OR p_date<DATE '1900-01-01'
  OR p_date>(statement_timestamp() AT TIME ZONE 'Asia/Manila')::date OR p_note IS NULL OR length(btrim(p_note)) NOT BETWEEN 1 AND 500 THEN
  RAISE EXCEPTION 'Provide a valid actual date and evidence note' USING ERRCODE='22023'; END IF;
 v_note:=btrim(p_note);PERFORM pg_catalog.set_config('lock_timeout','3s',true);
 -- Same lock ordering as the weekly payment candidate; broad locks and all
 -- existing trigger interactions must be reviewed before any deployment.
 LOCK TABLE public.users,public.workers,public.projects,public.attendance,public.attendance_time_details,public.worker_allowances,
  public.advances,public.advance_requests,public.payroll,public.weekly_worker_draft_sources,
  public.payroll_payment_dates,public.weekly_worker_paid_allocations,public.historical_paid_date_annotations IN SHARE ROW EXCLUSIVE MODE;
 SELECT * INTO v_previous FROM public.historical_paid_date_annotations WHERE request_id=p_request;
 IF FOUND THEN
  IF (v_previous.payroll_id,v_previous.recorded_by,v_previous.voucher_snapshot,v_previous.payment_date,v_previous.evidence_note)
   IS DISTINCT FROM (p_payroll,auth.uid(),p_expected,p_date,v_note) THEN RAISE EXCEPTION 'Request ID used for different evidence' USING ERRCODE='22023'; END IF;
  RETURN jsonb_build_object('replayed',true,'request_id',p_request,'payroll_id',p_payroll,'payment_date',v_previous.payment_date);
 END IF;
 SELECT * INTO v_pay FROM public.payroll WHERE id=p_payroll FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Paid voucher unavailable' USING ERRCODE='P0002'; END IF;
 IF v_pay.status<>'paid' THEN RAISE EXCEPTION 'Only an existing paid voucher can receive historical evidence' USING ERRCODE='22023'; END IF;
 IF p_date<v_pay.period_start THEN RAISE EXCEPTION 'Payment date cannot precede the period start' USING ERRCODE='22023'; END IF;
 IF public.historical_paid_voucher_snapshot(v_pay) IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'Voucher changed since review' USING ERRCODE='40001'; END IF;
 IF EXISTS(SELECT 1 FROM public.historical_paid_date_annotations WHERE payroll_id=p_payroll) OR EXISTS(SELECT 1 FROM public.payroll_payment_dates WHERE payroll_id=p_payroll) THEN
  RAISE EXCEPTION 'Existing payment-date evidence requires separate review' USING ERRCODE='22023'; END IF;
 INSERT INTO public.historical_paid_date_annotations(request_id,payroll_id,recorded_by,payment_date,evidence_note,voucher_snapshot)
 VALUES(p_request,p_payroll,auth.uid(),p_date,v_note,p_expected);
 SELECT email INTO v_email FROM public.users WHERE id=auth.uid();
 INSERT INTO public.audit_log(actor_id,actor_email,action,table_name,record_id,before_row,after_row)
 VALUES(auth.uid(),v_email,'insert','historical_paid_date_annotations',p_request,NULL,jsonb_build_object('payroll_id',p_payroll,'payment_date',p_date,'evidence_note',v_note,'voucher_snapshot',p_expected));
 RETURN jsonb_build_object('replayed',false,'request_id',p_request,'payroll_id',p_payroll,'payment_date',p_date);
END;
$$;
REVOKE ALL ON FUNCTION public.annotate_historical_paid_date(uuid,uuid,jsonb,date,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.annotate_historical_paid_date(uuid,uuid,jsonb,date,text) TO authenticated;
DO $$ BEGIN IF has_function_privilege('anon','public.annotate_historical_paid_date(uuid,uuid,jsonb,date,text)','EXECUTE') OR has_function_privilege('service_role','public.annotate_historical_paid_date(uuid,uuid,jsonb,date,text)','EXECUTE') THEN RAISE EXCEPTION 'Unexpected inherited historical annotation privilege'; END IF; END $$;


-- supabase/drafts/historical_settled_bale_evidence.sql sha256 3ef0596f56f74dd9c1a8aa5f0d8abb2d22c31b28d769011048ffb101fefbbb8f
-- DRAFT ONLY; NOT A DEPLOYABLE MIGRATION. Requires the exact weekly payment
-- candidates, guarded legacy Bale writer and historical paid-date annotation.
-- Records a Founder's assertion about ONE already-released Bale, fully deducted
-- in ONE already-paid weekly voucher. It NEVER creates an advance, request,
-- payment, expense or allocation, and never changes a balance. Evidence is not
-- proof; never use it to infer an outstanding balance or to send money. Multiple
-- releases, unknown dates, missing paid vouchers and ambiguous histories require
-- separate manual review; this deliberately fails closed instead of guessing.

CREATE TABLE public.historical_settled_bale_evidence (
 request_id uuid PRIMARY KEY,
 payroll_id uuid NOT NULL UNIQUE REFERENCES public.payroll(id) ON DELETE RESTRICT,
 worker_id uuid NOT NULL REFERENCES public.workers(id) ON DELETE RESTRICT,
 project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE RESTRICT,
 recorded_by uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 release_date date NOT NULL,
 amount numeric(10,2) NOT NULL CHECK(amount>0),
 payment_date date NOT NULL,
 payment_date_source text NOT NULL CHECK(payment_date_source IN ('recorded_payment','historical_annotation')),
 evidence_note text NOT NULL CHECK(length(evidence_note) BETWEEN 1 AND 500),
 voucher_snapshot jsonb NOT NULL
);
ALTER TABLE public.historical_settled_bale_evidence ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.historical_settled_bale_evidence FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.historical_settled_bale_evidence TO authenticated;
CREATE POLICY founder_reads_historical_settled_bale ON public.historical_settled_bale_evidence
 FOR SELECT TO authenticated USING (coalesce(public.is_founder(),false) AND coalesce(public.session_assurance_satisfied(),false));
DO $$ BEGIN
 IF has_table_privilege('anon','public.historical_settled_bale_evidence','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
 OR has_table_privilege('authenticated','public.historical_settled_bale_evidence','INSERT,UPDATE,DELETE,TRUNCATE')
 OR has_table_privilege('service_role','public.historical_settled_bale_evidence','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid='public.historical_settled_bale_evidence'::regclass AND a.attnum>0 AND NOT a.attisdropped AND
  (has_column_privilege('anon',a.attrelid,a.attname,'SELECT,INSERT,UPDATE') OR has_column_privilege('authenticated',a.attrelid,a.attname,'INSERT,UPDATE') OR has_column_privilege('service_role',a.attrelid,a.attname,'SELECT,INSERT,UPDATE'))) THEN RAISE EXCEPTION 'Unexpected inherited historical Bale privileges'; END IF;
END $$;
CREATE FUNCTION public.guard_historical_settled_bale_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN RAISE EXCEPTION 'Historical Bale evidence is immutable; use separate reviewed correction' USING ERRCODE='22023'; END;
$$;
REVOKE ALL ON FUNCTION public.guard_historical_settled_bale_immutable() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER guard_historical_settled_bale_immutable BEFORE UPDATE OR DELETE ON public.historical_settled_bale_evidence
 FOR EACH ROW EXECUTE FUNCTION public.guard_historical_settled_bale_immutable();

CREATE FUNCTION public.record_historical_settled_bale(p_request uuid,p_payroll uuid,p_expected jsonb,p_project uuid,p_release_date date,p_amount numeric,p_note text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_prev public.historical_settled_bale_evidence%ROWTYPE; v_pay public.payroll%ROWTYPE; v_note text;v_email text;v_payment date;v_source text;v_count integer;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Historical Bale evidence requires read committed isolation' USING ERRCODE='P1002'; END IF;
 IF p_request IS NULL OR p_payroll IS NULL OR p_expected IS NULL OR p_project IS NULL OR p_release_date IS NULL OR NOT isfinite(p_release_date)
  OR p_release_date<DATE '1900-01-01' OR p_release_date>(statement_timestamp() AT TIME ZONE 'Asia/Manila')::date
  OR p_amount IS NULL OR p_amount='NaN'::numeric OR p_amount<=0 OR p_amount>=100000000 OR p_amount<>round(p_amount,2)
  OR p_note IS NULL OR length(btrim(p_note)) NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'Provide valid release date, amount and evidence note' USING ERRCODE='22023'; END IF;
 v_note:=btrim(p_note);PERFORM pg_catalog.set_config('lock_timeout','3s',true);
 -- Same conservative table order as the payment and historical-date candidates.
 LOCK TABLE public.users,public.workers,public.projects,public.attendance,public.attendance_time_details,public.worker_allowances,
  public.advances,public.advance_requests,public.payroll,public.weekly_worker_draft_sources,public.payroll_payment_dates,
  public.weekly_worker_paid_allocations,public.historical_paid_date_annotations,public.historical_settled_bale_evidence IN SHARE ROW EXCLUSIVE MODE;
 SELECT * INTO v_prev FROM public.historical_settled_bale_evidence WHERE request_id=p_request;
 IF FOUND THEN
  IF (v_prev.payroll_id,v_prev.recorded_by,v_prev.voucher_snapshot,v_prev.project_id,v_prev.release_date,v_prev.amount,v_prev.evidence_note)
   IS DISTINCT FROM (p_payroll,auth.uid(),p_expected,p_project,p_release_date,p_amount,v_note) THEN RAISE EXCEPTION 'Request ID used for different Bale evidence' USING ERRCODE='22023'; END IF;
  RETURN jsonb_build_object('replayed',true,'request_id',p_request,'payroll_id',p_payroll);
 END IF;
 SELECT * INTO v_pay FROM public.payroll WHERE id=p_payroll FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Paid voucher unavailable' USING ERRCODE='P0002'; END IF;
 IF v_pay.status<>'paid' OR v_pay.period_end<>v_pay.period_start+6 OR extract(dow FROM v_pay.period_start)<>0 THEN RAISE EXCEPTION 'Only an existing paid Sunday–Saturday worker voucher is supported' USING ERRCODE='22023'; END IF;
 IF public.historical_paid_voucher_snapshot(v_pay) IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'Voucher changed since review' USING ERRCODE='40001'; END IF;
 IF EXISTS(SELECT 1 FROM public.workers w WHERE w.id=v_pay.worker_id AND (
  strpos(lower(w.position),'supervisor')>0 OR EXISTS(SELECT 1 FROM public.users u WHERE u.role='supervisor' AND (u.id=w.id OR lower(btrim(u.name))=lower(btrim(w.name))))))
  OR EXISTS(SELECT 1 FROM public.attendance a WHERE a.worker_id=v_pay.worker_id AND a.date BETWEEN v_pay.period_start AND v_pay.period_end
   AND (a.worker_id=a.recorded_by OR strpos(coalesce(a.notes,''),'Pending Founder Review')>0 OR strpos(coalesce(a.notes,''),'Founder Review:')>0)) THEN
  RAISE EXCEPTION 'Possible Supervisor identity requires separate review' USING ERRCODE='22023'; END IF;
 IF v_pay.bale_deduction IS DISTINCT FROM p_amount OR v_pay.gross_pay IS NULL OR v_pay.other_deductions IS NULL OR v_pay.net_pay IS NULL
  OR v_pay.gross_pay-v_pay.bale_deduction-v_pay.other_deductions IS DISTINCT FROM v_pay.net_pay THEN RAISE EXCEPTION 'Voucher totals or full Bale deduction require separate reconciliation' USING ERRCODE='22023'; END IF;
 IF p_release_date NOT BETWEEN v_pay.period_start AND v_pay.period_end THEN RAISE EXCEPTION 'Release date is outside original week' USING ERRCODE='22023'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.projects WHERE id=p_project) THEN RAISE EXCEPTION 'Project unavailable' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM public.payroll p WHERE p.id<>p_payroll AND p.worker_id=v_pay.worker_id AND p.period_start<=v_pay.period_end AND p.period_end>=v_pay.period_start)
  OR EXISTS(SELECT 1 FROM public.advances a WHERE a.worker_id=v_pay.worker_id AND a.date BETWEEN v_pay.period_start AND v_pay.period_end)
  OR EXISTS(SELECT 1 FROM public.historical_settled_bale_evidence WHERE payroll_id=p_payroll) THEN
  RAISE EXCEPTION 'Overlapping voucher, Bale or evidence requires separate reconciliation' USING ERRCODE='22023'; END IF;
 SELECT count(*),min(d),min(src) INTO v_count,v_payment,v_source FROM (
  SELECT payment_date d,'recorded_payment'::text src FROM public.payroll_payment_dates WHERE payroll_id=p_payroll
  UNION ALL SELECT payment_date,'historical_annotation' FROM public.historical_paid_date_annotations WHERE payroll_id=p_payroll AND voucher_snapshot=p_expected
 ) dates;
 IF v_count<>1 OR v_payment IS NULL OR NOT isfinite(v_payment) OR v_payment<p_release_date OR v_payment<v_pay.period_start
  OR v_payment>(statement_timestamp() AT TIME ZONE 'Asia/Manila')::date THEN RAISE EXCEPTION 'A single recorded payment-date assertion on or after release is required' USING ERRCODE='22023'; END IF;
 INSERT INTO public.historical_settled_bale_evidence(request_id,payroll_id,worker_id,project_id,recorded_by,release_date,amount,payment_date,payment_date_source,evidence_note,voucher_snapshot)
 VALUES(p_request,p_payroll,v_pay.worker_id,p_project,auth.uid(),p_release_date,p_amount,v_payment,v_source,v_note,p_expected);
 SELECT email INTO v_email FROM public.users WHERE id=auth.uid();
 INSERT INTO public.audit_log(actor_id,actor_email,action,table_name,record_id,before_row,after_row)
 VALUES(auth.uid(),v_email,'insert','historical_settled_bale_evidence',p_request,NULL,jsonb_build_object('payroll_id',p_payroll,'worker_id',v_pay.worker_id,'project_id',p_project,'release_date',p_release_date,'amount',p_amount,'payment_date',v_payment,'payment_date_source',v_source,'evidence_note',v_note,'voucher_snapshot',p_expected));
 RETURN jsonb_build_object('replayed',false,'request_id',p_request,'payroll_id',p_payroll);
END;
$$;
REVOKE ALL ON FUNCTION public.record_historical_settled_bale(uuid,uuid,jsonb,uuid,date,numeric,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.record_historical_settled_bale(uuid,uuid,jsonb,uuid,date,numeric,text) TO authenticated;
DO $$ BEGIN IF has_function_privilege('anon','public.record_historical_settled_bale(uuid,uuid,jsonb,uuid,date,numeric,text)','EXECUTE') OR has_function_privilege('service_role','public.record_historical_settled_bale(uuid,uuid,jsonb,uuid,date,numeric,text)','EXECUTE') THEN RAISE EXCEPTION 'Unexpected inherited historical Bale action privilege'; END IF; END $$;


-- supabase/drafts/historical_finance_evidence_review.sql sha256 44e07fed626c974224c044c7d964ee7df8811d2daa3d4c403681275910a9d9be
-- DRAFT ONLY. Read-only evidence view for the exact historical payment-date
-- and settled Bale candidates. Not a release migration or proof of payment.
-- This returns one bounded voucher's evidence, never changes finance records.
CREATE FUNCTION public.historical_finance_evidence_review(p_payroll uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_pay public.payroll%ROWTYPE; v_date public.historical_paid_date_annotations%ROWTYPE;
 v_bale public.historical_settled_bale_evidence%ROWTYPE; v_payment public.payroll_payment_dates%ROWTYPE;
 v_has_date boolean;v_has_bale boolean;v_has_payment boolean;v_snapshot jsonb;v_result jsonb;v_count integer;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 IF p_payroll IS NULL THEN RAISE EXCEPTION 'Choose a paid voucher' USING ERRCODE='22023'; END IF;
 SELECT * INTO v_pay FROM public.payroll WHERE id=p_payroll AND status='paid';
 IF NOT FOUND THEN RAISE EXCEPTION 'Paid voucher unavailable' USING ERRCODE='P0002'; END IF;
 v_snapshot:=public.historical_paid_voucher_snapshot(v_pay);
 -- The reviewed candidate schemas enforce uniqueness. Fail closed if a later
 -- schema change removes that protection, rather than picking an arbitrary row.
 SELECT count(*) INTO v_count FROM (SELECT 1 FROM public.historical_paid_date_annotations WHERE payroll_id=p_payroll LIMIT 2) x;
 IF v_count>1 THEN RAISE EXCEPTION 'Ambiguous historical payment-date evidence' USING ERRCODE='22023'; END IF;
 SELECT count(*) INTO v_count FROM (SELECT 1 FROM public.historical_settled_bale_evidence WHERE payroll_id=p_payroll LIMIT 2) x;
 IF v_count>1 THEN RAISE EXCEPTION 'Ambiguous historical Bale evidence' USING ERRCODE='22023'; END IF;
 SELECT count(*) INTO v_count FROM (SELECT 1 FROM public.payroll_payment_dates WHERE payroll_id=p_payroll LIMIT 2) x;
 IF v_count>1 THEN RAISE EXCEPTION 'Ambiguous recorded payment-date evidence' USING ERRCODE='22023'; END IF;
 SELECT * INTO v_date FROM public.historical_paid_date_annotations WHERE payroll_id=p_payroll; v_has_date:=FOUND;
 SELECT * INTO v_bale FROM public.historical_settled_bale_evidence WHERE payroll_id=p_payroll; v_has_bale:=FOUND;
 SELECT * INTO v_payment FROM public.payroll_payment_dates WHERE payroll_id=p_payroll; v_has_payment:=FOUND;
 v_result:=jsonb_build_object('payroll_id',p_payroll,'worker_id',v_pay.worker_id,'period_start',v_pay.period_start,'period_end',v_pay.period_end,
  'voucher_snapshot',v_snapshot,
  'payment_conflict',v_has_date AND v_has_payment,
  'recorded_payment_date',CASE WHEN v_has_payment THEN v_payment.payment_date ELSE NULL END,
  'date_evidence',CASE WHEN v_has_date THEN jsonb_build_object('request_id',v_date.request_id,'payment_date',v_date.payment_date,'note',v_date.evidence_note,
   'recorded_at',v_date.recorded_at,'recorded_by',v_date.recorded_by,'matches_voucher',v_date.voucher_snapshot=v_snapshot) ELSE NULL END,
  'bale_evidence',CASE WHEN v_has_bale THEN jsonb_build_object('request_id',v_bale.request_id,'project_id',v_bale.project_id,
   'release_date',v_bale.release_date,'amount',v_bale.amount::numeric(10,2)::text,'payment_date',v_bale.payment_date,'payment_date_source',v_bale.payment_date_source,
   'note',v_bale.evidence_note,'recorded_at',v_bale.recorded_at,'recorded_by',v_bale.recorded_by,'matches_voucher',v_bale.voucher_snapshot=v_snapshot,
   'context_changed',(v_bale.worker_id IS DISTINCT FROM v_pay.worker_id OR v_bale.amount IS DISTINCT FROM v_pay.bale_deduction OR (v_has_date AND v_has_payment)
    OR (v_bale.payment_date_source='recorded_payment' AND (NOT v_has_payment OR v_payment.payment_date IS DISTINCT FROM v_bale.payment_date))
    OR (v_bale.payment_date_source='historical_annotation' AND (NOT v_has_date OR v_date.payment_date IS DISTINCT FROM v_bale.payment_date OR v_date.voucher_snapshot IS DISTINCT FROM v_bale.voucher_snapshot))
    OR EXISTS(SELECT 1 FROM public.advances a WHERE a.worker_id=v_pay.worker_id AND a.date BETWEEN v_pay.period_start AND v_pay.period_end)
    OR EXISTS(SELECT 1 FROM public.payroll p WHERE p.id<>p_payroll AND p.worker_id=v_pay.worker_id AND p.period_start<=v_pay.period_end AND p.period_end>=v_pay.period_start))) ELSE NULL END);
 IF octet_length(v_result::text)>16384 THEN RAISE EXCEPTION 'Evidence response too large' USING ERRCODE='54000'; END IF;
 RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.historical_finance_evidence_review(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.historical_finance_evidence_review(uuid) TO authenticated;
DO $$ BEGIN IF has_function_privilege('anon','public.historical_finance_evidence_review(uuid)','EXECUTE') OR has_function_privilege('service_role','public.historical_finance_evidence_review(uuid)','EXECUTE') THEN RAISE EXCEPTION 'Unexpected inherited historical evidence review privilege'; END IF; END $$;


-- supabase/drafts/historical_external_worker_payroll.sql sha256 cf2e7250a59187c8ec07c536c5462f4fe85adde3a78d95fb4b23590603e572c9
-- EXPERIMENTAL, UNINSTALLED, NOT A COMPLETE ROLLOUT. A Founder assertion that
-- a worker's weekly pay and any stated Bale deduction already happened outside
-- the app. This creates NO payroll voucher, advance, expense, payment, transfer,
-- project allocation or automatic reconciliation. It is NOT proof of payment.
-- The guard triggers affect legacy writers globally and require read committed;
-- load/deadlock review, identity reconciliation, correction design, old-client
-- cutover, hosted catalog checks and recovery are essential before any install.
-- Execute only as a single reviewed transaction on a disposable test database.
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
DO $preflight$
BEGIN
 IF to_regprocedure('auth.uid()') IS NULL OR to_regprocedure('public.is_founder()') IS NULL OR to_regprocedure('public.session_assurance_satisfied()') IS NULL
 OR to_regclass('public.users') IS NULL OR to_regclass('public.workers') IS NULL OR to_regclass('public.payroll') IS NULL OR to_regclass('public.advances') IS NULL THEN RAISE EXCEPTION 'Historical external payroll prerequisites missing'; END IF;
 IF to_regclass('public.historical_external_worker_payroll') IS NOT NULL OR to_regclass('public.historical_external_worker_events') IS NOT NULL
 OR to_regprocedure('public.record_historical_external_worker_payroll(uuid,uuid,date,date,numeric,numeric,numeric,numeric,text,jsonb,boolean)') IS NOT NULL THEN RAISE EXCEPTION 'Historical external payroll name collision'; END IF;
 -- The optional Supervisor ledger is cross-checked at runtime. Both writers
 -- must retain their common users -> workers table-lock order.
 IF EXISTS (SELECT 1 FROM pg_catalog.pg_class WHERE oid IN ('public.payroll'::regclass,'public.advances'::regclass) AND (relkind<>'r' OR NOT relrowsecurity)) THEN RAISE EXCEPTION 'Existing financial tables must have RLS'; END IF;
END;
$preflight$;

CREATE TABLE public.historical_external_worker_payroll (
 request_id uuid PRIMARY KEY,
 worker_id uuid NOT NULL REFERENCES public.workers(id) ON DELETE RESTRICT,
 period_start date NOT NULL,
 period_end date NOT NULL,
 paid_on date NOT NULL,
 gross numeric(10,2) NOT NULL CHECK(gross>=0),
 bale numeric(10,2) NOT NULL CHECK(bale>=0),
 other_deductions numeric(10,2) NOT NULL CHECK(other_deductions>=0),
 net numeric(10,2) NOT NULL CHECK(net>=0),
 evidence_note text NOT NULL CHECK(length(evidence_note) BETWEEN 1 AND 500),
 worker_snapshot jsonb NOT NULL,
 recorded_by uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(period_end=period_start+6 AND extract(dow FROM period_start)=0),
 CHECK(paid_on>=period_start), CHECK(gross-bale-other_deductions=net),
 UNIQUE(worker_id,period_start)
);
CREATE TABLE public.historical_external_worker_events (
 request_id uuid PRIMARY KEY REFERENCES public.historical_external_worker_payroll(request_id) ON DELETE RESTRICT,
 actor_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 action text NOT NULL CHECK(action='recorded'),
 after_row jsonb NOT NULL
);
ALTER TABLE public.historical_external_worker_payroll ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.historical_external_worker_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.historical_external_worker_payroll,public.historical_external_worker_events FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.guard_historical_external_worker_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN RAISE EXCEPTION 'Historical external evidence is immutable; investigate separately' USING ERRCODE='22023'; END;
$$;
REVOKE ALL ON FUNCTION public.guard_historical_external_worker_immutable() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER historical_external_worker_immutable BEFORE UPDATE OR DELETE ON public.historical_external_worker_payroll FOR EACH ROW EXECUTE FUNCTION public.guard_historical_external_worker_immutable();
CREATE TRIGGER historical_external_worker_event_immutable BEFORE UPDATE OR DELETE ON public.historical_external_worker_events FOR EACH ROW EXECUTE FUNCTION public.guard_historical_external_worker_immutable();

-- These guards also affect legacy clients; deny non-read-committed snapshots
-- rather than letting a waiting writer miss a just-committed assertion. The
-- recording path takes conflicting SHARE ROW EXCLUSIVE locks on these tables.
CREATE FUNCTION public.guard_historical_external_payroll_overlap() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Historical payroll guard requires read committed isolation' USING ERRCODE='P1002'; END IF;
 IF NEW.worker_id IS NULL OR NEW.period_start IS NULL OR NEW.period_end IS NULL OR NEW.period_end<NEW.period_start THEN RAISE EXCEPTION 'Invalid payroll period' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM public.historical_external_worker_payroll h WHERE h.worker_id=NEW.worker_id AND h.period_start<=NEW.period_end AND h.period_end>=NEW.period_start) THEN
  RAISE EXCEPTION 'Historical external payroll evidence overlaps this voucher; investigate the original period' USING ERRCODE='22023'; END IF;
 RETURN NEW;
END;
$$;
CREATE FUNCTION public.guard_historical_external_advance_overlap() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Historical advance guard requires read committed isolation' USING ERRCODE='P1002'; END IF;
 IF NEW.worker_id IS NULL OR NEW.date IS NULL THEN RAISE EXCEPTION 'Invalid advance identity or date' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM public.historical_external_worker_payroll h WHERE h.worker_id=NEW.worker_id AND (NEW.date BETWEEN h.period_start AND h.period_end OR (NEW.date<h.period_start AND NEW.status IN ('active','partially_deducted')))) THEN
  RAISE EXCEPTION 'Historical external payroll evidence conflicts with this Bale date or older open balance; investigate the original period' USING ERRCODE='22023'; END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_historical_external_payroll_overlap(),public.guard_historical_external_advance_overlap() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER guard_historical_external_payroll_overlap BEFORE INSERT OR UPDATE ON public.payroll FOR EACH ROW EXECUTE FUNCTION public.guard_historical_external_payroll_overlap();
CREATE TRIGGER guard_historical_external_advance_overlap BEFORE INSERT OR UPDATE ON public.advances FOR EACH ROW EXECUTE FUNCTION public.guard_historical_external_advance_overlap();

CREATE FUNCTION public.historical_external_worker_catalog() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_items jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 IF (SELECT count(*) FROM public.workers)>2000 THEN RAISE EXCEPTION 'Worker catalog exceeds historical-entry limit' USING ERRCODE='54000'; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name,'position',position,'active',active) ORDER BY name,id),'[]'::jsonb) INTO v_items FROM public.workers;
 RETURN jsonb_build_object('workers',v_items);
END;
$$;

CREATE FUNCTION public.historical_external_worker_review(p_worker uuid,p_start date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_worker jsonb; v_name text; v_position text; v_risk boolean; v_supervisor_periods bigint:=0;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 IF p_worker IS NULL OR p_start IS NULL OR NOT isfinite(p_start) OR p_start<DATE '1900-01-01' OR p_start>DATE '9998-12-24' OR extract(dow FROM p_start)<>0 THEN RAISE EXCEPTION 'Choose a worker and Sunday' USING ERRCODE='22023'; END IF;
 SELECT jsonb_build_object('id',id,'name',name,'position',position,'active',active),name,position INTO v_worker,v_name,v_position FROM public.workers WHERE id=p_worker;
 IF NOT FOUND THEN RAISE EXCEPTION 'Worker unavailable' USING ERRCODE='P0002'; END IF;
 SELECT strpos(lower(coalesce(v_position,'')),'supervisor')>0 OR EXISTS(SELECT 1 FROM public.users WHERE role='supervisor' AND (id=p_worker OR lower(btrim(name))=lower(btrim(v_name)))) INTO v_risk;
 -- If the separate candidate is installed, compare both the stored and current
 -- Supervisor names as conservative signals. Shared users/workers locks held by
 -- both write paths serialize the final check; names are not proof of identity.
 IF pg_catalog.to_regclass('public.supervisor_period_payroll') IS NOT NULL THEN
  EXECUTE 'SELECT count(*) FROM public.supervisor_period_payroll p JOIN public.users u ON u.id=p.supervisor_id WHERE p.period_start<=$2+6 AND p.period_end>=$2 AND (p.supervisor_id=$1 OR lower(btrim(p.supervisor_name))=lower(btrim($3)) OR lower(btrim(u.name))=lower(btrim($3)))' INTO v_supervisor_periods USING p_worker,p_start,v_name;
 END IF;
 RETURN jsonb_build_object('worker',v_worker,'start',p_start,'end',p_start+6,'as_of',(statement_timestamp() AT TIME ZONE 'Asia/Manila')::date,'possible_supervisor',v_risk,'supervisor_periods',v_supervisor_periods,
  'possible_worker_duplicate',EXISTS(SELECT 1 FROM public.workers WHERE id<>p_worker AND lower(btrim(name))=lower(btrim(v_name))),
  'overlapping_vouchers',(SELECT count(*) FROM public.payroll WHERE worker_id=p_worker AND period_start<=p_start+6 AND period_end>=p_start),
  'period_advances',(SELECT count(*) FROM public.advances WHERE worker_id=p_worker AND date BETWEEN p_start AND p_start+6),
  'older_open_advances',(SELECT count(*) FROM public.advances WHERE worker_id=p_worker AND date<p_start AND status IN ('active','partially_deducted')),
  'existing_assertions',(SELECT count(*) FROM public.historical_external_worker_payroll WHERE worker_id=p_worker AND period_start<=p_start+6 AND period_end>=p_start));
END;
$$;

CREATE FUNCTION public.record_historical_external_worker_payroll(p_request uuid,p_worker uuid,p_start date,p_paid_on date,p_gross numeric,p_bale numeric,p_other numeric,p_net numeric,p_note text,p_expected_worker jsonb,p_ack boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_previous public.historical_external_worker_payroll%ROWTYPE; v_row public.historical_external_worker_payroll%ROWTYPE; v_review jsonb; v_note text; v_amount numeric;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Historical entry requires read committed isolation' USING ERRCODE='P1002'; END IF;
 IF p_request IS NULL OR p_worker IS NULL OR p_start IS NULL OR NOT isfinite(p_start) OR p_start<DATE '1900-01-01' OR p_start>DATE '9998-12-24' OR extract(dow FROM p_start)<>0
 OR p_paid_on IS NULL OR NOT isfinite(p_paid_on) OR p_paid_on<p_start OR p_paid_on>(statement_timestamp() AT TIME ZONE 'Asia/Manila')::date
 OR p_note IS NULL OR length(btrim(p_note)) NOT BETWEEN 1 AND 500 OR p_expected_worker IS NULL OR p_ack IS DISTINCT FROM true THEN RAISE EXCEPTION 'Invalid date, reviewed worker, note or confirmation' USING ERRCODE='22023'; END IF;
 FOREACH v_amount IN ARRAY ARRAY[p_gross,p_bale,p_other,p_net] LOOP
  IF v_amount IS NULL OR v_amount='NaN'::numeric OR v_amount<0 OR v_amount>=100000000 OR v_amount<>round(v_amount,2) THEN RAISE EXCEPTION 'Invalid monetary amount' USING ERRCODE='22023'; END IF;
 END LOOP;
 IF p_gross-p_bale-p_other<>p_net THEN RAISE EXCEPTION 'Amounts do not reconcile' USING ERRCODE='22023'; END IF;
 v_note:=btrim(p_note);PERFORM pg_catalog.set_config('lock_timeout','3s',true);
 LOCK TABLE public.users,public.workers,public.advances,public.payroll IN SHARE ROW EXCLUSIVE MODE;
 -- The role could have changed while waiting for the lock. Check it again under
 -- the lock before either recording or returning a successful retry.
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 SELECT * INTO v_previous FROM public.historical_external_worker_payroll WHERE request_id=p_request;
 IF FOUND THEN
  IF (v_previous.worker_id,v_previous.period_start,v_previous.paid_on,v_previous.gross,v_previous.bale,v_previous.other_deductions,v_previous.net,v_previous.evidence_note,v_previous.worker_snapshot,v_previous.recorded_by)
   IS DISTINCT FROM (p_worker,p_start,p_paid_on,p_gross,p_bale,p_other,p_net,v_note,p_expected_worker,auth.uid()) THEN RAISE EXCEPTION 'Request ID used for different evidence' USING ERRCODE='22023'; END IF;
  RETURN jsonb_build_object('request_id',p_request,'replayed',true);
 END IF;
 v_review:=public.historical_external_worker_review(p_worker,p_start);
 IF v_review->'worker' IS DISTINCT FROM p_expected_worker THEN RAISE EXCEPTION 'Worker changed; review again' USING ERRCODE='40001'; END IF;
 IF coalesce((v_review->>'possible_supervisor')::boolean,true) OR coalesce((v_review->>'possible_worker_duplicate')::boolean,true) THEN RAISE EXCEPTION 'Possible Supervisor or duplicate worker identity requires separate review' USING ERRCODE='22023'; END IF;
 IF (v_review->>'overlapping_vouchers')::bigint>0 OR (v_review->>'period_advances')::bigint>0 OR (v_review->>'older_open_advances')::bigint>0 OR (v_review->>'existing_assertions')::bigint>0 OR (v_review->>'supervisor_periods')::bigint>0 THEN
  RAISE EXCEPTION 'Existing voucher, Bale or historical evidence requires separate reconciliation' USING ERRCODE='22023'; END IF;
 INSERT INTO public.historical_external_worker_payroll(request_id,worker_id,period_start,period_end,paid_on,gross,bale,other_deductions,net,evidence_note,worker_snapshot,recorded_by)
 VALUES(p_request,p_worker,p_start,p_start+6,p_paid_on,p_gross,p_bale,p_other,p_net,v_note,p_expected_worker,auth.uid()) RETURNING * INTO v_row;
 INSERT INTO public.historical_external_worker_events(request_id,actor_id,action,after_row) VALUES(p_request,auth.uid(),'recorded',to_jsonb(v_row));
 RETURN jsonb_build_object('request_id',p_request,'replayed',false);
END;
$$;

-- Founder-only bounded read; no direct table privileges are granted.
CREATE FUNCTION public.historical_external_worker_list(p_worker uuid,p_offset integer DEFAULT 0) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_total bigint; v_items jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 IF p_worker IS NULL OR p_offset IS NULL OR p_offset<0 OR p_offset>1000000 THEN RAISE EXCEPTION 'Invalid history request' USING ERRCODE='22023'; END IF;
 SELECT count(*) INTO v_total FROM public.historical_external_worker_payroll WHERE worker_id=p_worker;
 SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.period_start DESC,x.request_id),'[]'::jsonb) INTO v_items FROM (
  SELECT request_id,worker_id,period_start,period_end,paid_on,gross::text,bale::text,other_deductions::text,net::text,evidence_note,worker_snapshot,recorded_by,recorded_at
  FROM public.historical_external_worker_payroll WHERE worker_id=p_worker ORDER BY period_start DESC,request_id LIMIT 100 OFFSET p_offset
 ) x;
 RETURN jsonb_build_object('total',v_total,'offset',p_offset,'items',v_items);
END;
$$;
CREATE FUNCTION public.historical_external_worker_lookup(p_request uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_row jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 IF p_request IS NULL THEN RAISE EXCEPTION 'Invalid request' USING ERRCODE='22023'; END IF;
 SELECT to_jsonb(x) INTO v_row FROM (SELECT request_id,worker_id,period_start,period_end,paid_on,gross::text,bale::text,other_deductions::text,net::text,evidence_note,worker_snapshot,recorded_by,recorded_at FROM public.historical_external_worker_payroll WHERE request_id=p_request) x;
 RETURN v_row;
END;
$$;
REVOKE ALL ON FUNCTION public.historical_external_worker_catalog(),public.historical_external_worker_review(uuid,date),public.record_historical_external_worker_payroll(uuid,uuid,date,date,numeric,numeric,numeric,numeric,text,jsonb,boolean),public.historical_external_worker_list(uuid,integer),public.historical_external_worker_lookup(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.historical_external_worker_catalog(),public.historical_external_worker_review(uuid,date),public.record_historical_external_worker_payroll(uuid,uuid,date,date,numeric,numeric,numeric,numeric,text,jsonb,boolean),public.historical_external_worker_list(uuid,integer),public.historical_external_worker_lookup(uuid) TO authenticated;
DO $postflight$
DECLARE v text;
BEGIN
 FOREACH v IN ARRAY ARRAY['public.historical_external_worker_payroll','public.historical_external_worker_events'] LOOP
  IF EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r WHERE has_table_privilege(r,v,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
   OR EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a CROSS JOIN unnest(ARRAY['anon','authenticated','service_role']) r WHERE a.attrelid=to_regclass(v) AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege(r,a.attrelid,a.attname,'SELECT,INSERT,UPDATE,REFERENCES')) THEN RAISE EXCEPTION 'Unexpected external history table privileges'; END IF;
 END LOOP;
 FOREACH v IN ARRAY ARRAY['public.historical_external_worker_catalog()','public.historical_external_worker_review(uuid,date)','public.record_historical_external_worker_payroll(uuid,uuid,date,date,numeric,numeric,numeric,numeric,text,jsonb,boolean)','public.historical_external_worker_list(uuid,integer)','public.historical_external_worker_lookup(uuid)'] LOOP
  IF has_function_privilege('anon',v,'EXECUTE') OR has_function_privilege('service_role',v,'EXECUTE') OR NOT has_function_privilege('authenticated',v,'EXECUTE') THEN RAISE EXCEPTION 'Unexpected external history RPC privileges'; END IF;
 END LOOP;
END;
$postflight$;


-- supabase/drafts/supervisor_payroll_ledger.sql sha256 18da64af9aa97e055bb3fd9e1f610c9c7a67820f9e90925628a58e302af53582
-- EXPERIMENTAL, UNINSTALLED: NOT A PRODUCTION MIGRATION OR A PAYMENT SYSTEM.
-- Requires the reviewed Supervisor foundation, RPC rollout and preview draft.
-- A manually entered daily rate is an assumption, not approved rate policy.
-- This separate ledger does not create legacy vouchers, expenses, transfers or
-- project allocations. Global legacy guards and broad table locks can disrupt
-- old clients and require coordinated identity, load/deadlock and cutover review.
-- Late changes are detected, not automatically included in a later period.
-- No correction, void or payment-reversal workflow is provided. Do not install
-- or enable on hosted/shared data; execute only in a disposable test database.
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
DO $preflight$
BEGIN
 IF to_regprocedure('public.supervisor_payroll_preview_inputs(uuid,date)') IS NULL OR to_regprocedure('public.is_founder()') IS NULL OR to_regprocedure('public.session_assurance_satisfied()') IS NULL OR to_regprocedure('auth.uid()') IS NULL OR to_regclass('public.supervisor_daily_attendance') IS NULL OR to_regclass('public.supervisor_leave_requests') IS NULL OR to_regclass('public.users') IS NULL OR to_regclass('public.workers') IS NULL OR to_regclass('public.attendance') IS NULL OR to_regclass('public.payroll') IS NULL THEN RAISE EXCEPTION 'Supervisor ledger prerequisites missing'; END IF;
 IF to_regclass('public.supervisor_period_payroll') IS NOT NULL OR to_regclass('public.supervisor_period_payroll_events') IS NOT NULL OR to_regprocedure('public.create_supervisor_period_draft(uuid,uuid,date,numeric,jsonb)') IS NOT NULL THEN RAISE EXCEPTION 'Supervisor ledger name collision'; END IF;
 -- The optional historical-worker candidate is cross-checked at runtime.
 -- Its writer and this writer must both lock users -> workers first.
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_class WHERE oid IN ('public.payroll'::regclass,'public.supervisor_daily_attendance'::regclass,'public.supervisor_leave_requests'::regclass) AND (relkind<>'r' OR NOT relrowsecurity)) THEN RAISE EXCEPTION 'Supervisor ledger prerequisites require RLS'; END IF;
END;
$preflight$;

CREATE TABLE public.supervisor_period_payroll (
 id uuid PRIMARY KEY,
 supervisor_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 supervisor_name text NOT NULL,
 period_start date NOT NULL,
 period_end date NOT NULL,
 daily_rate numeric(10,2) NOT NULL CHECK(daily_rate>0),
 half_day_units integer NOT NULL CHECK(half_day_units>=0),
 gross numeric(10,2) NOT NULL CHECK(gross>=0),
 source_snapshot jsonb NOT NULL,
 unmarked_dates jsonb NOT NULL,
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved','paid')),
 created_by uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 approved_by uuid REFERENCES public.users(id) ON DELETE RESTRICT,
 approved_at timestamptz,
 paid_on date,
 paid_by uuid REFERENCES public.users(id) ON DELETE RESTRICT,
 recorded_paid_at timestamptz,
 UNIQUE(supervisor_id,period_start),
 CHECK(extract(day FROM period_start) IN (1,16)),
 CHECK(period_end=CASE WHEN extract(day FROM period_start)=1 THEN period_start+14 ELSE (period_start+interval '1 month'-interval '16 days')::date END),
 CHECK((status='draft' AND approved_by IS NULL AND approved_at IS NULL AND paid_on IS NULL AND paid_by IS NULL AND recorded_paid_at IS NULL)
    OR (status='approved' AND approved_by IS NOT NULL AND approved_at IS NOT NULL AND paid_on IS NULL AND paid_by IS NULL AND recorded_paid_at IS NULL)
    OR (status='paid' AND approved_by IS NOT NULL AND approved_at IS NOT NULL AND paid_on IS NOT NULL AND paid_by IS NOT NULL AND recorded_paid_at IS NOT NULL))
);
CREATE TABLE public.supervisor_period_payroll_events (
 request_id uuid PRIMARY KEY,
 payroll_id uuid NOT NULL REFERENCES public.supervisor_period_payroll(id) ON DELETE RESTRICT,
 action text NOT NULL CHECK(action IN ('created','approved','recorded_paid')),
 actor_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 arguments jsonb NOT NULL,
 after_row jsonb NOT NULL
);
ALTER TABLE public.supervisor_period_payroll ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.supervisor_period_payroll_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.supervisor_period_payroll,public.supervisor_period_payroll_events FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.guard_supervisor_payroll_events_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN RAISE EXCEPTION 'Supervisor payroll events are immutable' USING ERRCODE='22023'; END;
$$;
REVOKE ALL ON FUNCTION public.guard_supervisor_payroll_events_immutable() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER guard_supervisor_payroll_events_immutable BEFORE UPDATE OR DELETE ON public.supervisor_period_payroll_events FOR EACH ROW EXECUTE FUNCTION public.guard_supervisor_payroll_events_immutable();

-- The recording functions lock legacy payroll before checking it. Existing
-- writers take ROW EXCLUSIVE on payroll; the trigger performs a fresh statement
-- check after a wait. Repeatable-read/serializable clients must fail closed.
CREATE FUNCTION public.guard_legacy_supervisor_period_overlap() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Supervisor payroll guard requires read committed isolation' USING ERRCODE='P1002'; END IF;
 IF NEW.worker_id IS NULL OR NEW.period_start IS NULL OR NEW.period_end IS NULL OR NEW.period_end<NEW.period_start THEN RAISE EXCEPTION 'Invalid legacy voucher identity or period' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM public.supervisor_period_payroll s JOIN public.workers w ON w.id=NEW.worker_id JOIN public.users u ON u.id=s.supervisor_id
  WHERE (w.id=s.supervisor_id OR lower(btrim(w.name)) IN (lower(btrim(s.supervisor_name)),lower(btrim(u.name)))) AND s.period_start<=NEW.period_end AND s.period_end>=NEW.period_start) THEN
  RAISE EXCEPTION 'Possible overlap with Supervisor ledger; review identity and original period' USING ERRCODE='22023'; END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_legacy_supervisor_period_overlap() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER guard_legacy_supervisor_period_overlap BEFORE INSERT OR UPDATE ON public.payroll FOR EACH ROW EXECUTE FUNCTION public.guard_legacy_supervisor_period_overlap();

-- Optional cross-ledger signal. This private helper is called after the common
-- users -> workers write locks during creation/transition; it is also called in
-- read-only preparation. UUID and names are risk signals, not proof of identity.
CREATE FUNCTION public.supervisor_period_external_conflicts(p_supervisor uuid,p_start date,p_end date) RETURNS bigint
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_count bigint:=0;v_name text;
BEGIN
 IF pg_catalog.to_regclass('public.historical_external_worker_payroll') IS NULL THEN RETURN 0; END IF;
 SELECT name INTO v_name FROM public.users WHERE id=p_supervisor;
 IF NOT FOUND THEN RAISE EXCEPTION 'Supervisor identity unavailable' USING ERRCODE='22023'; END IF;
 EXECUTE 'SELECT count(*) FROM public.historical_external_worker_payroll h JOIN public.workers w ON w.id=h.worker_id WHERE h.period_start<=$3 AND h.period_end>=$2 AND (h.worker_id=$1 OR lower(btrim(h.worker_snapshot->>''name''))=lower(btrim($4)) OR lower(btrim(w.name))=lower(btrim($4)))' INTO v_count USING p_supervisor,p_start,p_end,v_name;
 RETURN v_count;
END;
$$;
REVOKE ALL ON FUNCTION public.supervisor_period_external_conflicts(uuid,date,date) FROM PUBLIC,anon,authenticated,service_role;

-- Called only while the invoking writer holds all source locks. Capture identity
-- and all relevant pending/approved day/leave records, not project assignments.
CREATE FUNCTION public.supervisor_period_compute_locked(p_supervisor uuid,p_start date,p_rate numeric) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_input jsonb; v_sources jsonb; v_day jsonb; v_date date; v_today date; v_approved integer; v_units integer:=0; v_known integer:=0; v_unmarked jsonb:='[]'::jsonb; v_gross numeric; v_person jsonb; v_worker jsonb; v_external bigint;
BEGIN
 v_input:=public.supervisor_payroll_preview_inputs(p_supervisor,p_start);
 v_today:=(clock_timestamp() AT TIME ZONE 'Asia/Manila')::date;
 IF (v_input->>'as_of')::date<>v_today THEN RAISE EXCEPTION 'Philippine date changed; reload' USING ERRCODE='40001'; END IF;
 IF coalesce((v_input->>'identity_needs_review')::boolean,true) OR coalesce((v_input->>'legacy_count')::bigint,-1)<>0 OR coalesce((v_input->>'overlapping_vouchers')::bigint,-1)<>0 THEN
  RAISE EXCEPTION 'Supervisor identity or legacy records require separate reconciliation' USING ERRCODE='22023'; END IF;
 IF jsonb_typeof(v_input->'days') IS DISTINCT FROM 'array' OR jsonb_typeof(v_input->'leave') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Incomplete Supervisor sources' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_input->'days') d WHERE d->>'status'<>'approved' OR (d->>'date')::date>v_today)
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_input->'leave') l WHERE l->>'status'<>'approved') THEN RAISE EXCEPTION 'Pending or future daily records require review' USING ERRCODE='22023'; END IF;
 FOR v_date IN SELECT generate_series(p_start::timestamp,((v_input->>'end')::date)::timestamp,interval '1 day')::date LOOP
  SELECT count(*) INTO v_approved FROM jsonb_array_elements(v_input->'leave') l WHERE (l->>'start')::date<=v_date AND (l->>'end')::date>=v_date;
  SELECT d INTO v_day FROM jsonb_array_elements(v_input->'days') d WHERE (d->>'date')::date=v_date;
  IF v_approved>1 OR (v_approved>0 AND v_day IS NOT NULL) THEN RAISE EXCEPTION 'Conflicting Supervisor attendance and leave' USING ERRCODE='22023'; END IF;
  IF v_day IS NOT NULL THEN
   IF v_day->>'work_status' NOT IN ('present','half_day','absent') THEN RAISE EXCEPTION 'Invalid Supervisor work status' USING ERRCODE='22023'; END IF;
   v_known:=v_known+1;v_units:=v_units+CASE v_day->>'work_status' WHEN 'present' THEN 2 WHEN 'half_day' THEN 1 ELSE 0 END;
  ELSIF v_approved>0 AND v_date<=v_today THEN v_known:=v_known+1;
  ELSIF v_approved=0 THEN v_unmarked:=v_unmarked||to_jsonb(v_date);
  END IF;
 END LOOP;
 IF v_known=0 THEN RAISE EXCEPTION 'No approved day or past leave; unmarked is not absent' USING ERRCODE='22023'; END IF;
 v_gross:=round(p_rate*v_units/2,2);IF v_gross>=100000000 THEN RAISE EXCEPTION 'Supervisor amount exceeds ledger limit' USING ERRCODE='22023'; END IF;
 SELECT jsonb_build_object('id',id,'name',name,'role',role) INTO v_person FROM public.users WHERE id=p_supervisor AND role='supervisor';
 SELECT jsonb_build_object('id',id,'name',name,'position',position,'active',active) INTO v_worker FROM public.workers WHERE id=p_supervisor;
 IF v_person IS NULL OR v_worker IS NULL OR NOT coalesce((v_worker->>'active')::boolean,false) OR lower(btrim(v_person->>'name')) IS DISTINCT FROM lower(btrim(v_worker->>'name')) THEN RAISE EXCEPTION 'Supervisor linked worker identity requires separate reconciliation' USING ERRCODE='22023'; END IF;
 v_external:=public.supervisor_period_external_conflicts(p_supervisor,p_start,(v_input->>'end')::date);
 IF v_external<>0 THEN RAISE EXCEPTION 'Possible historical worker payroll overlap requires separate reconciliation' USING ERRCODE='22023'; END IF;
 v_sources:=jsonb_build_object('person',v_person,'linked_worker',v_worker,'input',v_input-'as_of','historical_worker_conflicts',v_external);
 RETURN jsonb_build_object('input',v_input,'sources',v_sources,'unmarked',v_unmarked,'half_day_units',v_units,'gross',v_gross::numeric(10,2)::text);
END;
$$;
REVOKE ALL ON FUNCTION public.supervisor_period_compute_locked(uuid,date,numeric) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.supervisor_period_prepare(p_supervisor uuid,p_start date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_input jsonb;v_person jsonb;v_worker jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 v_input:=public.supervisor_payroll_preview_inputs(p_supervisor,p_start);
 SELECT jsonb_build_object('id',id,'name',name,'role',role) INTO v_person FROM public.users WHERE id=p_supervisor AND role='supervisor';
 SELECT jsonb_build_object('id',id,'name',name,'position',position,'active',active) INTO v_worker FROM public.workers WHERE id=p_supervisor;
 RETURN jsonb_build_object('person',v_person,'linked_worker',v_worker,'input',v_input,'historical_worker_conflicts',public.supervisor_period_external_conflicts(p_supervisor,p_start,(v_input->>'end')::date));
END;
$$;

CREATE FUNCTION public.create_supervisor_period_draft(p_id uuid,p_supervisor uuid,p_start date,p_rate numeric,p_expected jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_prev public.supervisor_period_payroll%ROWTYPE;v_event public.supervisor_period_payroll_events%ROWTYPE;v_calc jsonb;v_row public.supervisor_period_payroll%ROWTYPE;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Supervisor payroll requires read committed isolation' USING ERRCODE='P1002'; END IF;
 IF p_id IS NULL OR p_supervisor IS NULL OR p_expected IS NULL OR p_rate IS NULL OR p_rate='NaN'::numeric OR p_rate<=0 OR p_rate>=100000000 OR p_rate<>round(p_rate,2) OR p_start IS NULL OR NOT isfinite(p_start) OR p_start<DATE '1900-01-01' OR p_start>DATE '9998-12-16' OR extract(day FROM p_start) NOT IN (1,16) THEN RAISE EXCEPTION 'Invalid Supervisor, period, rate or snapshot' USING ERRCODE='22023'; END IF;
 PERFORM pg_catalog.set_config('lock_timeout','3s',true);
 LOCK TABLE public.users,public.workers,public.attendance,public.payroll,public.supervisor_daily_attendance,public.supervisor_leave_requests,public.supervisor_period_payroll,public.supervisor_period_payroll_events IN SHARE ROW EXCLUSIVE MODE;
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 SELECT * INTO v_prev FROM public.supervisor_period_payroll WHERE id=p_id;
 IF FOUND THEN
  SELECT * INTO v_event FROM public.supervisor_period_payroll_events WHERE request_id=p_id;
  IF NOT FOUND OR v_event.action<>'created' OR v_event.payroll_id<>p_id OR v_event.actor_id<>auth.uid() OR v_event.arguments->'expected' IS DISTINCT FROM p_expected OR (v_prev.supervisor_id,v_prev.period_start,v_prev.daily_rate,v_prev.created_by) IS DISTINCT FROM (p_supervisor,p_start,p_rate,auth.uid()) THEN RAISE EXCEPTION 'Request ID used for different Supervisor draft' USING ERRCODE='22023'; END IF;
  RETURN jsonb_build_object('id',p_id,'replayed',true);
 END IF;
 IF EXISTS(SELECT 1 FROM public.supervisor_period_payroll WHERE supervisor_id=p_supervisor AND period_start=p_start) THEN RAISE EXCEPTION 'Supervisor period already exists; investigate' USING ERRCODE='22023'; END IF;
 v_calc:=public.supervisor_period_compute_locked(p_supervisor,p_start,p_rate);
 IF (v_calc->'sources'||jsonb_build_object('input',v_calc->'input')) IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'Supervisor identity or source snapshot changed; reload' USING ERRCODE='40001'; END IF;
 INSERT INTO public.supervisor_period_payroll(id,supervisor_id,supervisor_name,period_start,period_end,daily_rate,half_day_units,gross,source_snapshot,unmarked_dates,created_by)
 VALUES(p_id,p_supervisor,v_calc->'sources'->'person'->>'name',p_start,(v_calc->'input'->>'end')::date,p_rate,(v_calc->>'half_day_units')::integer,(v_calc->>'gross')::numeric,v_calc->'sources',v_calc->'unmarked',auth.uid()) RETURNING * INTO v_row;
 INSERT INTO public.supervisor_period_payroll_events(request_id,payroll_id,action,actor_id,arguments,after_row) VALUES(p_id,p_id,'created',auth.uid(),jsonb_build_object('rate',p_rate::numeric(10,2)::text,'expected',p_expected),to_jsonb(v_row));
 RETURN jsonb_build_object('id',p_id,'replayed',false);
END;
$$;

CREATE FUNCTION public.transition_supervisor_period_payroll(p_request uuid,p_id uuid,p_action text,p_paid_on date,p_ack boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_prev public.supervisor_period_payroll_events%ROWTYPE;v_row public.supervisor_period_payroll%ROWTYPE;v_calc jsonb;v_args jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Supervisor payroll requires read committed isolation' USING ERRCODE='P1002'; END IF;
 IF p_request IS NULL OR p_id IS NULL OR p_action NOT IN ('approved','recorded_paid') OR p_action IS NULL OR p_ack IS DISTINCT FROM true OR (p_action='approved' AND p_paid_on IS NOT NULL) OR (p_action='recorded_paid' AND (p_paid_on IS NULL OR NOT isfinite(p_paid_on) OR p_paid_on<DATE '1900-01-01' OR p_paid_on>(clock_timestamp() AT TIME ZONE 'Asia/Manila')::date)) THEN RAISE EXCEPTION 'Invalid Supervisor payroll decision or confirmation' USING ERRCODE='22023'; END IF;
 v_args:=jsonb_build_object('paid_on',p_paid_on);
 PERFORM pg_catalog.set_config('lock_timeout','3s',true);
 LOCK TABLE public.users,public.workers,public.attendance,public.payroll,public.supervisor_daily_attendance,public.supervisor_leave_requests,public.supervisor_period_payroll,public.supervisor_period_payroll_events IN SHARE ROW EXCLUSIVE MODE;
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 SELECT * INTO v_prev FROM public.supervisor_period_payroll_events WHERE request_id=p_request;
 IF FOUND THEN
  IF (v_prev.payroll_id,v_prev.action,v_prev.actor_id,v_prev.arguments) IS DISTINCT FROM (p_id,p_action,auth.uid(),v_args) THEN RAISE EXCEPTION 'Request ID used for different Supervisor decision' USING ERRCODE='22023'; END IF;
  RETURN jsonb_build_object('id',p_id,'request_id',p_request,'replayed',true);
 END IF;
 SELECT * INTO v_row FROM public.supervisor_period_payroll WHERE id=p_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Supervisor payroll not found' USING ERRCODE='P0002'; END IF;
 IF (p_action='approved' AND v_row.status<>'draft') OR (p_action='recorded_paid' AND (v_row.status<>'approved' OR p_paid_on<v_row.period_start)) THEN RAISE EXCEPTION 'Supervisor payroll status or payment date requires review' USING ERRCODE='22023'; END IF;
 v_calc:=public.supervisor_period_compute_locked(v_row.supervisor_id,v_row.period_start,v_row.daily_rate);
 IF v_calc->'sources' IS DISTINCT FROM v_row.source_snapshot OR (v_calc->>'gross')::numeric IS DISTINCT FROM v_row.gross OR (v_calc->>'half_day_units')::integer IS DISTINCT FROM v_row.half_day_units THEN RAISE EXCEPTION 'Supervisor sources changed; review original period' USING ERRCODE='40001'; END IF;
 IF p_action='approved' THEN
  UPDATE public.supervisor_period_payroll SET status='approved',approved_by=auth.uid(),approved_at=clock_timestamp() WHERE id=p_id RETURNING * INTO v_row;
 ELSE
  UPDATE public.supervisor_period_payroll SET status='paid',paid_on=p_paid_on,paid_by=auth.uid(),recorded_paid_at=clock_timestamp() WHERE id=p_id RETURNING * INTO v_row;
 END IF;
 INSERT INTO public.supervisor_period_payroll_events(request_id,payroll_id,action,actor_id,arguments,after_row) VALUES(p_request,p_id,p_action,auth.uid(),v_args,to_jsonb(v_row));
 RETURN jsonb_build_object('id',p_id,'request_id',p_request,'replayed',false);
END;
$$;

-- Founder-only single-period read. A changed snapshot is a review signal, not a
-- computed adjustment. Approved/paid records never change as a consequence.
CREATE FUNCTION public.supervisor_period_payroll_review(p_supervisor uuid,p_start date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_row public.supervisor_period_payroll%ROWTYPE;v_input jsonb;v_person jsonb;v_worker jsonb;v_current jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 IF p_supervisor IS NULL OR p_start IS NULL OR NOT isfinite(p_start) OR p_start<DATE '1900-01-01' OR p_start>DATE '9998-12-16' OR extract(day FROM p_start) NOT IN (1,16) THEN RAISE EXCEPTION 'Invalid Supervisor period' USING ERRCODE='22023'; END IF;
 SELECT * INTO v_row FROM public.supervisor_period_payroll WHERE supervisor_id=p_supervisor AND period_start=p_start;
 IF NOT FOUND THEN RETURN NULL; END IF;
 v_input:=public.supervisor_payroll_preview_inputs(p_supervisor,p_start);
 SELECT jsonb_build_object('id',id,'name',name,'role',role) INTO v_person FROM public.users WHERE id=p_supervisor;
 SELECT jsonb_build_object('id',id,'name',name,'position',position,'active',active) INTO v_worker FROM public.workers WHERE id=p_supervisor;
 v_current:=jsonb_build_object('person',v_person,'linked_worker',v_worker,'input',v_input-'as_of','historical_worker_conflicts',public.supervisor_period_external_conflicts(p_supervisor,p_start,v_row.period_end));
 RETURN jsonb_build_object('id',v_row.id,'supervisor_id',v_row.supervisor_id,'supervisor_name',v_row.supervisor_name,'period_start',v_row.period_start,'period_end',v_row.period_end,'daily_rate',v_row.daily_rate::text,'half_day_units',v_row.half_day_units,'gross',v_row.gross::text,'status',v_row.status,'unmarked_dates',v_row.unmarked_dates,'source_fingerprint',pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object('source_snapshot',v_row.source_snapshot,'unmarked_dates',v_row.unmarked_dates)::text,'UTF8')),'hex'),'paid_on',v_row.paid_on,'created_by',v_row.created_by,'created_at',v_row.created_at,'approved_by',v_row.approved_by,'approved_at',v_row.approved_at,'paid_by',v_row.paid_by,'recorded_paid_at',v_row.recorded_paid_at,'source_changed',v_current IS DISTINCT FROM v_row.source_snapshot,'as_of',v_input->'as_of');
END;
$$;
-- Extend existing Founder queue signals without changing Supervisor visibility.
-- Old function names are no longer directly executable; wrappers preserve paging
-- and add a flag when this new ledger marks the request's period paid.
ALTER FUNCTION public.supervisor_leave_list(integer) RENAME TO supervisor_leave_list_before_ledger;
ALTER FUNCTION public.supervisor_day_list(integer) RENAME TO supervisor_day_list_before_ledger;
REVOKE ALL ON FUNCTION public.supervisor_leave_list_before_ledger(integer),public.supervisor_day_list_before_ledger(integer) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.supervisor_leave_list(p_offset integer DEFAULT 0) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_data jsonb;v_items jsonb;
BEGIN
 v_data:=public.supervisor_leave_list_before_ledger(p_offset);
 IF NOT coalesce(public.is_founder(),false) THEN RETURN v_data; END IF;
 SELECT coalesce(jsonb_agg(jsonb_set(x.value,'{possible_paid_overlap}',to_jsonb(coalesce((x.value->>'possible_paid_overlap')::boolean,false) OR EXISTS(
  SELECT 1 FROM public.supervisor_leave_requests l JOIN public.supervisor_period_payroll p ON p.supervisor_id=l.supervisor_id AND p.status='paid' AND p.period_start<=l.end_date AND p.period_end>=l.start_date WHERE l.id=(x.value->>'id')::uuid))) ORDER BY x.ordinality),'[]'::jsonb) INTO v_items
 FROM jsonb_array_elements(v_data->'items') WITH ORDINALITY x(value,ordinality);
 RETURN jsonb_set(v_data,'{items}',v_items);
END;
$$;
CREATE FUNCTION public.supervisor_day_list(p_offset integer DEFAULT 0) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_data jsonb;v_items jsonb;
BEGIN
 v_data:=public.supervisor_day_list_before_ledger(p_offset);
 IF NOT coalesce(public.is_founder(),false) THEN RETURN v_data; END IF;
 SELECT coalesce(jsonb_agg(jsonb_set(x.value,'{possible_paid_overlap}',to_jsonb(coalesce((x.value->>'possible_paid_overlap')::boolean,false) OR EXISTS(
  SELECT 1 FROM public.supervisor_daily_attendance d JOIN public.supervisor_period_payroll p ON p.supervisor_id=d.supervisor_id AND p.status='paid' AND d.work_date BETWEEN p.period_start AND p.period_end WHERE d.id=(x.value->>'id')::uuid))) ORDER BY x.ordinality),'[]'::jsonb) INTO v_items
 FROM jsonb_array_elements(v_data->'items') WITH ORDINALITY x(value,ordinality);
 RETURN jsonb_set(v_data,'{items}',v_items);
END;
$$;
REVOKE ALL ON FUNCTION public.supervisor_leave_list(integer),public.supervisor_day_list(integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.supervisor_leave_list(integer),public.supervisor_day_list(integer) TO authenticated;

-- Separate paid evidence only; not an expense posting or a deduplicated company
-- total. The caller must reconcile legacy payroll and manual wage expenses.
CREATE FUNCTION public.supervisor_paid_company_evidence(p_from date,p_to date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_count bigint;v_total numeric;v_items jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 IF p_from IS NULL OR p_to IS NULL OR NOT isfinite(p_from) OR NOT isfinite(p_to) OR p_from<DATE '1900-01-01' OR p_to>DATE '9998-12-31' OR p_to<p_from OR p_to-p_from>365 THEN RAISE EXCEPTION 'Choose a valid payment date range up to 366 days' USING ERRCODE='22023'; END IF;
 SELECT count(*),coalesce(sum(gross),0) INTO v_count,v_total FROM public.supervisor_period_payroll WHERE status='paid' AND paid_on BETWEEN p_from AND p_to;
 IF v_count>500 THEN RAISE EXCEPTION 'Supervisor paid evidence exceeds 500 items; choose a shorter range' USING ERRCODE='54000'; END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.paid_on,x.id),'[]'::jsonb) INTO v_items FROM (
  SELECT id,supervisor_id,supervisor_name,period_start,period_end,paid_on,gross::text FROM public.supervisor_period_payroll WHERE status='paid' AND paid_on BETWEEN p_from AND p_to
 ) x;
 RETURN jsonb_build_object('from',p_from,'to',p_to,'total',v_total::numeric(14,2)::text,'count',v_count,'items',v_items);
END;
$$;
REVOKE ALL ON FUNCTION public.supervisor_paid_company_evidence(date,date),public.supervisor_period_prepare(uuid,date),public.create_supervisor_period_draft(uuid,uuid,date,numeric,jsonb),public.transition_supervisor_period_payroll(uuid,uuid,text,date,boolean),public.supervisor_period_payroll_review(uuid,date) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.supervisor_paid_company_evidence(date,date),public.supervisor_period_prepare(uuid,date),public.create_supervisor_period_draft(uuid,uuid,date,numeric,jsonb),public.transition_supervisor_period_payroll(uuid,uuid,text,date,boolean),public.supervisor_period_payroll_review(uuid,date) TO authenticated;
DO $postflight$
DECLARE v text;
BEGIN
 FOREACH v IN ARRAY ARRAY['public.supervisor_period_payroll','public.supervisor_period_payroll_events'] LOOP
  IF EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r WHERE has_table_privilege(r,v,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a CROSS JOIN unnest(ARRAY['anon','authenticated','service_role']) r WHERE a.attrelid=to_regclass(v) AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege(r,a.attrelid,a.attname,'SELECT,INSERT,UPDATE,REFERENCES')) THEN RAISE EXCEPTION 'Unexpected Supervisor ledger table privileges'; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r CROSS JOIN unnest(ARRAY['public.supervisor_leave_list_before_ledger(integer)','public.supervisor_day_list_before_ledger(integer)','public.supervisor_period_compute_locked(uuid,date,numeric)','public.supervisor_period_external_conflicts(uuid,date,date)','public.guard_legacy_supervisor_period_overlap()','public.guard_supervisor_payroll_events_immutable()']) f WHERE has_function_privilege(r,f,'EXECUTE')) THEN RAISE EXCEPTION 'Unexpected internal Supervisor ledger privilege'; END IF;
 FOREACH v IN ARRAY ARRAY['public.supervisor_leave_list(integer)','public.supervisor_day_list(integer)','public.supervisor_paid_company_evidence(date,date)','public.supervisor_period_prepare(uuid,date)','public.create_supervisor_period_draft(uuid,uuid,date,numeric,jsonb)','public.transition_supervisor_period_payroll(uuid,uuid,text,date,boolean)','public.supervisor_period_payroll_review(uuid,date)'] LOOP
  IF has_function_privilege('anon',v,'EXECUTE') OR has_function_privilege('service_role',v,'EXECUTE') OR NOT has_function_privilege('authenticated',v,'EXECUTE') THEN RAISE EXCEPTION 'Unexpected Supervisor ledger RPC privilege'; END IF;
 END LOOP;
END;
$postflight$;


-- supabase/drafts/paid_period_assertion_adjustments.sql sha256 9e036720335046168837ab9854d14b28db14e5a0e64a6f527a88128229168dbc
-- EXPERIMENTAL, UNINSTALLED. Separate review cases against a paid Supervisor
-- ledger or an externally paid worker assertion. No original row, advance,
-- payment, expense, allocation or future period is changed. A resolution is a
-- human assertion, not a transfer or proof. No partial settlement, void, source
-- identity repair or accounting posting. Apply only to a disposable test DB.
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
DO $preflight$
BEGIN
 IF to_regclass('public.supervisor_period_payroll') IS NULL OR to_regclass('public.historical_external_worker_payroll') IS NULL OR to_regprocedure('public.is_founder()') IS NULL OR to_regprocedure('public.session_assurance_satisfied()') IS NULL OR to_regprocedure('auth.uid()') IS NULL THEN RAISE EXCEPTION 'Paid period case prerequisites missing'; END IF;
 IF to_regclass('public.paid_period_assertion_cases') IS NOT NULL OR to_regclass('public.paid_period_assertion_case_events') IS NOT NULL OR to_regprocedure('public.open_paid_period_assertion_case(uuid,text,uuid,jsonb,numeric,text)') IS NOT NULL THEN RAISE EXCEPTION 'Paid period case name collision'; END IF;
END;
$preflight$;
CREATE TABLE public.paid_period_assertion_cases (
 id uuid PRIMARY KEY,
 source_kind text NOT NULL CHECK(source_kind IN ('supervisor','external_worker')),
 supervisor_payroll_id uuid REFERENCES public.supervisor_period_payroll(id) ON DELETE RESTRICT,
 external_worker_id uuid REFERENCES public.historical_external_worker_payroll(request_id) ON DELETE RESTRICT,
 original_snapshot jsonb NOT NULL,
 difference numeric(12,2) NOT NULL CHECK(difference<>0),
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 500),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','settled_external','no_transfer')),
 created_by uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 resolved_by uuid REFERENCES public.users(id) ON DELETE RESTRICT,
 resolved_at timestamptz,
 settled_on date,
 resolution_note text,
 CHECK((source_kind='supervisor' AND supervisor_payroll_id IS NOT NULL AND external_worker_id IS NULL) OR (source_kind='external_worker' AND supervisor_payroll_id IS NULL AND external_worker_id IS NOT NULL)),
 CHECK((status='pending' AND resolved_by IS NULL AND resolved_at IS NULL AND settled_on IS NULL AND resolution_note IS NULL)
 OR (status='settled_external' AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL AND settled_on IS NOT NULL AND resolution_note IS NOT NULL AND length(resolution_note) BETWEEN 1 AND 500)
 OR (status='no_transfer' AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL AND settled_on IS NULL AND resolution_note IS NOT NULL AND length(resolution_note) BETWEEN 1 AND 500))
);
CREATE UNIQUE INDEX paid_period_case_supervisor_pending ON public.paid_period_assertion_cases(supervisor_payroll_id) WHERE status='pending' AND supervisor_payroll_id IS NOT NULL;
CREATE UNIQUE INDEX paid_period_case_external_pending ON public.paid_period_assertion_cases(external_worker_id) WHERE status='pending' AND external_worker_id IS NOT NULL;
CREATE TABLE public.paid_period_assertion_case_events (
 case_id uuid NOT NULL REFERENCES public.paid_period_assertion_cases(id) ON DELETE RESTRICT,
 kind text NOT NULL CHECK(kind IN ('opened','resolved')),
 actor_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 before_row jsonb,
 after_row jsonb NOT NULL,
 PRIMARY KEY(case_id,kind),
 CHECK((kind='opened' AND before_row IS NULL) OR (kind='resolved' AND before_row IS NOT NULL))
);
ALTER TABLE public.paid_period_assertion_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.paid_period_assertion_case_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.paid_period_assertion_cases,public.paid_period_assertion_case_events FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.guard_paid_period_assertion_case_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF TG_TABLE_NAME='paid_period_assertion_case_events' OR TG_OP='DELETE' THEN RAISE EXCEPTION 'Paid period case history is immutable' USING ERRCODE='22023'; END IF;
 IF OLD.status<>'pending' OR NEW.status NOT IN ('settled_external','no_transfer') OR (to_jsonb(NEW)-ARRAY['status','resolved_by','resolved_at','settled_on','resolution_note']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','resolved_by','resolved_at','settled_on','resolution_note']) OR auth.uid() IS NULL OR NEW.resolved_by IS DISTINCT FROM auth.uid() OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Only a controlled final case decision is allowed' USING ERRCODE='22023'; END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_paid_period_assertion_case_immutable() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER paid_period_case_immutable BEFORE UPDATE OR DELETE ON public.paid_period_assertion_cases FOR EACH ROW EXECUTE FUNCTION public.guard_paid_period_assertion_case_immutable();
CREATE TRIGGER paid_period_event_immutable BEFORE UPDATE OR DELETE ON public.paid_period_assertion_case_events FOR EACH ROW EXECUTE FUNCTION public.guard_paid_period_assertion_case_immutable();

-- Compact, exact, textual money snapshot. Source rows are human assertions;
-- status paid here does not prove cash moved or that the source is correct.
CREATE FUNCTION public.paid_period_assertion_snapshot(p_kind text,p_source uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v jsonb;
BEGIN
 IF p_kind='supervisor' THEN
  SELECT jsonb_build_object('kind','supervisor','id',id,'person_id',supervisor_id,'name',supervisor_name,'start',period_start,'end',period_end,'paid_on',paid_on,'gross',gross::text,'net',gross::text,'status',status,'details',jsonb_build_object('daily_rate',daily_rate::text,'half_day_units',half_day_units,'source_fingerprint',pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object('source_snapshot',source_snapshot,'unmarked_dates',unmarked_dates)::text,'UTF8')),'hex'),'created_by',created_by,'created_at',created_at,'approved_by',approved_by,'approved_at',approved_at,'paid_by',paid_by,'recorded_paid_at',recorded_paid_at)) INTO v FROM public.supervisor_period_payroll WHERE id=p_source AND status='paid';
 ELSIF p_kind='external_worker' THEN
  SELECT jsonb_build_object('kind','external_worker','id',request_id,'person_id',worker_id,'name',worker_snapshot->>'name','start',period_start,'end',period_end,'paid_on',paid_on,'gross',gross::text,'net',net::text,'status','paid_assertion','details',jsonb_build_object('bale',bale::text,'other_deductions',other_deductions::text,'worker_snapshot',worker_snapshot,'evidence_note',evidence_note,'recorded_by',recorded_by,'recorded_at',recorded_at)) INTO v FROM public.historical_external_worker_payroll WHERE request_id=p_source;
 ELSE RAISE EXCEPTION 'Invalid paid period source' USING ERRCODE='22023'; END IF;
 IF v IS NULL THEN RAISE EXCEPTION 'Paid period source unavailable' USING ERRCODE='P0002'; END IF;
 RETURN v;
END;
$$;
REVOKE ALL ON FUNCTION public.paid_period_assertion_snapshot(text,uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.open_paid_period_assertion_case(p_id uuid,p_kind text,p_source uuid,p_expected jsonb,p_difference numeric,p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_snapshot jsonb;v_prev public.paid_period_assertion_cases%ROWTYPE;v_reason text;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Paid period case requires read committed isolation' USING ERRCODE='P1002'; END IF;
 IF p_id IS NULL OR p_source IS NULL OR p_kind IS NULL OR p_kind NOT IN ('supervisor','external_worker') OR p_expected IS NULL OR p_difference IS NULL OR p_difference='NaN'::numeric OR p_difference=0 OR abs(p_difference)>=10000000000 OR p_difference<>round(p_difference,2) OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'Invalid original period, difference or reason' USING ERRCODE='22023'; END IF;
 v_reason:=btrim(p_reason);PERFORM pg_catalog.set_config('lock_timeout','3s',true);
 -- Shared global first locks serialize these cases with both source writers.
 LOCK TABLE public.users,public.workers,public.supervisor_period_payroll,public.historical_external_worker_payroll,public.paid_period_assertion_cases,public.paid_period_assertion_case_events IN SHARE ROW EXCLUSIVE MODE;
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 SELECT * INTO v_prev FROM public.paid_period_assertion_cases WHERE id=p_id;
 IF FOUND THEN
  IF (v_prev.source_kind,coalesce(v_prev.supervisor_payroll_id,v_prev.external_worker_id),v_prev.original_snapshot,v_prev.difference,v_prev.reason,v_prev.created_by) IS DISTINCT FROM (p_kind,p_source,p_expected,p_difference,v_reason,auth.uid()) THEN RAISE EXCEPTION 'Case ID already used for different details' USING ERRCODE='22023'; END IF;
  RETURN jsonb_build_object('id',p_id,'status',v_prev.status,'replayed',true);
 END IF;
 v_snapshot:=public.paid_period_assertion_snapshot(p_kind,p_source);
 IF v_snapshot IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'Original period changed; review again' USING ERRCODE='40001'; END IF;
 IF EXISTS(SELECT 1 FROM public.paid_period_assertion_cases WHERE source_kind=p_kind AND coalesce(supervisor_payroll_id,external_worker_id)=p_source AND original_snapshot IS DISTINCT FROM v_snapshot) THEN RAISE EXCEPTION 'Prior case has a different original period; investigate' USING ERRCODE='40001'; END IF;
 IF (SELECT count(*) FROM public.paid_period_assertion_cases WHERE source_kind=p_kind AND coalesce(supervisor_payroll_id,external_worker_id)=p_source)>=100 THEN RAISE EXCEPTION 'Case history limit reached; separate reconciliation required' USING ERRCODE='54000'; END IF;
 IF EXISTS(SELECT 1 FROM public.paid_period_assertion_cases WHERE source_kind=p_kind AND coalesce(supervisor_payroll_id,external_worker_id)=p_source AND status='pending') THEN RAISE EXCEPTION 'An open case already exists for this period' USING ERRCODE='22023'; END IF;
 INSERT INTO public.paid_period_assertion_cases(id,source_kind,supervisor_payroll_id,external_worker_id,original_snapshot,difference,reason,created_by)
 VALUES(p_id,p_kind,CASE WHEN p_kind='supervisor' THEN p_source END,CASE WHEN p_kind='external_worker' THEN p_source END,v_snapshot,p_difference,v_reason,auth.uid()) RETURNING * INTO v_prev;
 INSERT INTO public.paid_period_assertion_case_events(case_id,kind,actor_id,after_row) VALUES(p_id,'opened',auth.uid(),to_jsonb(v_prev));
 RETURN jsonb_build_object('id',p_id,'status','pending','replayed',false);
END;
$$;

CREATE FUNCTION public.resolve_paid_period_assertion_case(p_id uuid,p_resolution text,p_settled_on date,p_note text,p_ack boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_case public.paid_period_assertion_cases%ROWTYPE;v_before jsonb;v_source uuid;v_note text;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Paid period case requires read committed isolation' USING ERRCODE='P1002'; END IF;
 IF p_id IS NULL OR p_resolution IS NULL OR p_resolution NOT IN ('settled_external','no_transfer') OR p_note IS NULL OR length(btrim(p_note)) NOT BETWEEN 1 AND 500 OR p_ack IS DISTINCT FROM true OR (p_resolution='no_transfer' AND p_settled_on IS NOT NULL) OR (p_resolution='settled_external' AND (p_settled_on IS NULL OR NOT isfinite(p_settled_on) OR p_settled_on<DATE '1900-01-01' OR p_settled_on>(clock_timestamp() AT TIME ZONE 'Asia/Manila')::date)) THEN RAISE EXCEPTION 'Invalid resolution, date or acknowledgement' USING ERRCODE='22023'; END IF;
 v_note:=btrim(p_note);PERFORM pg_catalog.set_config('lock_timeout','3s',true);
 LOCK TABLE public.users,public.workers,public.supervisor_period_payroll,public.historical_external_worker_payroll,public.paid_period_assertion_cases,public.paid_period_assertion_case_events IN SHARE ROW EXCLUSIVE MODE;
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 SELECT * INTO v_case FROM public.paid_period_assertion_cases WHERE id=p_id FOR UPDATE;IF NOT FOUND THEN RAISE EXCEPTION 'Case unavailable' USING ERRCODE='P0002'; END IF;
 v_source:=coalesce(v_case.supervisor_payroll_id,v_case.external_worker_id);
 IF p_resolution='settled_external' AND p_settled_on<(v_case.original_snapshot->>'paid_on')::date THEN RAISE EXCEPTION 'Settlement cannot precede original payment date' USING ERRCODE='22023'; END IF;
 IF v_case.status<>'pending' THEN
  IF (v_case.status,v_case.resolved_by,v_case.settled_on,v_case.resolution_note) IS NOT DISTINCT FROM (p_resolution,auth.uid(),p_settled_on,v_note) THEN RETURN jsonb_build_object('id',p_id,'status',v_case.status,'replayed',true); END IF;
  RAISE EXCEPTION 'Case already resolved; review recorded decision' USING ERRCODE='22023'; END IF;
 IF public.paid_period_assertion_snapshot(v_case.source_kind,v_source) IS DISTINCT FROM v_case.original_snapshot THEN RAISE EXCEPTION 'Original paid period changed; investigate' USING ERRCODE='40001'; END IF;
 v_before:=to_jsonb(v_case);
 UPDATE public.paid_period_assertion_cases SET status=p_resolution,resolved_by=auth.uid(),resolved_at=clock_timestamp(),settled_on=p_settled_on,resolution_note=v_note WHERE id=p_id RETURNING * INTO v_case;
 INSERT INTO public.paid_period_assertion_case_events(case_id,kind,actor_id,before_row,after_row) VALUES(p_id,'resolved',auth.uid(),v_before,to_jsonb(v_case));
 RETURN jsonb_build_object('id',p_id,'status',v_case.status,'replayed',false);
END;
$$;
CREATE FUNCTION public.paid_period_assertion_case_list(p_kind text,p_source uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_snapshot jsonb;v_total bigint;v_items jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 IF p_source IS NULL OR p_kind IS NULL OR p_kind NOT IN ('supervisor','external_worker') THEN RAISE EXCEPTION 'Invalid paid period source' USING ERRCODE='22023'; END IF;
 v_snapshot:=public.paid_period_assertion_snapshot(p_kind,p_source);
 SELECT count(*) INTO v_total FROM public.paid_period_assertion_cases WHERE source_kind=p_kind AND coalesce(supervisor_payroll_id,external_worker_id)=p_source;
 IF v_total>100 THEN RAISE EXCEPTION 'Case history exceeds 100 entries; separate reconciliation required' USING ERRCODE='54000'; END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.created_at DESC,x.id),'[]'::jsonb) INTO v_items FROM (
  SELECT id,source_kind,coalesce(supervisor_payroll_id,external_worker_id) source_id,original_snapshot,difference::text,reason,status,created_by,created_at,resolved_by,resolved_at,settled_on,resolution_note
  FROM public.paid_period_assertion_cases WHERE source_kind=p_kind AND coalesce(supervisor_payroll_id,external_worker_id)=p_source
 ) x;
 RETURN jsonb_build_object('snapshot',v_snapshot,'total',v_total,'items',v_items);
END;
$$;
REVOKE ALL ON FUNCTION public.open_paid_period_assertion_case(uuid,text,uuid,jsonb,numeric,text),public.resolve_paid_period_assertion_case(uuid,text,date,text,boolean),public.paid_period_assertion_case_list(text,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.open_paid_period_assertion_case(uuid,text,uuid,jsonb,numeric,text),public.resolve_paid_period_assertion_case(uuid,text,date,text,boolean),public.paid_period_assertion_case_list(text,uuid) TO authenticated;
DO $postflight$
DECLARE v text;
BEGIN
 FOREACH v IN ARRAY ARRAY['public.paid_period_assertion_cases','public.paid_period_assertion_case_events'] LOOP
  IF EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r WHERE has_table_privilege(r,v,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) OR EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a CROSS JOIN unnest(ARRAY['anon','authenticated','service_role']) r WHERE a.attrelid=to_regclass(v) AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege(r,a.attrelid,a.attname,'SELECT,INSERT,UPDATE,REFERENCES')) THEN RAISE EXCEPTION 'Unexpected paid period case table privilege'; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r CROSS JOIN unnest(ARRAY['public.paid_period_assertion_snapshot(text,uuid)','public.guard_paid_period_assertion_case_immutable()']) f WHERE has_function_privilege(r,f,'EXECUTE')) THEN RAISE EXCEPTION 'Unexpected internal paid period case privilege'; END IF;
 FOREACH v IN ARRAY ARRAY['public.open_paid_period_assertion_case(uuid,text,uuid,jsonb,numeric,text)','public.resolve_paid_period_assertion_case(uuid,text,date,text,boolean)','public.paid_period_assertion_case_list(text,uuid)'] LOOP
  IF has_function_privilege('anon',v,'EXECUTE') OR has_function_privilege('service_role',v,'EXECUTE') OR NOT has_function_privilege('authenticated',v,'EXECUTE') THEN RAISE EXCEPTION 'Unexpected paid period case RPC privilege'; END IF;
 END LOOP;
END;
$postflight$;


-- supabase/drafts/confirmed_rental_expense_link.sql sha256 ab69fe6a91f170f4d313f9110c3851fa08cb346f381aa03d32240e5c6546ee60
-- UNINSTALLED DRAFT ONLY. Must be reviewed with expense/receipt clients,
-- catalog, audit, recovery and finance cutover. No existing data is converted.
-- A confirmation attaches rental details to ONE existing equipment expense;
-- it never creates or adds another expense. It is not proof of a payment.
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
DO $$ BEGIN
 IF to_regclass('public.expenses') IS NULL OR to_regclass('public.projects') IS NULL OR to_regclass('public.users') IS NULL OR to_regprocedure('auth.uid()') IS NULL OR to_regprocedure('public.is_founder()') IS NULL OR to_regprocedure('public.session_assurance_satisfied()') IS NULL THEN RAISE EXCEPTION 'Rental prerequisites missing'; END IF;
 IF to_regclass('public.confirmed_rental_expenses') IS NOT NULL OR to_regprocedure('public.confirm_rental_expense(uuid,uuid,uuid,numeric,date,text,text,text,integer,date,date)') IS NOT NULL OR to_regprocedure('public.project_confirmed_rentals(uuid)') IS NOT NULL OR to_regprocedure('public.rental_confirmation_status(uuid)') IS NOT NULL OR to_regprocedure('public.guard_confirmed_rental_expense()') IS NOT NULL OR to_regprocedure('public.guard_confirmed_rental_immutable()') IS NOT NULL THEN RAISE EXCEPTION 'Rental objects already exist'; END IF;
 LOCK TABLE public.expenses IN SHARE MODE;
END $$;

CREATE TABLE public.confirmed_rental_expenses (
 id uuid PRIMARY KEY,
 expense_id uuid NOT NULL UNIQUE REFERENCES public.expenses(id) ON DELETE RESTRICT,
 project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE RESTRICT,
 expense_amount numeric(12,2) NOT NULL CHECK(expense_amount>0),
 expense_date date NOT NULL,
 expense_description text NOT NULL,
 item_name text NOT NULL CHECK(length(item_name) BETWEEN 1 AND 160),
 supplier text NOT NULL CHECK(length(supplier) BETWEEN 1 AND 160),
 quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 100000),
 rental_start date NOT NULL,
 rental_end date NOT NULL CHECK(rental_end>=rental_start),
 confirmed_by uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 confirmed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX confirmed_rental_project_idx ON public.confirmed_rental_expenses(project_id,rental_start DESC,id DESC);
ALTER TABLE public.confirmed_rental_expenses ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.confirmed_rental_expenses FROM PUBLIC,anon,authenticated,service_role;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r(role_name) WHERE has_table_privilege(r.role_name,'public.confirmed_rental_expenses','SELECT,INSERT,UPDATE,DELETE,TRUNCATE') OR EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid='public.confirmed_rental_expenses'::regclass AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege(r.role_name,a.attrelid,a.attname,'SELECT,INSERT,UPDATE'))) THEN RAISE EXCEPTION 'Unexpected inherited rental privileges'; END IF;
END $$;
CREATE FUNCTION public.guard_confirmed_rental_expense() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.confirmed_rental_expenses WHERE expense_id=OLD.id) THEN
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Linked expense updates require read committed isolation' USING ERRCODE='P1002'; END IF;
  IF (NEW.project_id,NEW.amount,NEW.expense_date,NEW.description,NEW.category,NEW.ai_bale_detection) IS DISTINCT FROM (OLD.project_id,OLD.amount,OLD.expense_date,OLD.description,OLD.category,OLD.ai_bale_detection) THEN RAISE EXCEPTION 'Confirmed rental expense financial details are locked; review a correction' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_confirmed_rental_expense() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER guard_confirmed_rental_expense BEFORE UPDATE ON public.expenses FOR EACH ROW EXECUTE FUNCTION public.guard_confirmed_rental_expense();
CREATE FUNCTION public.guard_confirmed_rental_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$ BEGIN RAISE EXCEPTION 'Confirmed rental is immutable; review a correction' USING ERRCODE='23514'; END $$;
REVOKE ALL ON FUNCTION public.guard_confirmed_rental_immutable() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER guard_confirmed_rental_immutable BEFORE UPDATE OR DELETE ON public.confirmed_rental_expenses FOR EACH ROW EXECUTE FUNCTION public.guard_confirmed_rental_immutable();

CREATE FUNCTION public.confirm_rental_expense(p_id uuid,p_expense uuid,p_project uuid,p_expected_amount numeric,p_expected_date date,p_expected_description text,p_item text,p_supplier text,p_quantity integer,p_start date,p_end date) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_prev public.confirmed_rental_expenses%ROWTYPE; v_exp public.expenses%ROWTYPE;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access required' USING ERRCODE='42501'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Rental confirmation requires read committed isolation' USING ERRCODE='P1002'; END IF;
 IF p_id IS NULL OR p_expense IS NULL OR p_project IS NULL OR p_expected_amount IS NULL OR p_expected_amount<=0 OR p_expected_amount>9999999999.99 OR p_expected_amount<>round(p_expected_amount,2) OR p_expected_date IS NULL OR NOT isfinite(p_expected_date) OR p_expected_description IS NULL OR p_item IS NULL OR p_item<>btrim(p_item) OR length(p_item) NOT BETWEEN 1 AND 160 OR p_supplier IS NULL OR p_supplier<>btrim(p_supplier) OR length(p_supplier) NOT BETWEEN 1 AND 160 OR p_quantity IS NULL OR p_quantity NOT BETWEEN 1 AND 100000 OR p_start IS NULL OR p_end IS NULL OR NOT isfinite(p_start) OR NOT isfinite(p_end) OR p_end<p_start THEN RAISE EXCEPTION 'Invalid rental confirmation' USING ERRCODE='22023'; END IF;
 PERFORM 1 FROM public.users WHERE id=auth.uid() AND role='founder' FOR SHARE;
 IF NOT FOUND OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access required' USING ERRCODE='42501'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('rental-confirmation:'||p_id::text,0));
 SELECT * INTO v_prev FROM public.confirmed_rental_expenses WHERE id=p_id;
 IF FOUND THEN
  IF (v_prev.confirmed_by,v_prev.expense_id,v_prev.project_id,v_prev.expense_amount,v_prev.expense_date,v_prev.expense_description,v_prev.item_name,v_prev.supplier,v_prev.quantity,v_prev.rental_start,v_prev.rental_end) IS DISTINCT FROM (auth.uid(),p_expense,p_project,p_expected_amount,p_expected_date,p_expected_description,p_item,p_supplier,p_quantity,p_start,p_end) THEN RAISE EXCEPTION 'Confirmation ID already used for different details' USING ERRCODE='22023'; END IF;
  RETURN jsonb_build_object('id',p_id,'expense_id',p_expense,'replayed',true);
 END IF;
 SELECT * INTO v_exp FROM public.expenses WHERE id=p_expense FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Expense unavailable' USING ERRCODE='P0002'; END IF;
 IF (v_exp.project_id,v_exp.amount,v_exp.expense_date,v_exp.description) IS DISTINCT FROM (p_project,p_expected_amount,p_expected_date,p_expected_description) THEN RAISE EXCEPTION 'Expense changed; refresh before confirming' USING ERRCODE='40001'; END IF;
 IF v_exp.category<>'equipment' OR coalesce(v_exp.ai_bale_detection,false) THEN RAISE EXCEPTION 'Only an equipment expense without a Bale flag can be linked' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM public.confirmed_rental_expenses WHERE expense_id=p_expense) THEN RAISE EXCEPTION 'Expense already linked to a confirmed rental' USING ERRCODE='23505'; END IF;
 -- Parent version prevents a repeatable-read legacy writer whose snapshot
 -- predates the link from silently overwriting protected fields.
 UPDATE public.expenses SET amount=amount WHERE id=p_expense;
 INSERT INTO public.confirmed_rental_expenses(id,expense_id,project_id,expense_amount,expense_date,expense_description,item_name,supplier,quantity,rental_start,rental_end,confirmed_by)
 VALUES(p_id,p_expense,p_project,p_expected_amount,p_expected_date,p_expected_description,p_item,p_supplier,p_quantity,p_start,p_end,auth.uid());
 RETURN jsonb_build_object('id',p_id,'expense_id',p_expense,'replayed',false);
END $$;
REVOKE ALL ON FUNCTION public.confirm_rental_expense(uuid,uuid,uuid,numeric,date,text,text,text,integer,date,date) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.confirm_rental_expense(uuid,uuid,uuid,numeric,date,text,text,text,integer,date,date) TO authenticated;

CREATE FUNCTION public.project_confirmed_rentals(p_project uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_count bigint;v_items jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access required' USING ERRCODE='42501'; END IF;
 IF p_project IS NULL OR NOT EXISTS(SELECT 1 FROM public.projects WHERE id=p_project) THEN RAISE EXCEPTION 'Project unavailable' USING ERRCODE='42501'; END IF;
 SELECT count(*) INTO v_count FROM public.confirmed_rental_expenses WHERE project_id=p_project;
 IF v_count>200 THEN RAISE EXCEPTION 'Too many rentals to show safely; pagination required' USING ERRCODE='54000'; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'expense_id',expense_id,'project_id',project_id,'expense_amount',expense_amount::text,'expense_date',expense_date,'expense_description',expense_description,'item_name',item_name,'supplier',supplier,'quantity',quantity,'rental_start',rental_start,'rental_end',rental_end,'confirmed_at',confirmed_at) ORDER BY rental_start DESC,id DESC),'[]'::jsonb) INTO v_items FROM public.confirmed_rental_expenses WHERE project_id=p_project;
 IF octet_length(v_items::text)>1048576 THEN RAISE EXCEPTION 'Rental list too large' USING ERRCODE='54000'; END IF;
 RETURN jsonb_build_object('project_id',p_project,'items',v_items);
END $$;
REVOKE ALL ON FUNCTION public.project_confirmed_rentals(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.project_confirmed_rentals(uuid) TO authenticated;
-- A missing row does not prove an in-flight transaction failed. Do not return
-- another Founder's request even if its UUID is guessed.
CREATE FUNCTION public.rental_confirmation_status(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE r public.confirmed_rental_expenses%ROWTYPE;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access required' USING ERRCODE='42501'; END IF;
 IF p_id IS NULL THEN RAISE EXCEPTION 'Invalid confirmation ID' USING ERRCODE='22023'; END IF;
 SELECT * INTO r FROM public.confirmed_rental_expenses WHERE id=p_id AND confirmed_by=auth.uid();
 IF NOT FOUND THEN RETURN jsonb_build_object('found',false); END IF;
 RETURN jsonb_build_object('found',true,'id',r.id,'expense',r.expense_id,'project',r.project_id,'amount',r.expense_amount::text,'date',r.expense_date,'description',r.expense_description,'item',r.item_name,'supplier',r.supplier,'quantity',r.quantity,'start',r.rental_start,'end',r.rental_end);
END $$;
REVOKE ALL ON FUNCTION public.rental_confirmation_status(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.rental_confirmation_status(uuid) TO authenticated;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['anon','service_role']) r(role_name) WHERE has_function_privilege(r.role_name,'public.confirm_rental_expense(uuid,uuid,uuid,numeric,date,text,text,text,integer,date,date)','EXECUTE') OR has_function_privilege(r.role_name,'public.project_confirmed_rentals(uuid)','EXECUTE') OR has_function_privilege(r.role_name,'public.rental_confirmation_status(uuid)','EXECUTE')) THEN RAISE EXCEPTION 'Unexpected inherited rental function privileges'; END IF;
END $$;


-- supabase/drafts/project_cost_reconciliation_preview.sql sha256 7ce8cefb77ee80d3300875ebbb5a18b4e6bedc3f3b8da2e5fcb4f126907c1882
-- UNINSTALLED, READ-ONLY EXPERIMENT. One bounded, statement-consistent
-- snapshot for a Founder to manually review project expenses against paid
-- worker allocation and linked rental evidence. No classifications, totals,
-- allocations, expenses, payments, or other records are written. Not a complete
-- accounting report: legacy/external pay, correction allocation and duplicates
-- can be missing. Worker-voucher adjustment cases are comparison signals only,
-- never site cost or proof of settlement. Install only in an isolated test
-- database until coordinated review.
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
DO $preflight$
BEGIN
 IF to_regclass('public.projects') IS NULL OR to_regclass('public.expenses') IS NULL OR to_regclass('public.confirmed_rental_expenses') IS NULL OR to_regclass('public.paid_payroll_adjustment_cases') IS NULL OR to_regprocedure('public.project_paid_worker_evidence(uuid,date,uuid,integer)') IS NULL OR to_regprocedure('public.project_confirmed_rentals(uuid)') IS NULL OR to_regprocedure('public.is_founder()') IS NULL OR to_regprocedure('public.session_assurance_satisfied()') IS NULL OR to_regprocedure('auth.uid()') IS NULL THEN RAISE EXCEPTION 'Project reconciliation prerequisites missing'; END IF;
 IF to_regprocedure('public.project_cost_reconciliation_preview(uuid)') IS NOT NULL THEN RAISE EXCEPTION 'Project reconciliation function already exists'; END IF;
END;
$preflight$;
CREATE FUNCTION public.project_cost_reconciliation_preview(p_project uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_count bigint;v_bad boolean;v_expenses jsonb;v_rentals jsonb;v_page jsonb;v_paid jsonb:='[]'::jsonb;v_adjustments jsonb;v_cursor_week date;v_cursor_id uuid;v_result jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 IF p_project IS NULL OR NOT EXISTS(SELECT 1 FROM public.projects WHERE id=p_project) THEN RAISE EXCEPTION 'Project unavailable' USING ERRCODE='42501'; END IF;
 SELECT count(*) INTO v_count FROM public.expenses WHERE project_id=p_project;
 IF v_count>200 THEN RAISE EXCEPTION 'More than 200 expenses; separate reconciliation required' USING ERRCODE='54000'; END IF;
 -- A rental is an annotation on exactly one existing expense, not an extra
 -- amount. Refuse stale, cross-site or missing financial source fields.
 SELECT EXISTS(SELECT 1 FROM public.confirmed_rental_expenses r LEFT JOIN public.expenses e ON e.id=r.expense_id
  WHERE (r.project_id=p_project OR e.project_id=p_project) AND (e.id IS NULL OR (e.project_id,e.amount,e.expense_date,e.description,e.category,coalesce(e.ai_bale_detection,false)) IS DISTINCT FROM (r.project_id,r.expense_amount,r.expense_date,r.expense_description,'equipment'::text,false))) INTO v_bad;
 IF v_bad THEN RAISE EXCEPTION 'Confirmed rental and linked expense differ; investigate' USING ERRCODE='22023'; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',e.id,'project_id',e.project_id,'description',e.description,'category',e.category,'amount',e.amount::text,'expense_date',e.expense_date,'ai_bale_detection',coalesce(e.ai_bale_detection,false)) ORDER BY e.expense_date DESC,e.id DESC),'[]'::jsonb) INTO v_expenses FROM public.expenses e WHERE e.project_id=p_project;
 v_rentals:=public.project_confirmed_rentals(p_project);
 -- The existing evidence function validates each lookahead and all site sums.
 -- Each call here belongs to this single STABLE statement snapshot; cap total.
 LOOP
  v_page:=public.project_paid_worker_evidence(p_project,v_cursor_week,v_cursor_id,25);
  v_paid:=v_paid||(v_page->'items');
  IF jsonb_array_length(v_paid)>500 OR (jsonb_array_length(v_paid)=500 AND (v_page->>'has_more')::boolean) THEN RAISE EXCEPTION 'More than 500 paid allocations; separate reconciliation required' USING ERRCODE='54000'; END IF;
  EXIT WHEN NOT (v_page->>'has_more')::boolean;
  v_cursor_week:=(v_paid->-1->>'period_start')::date;v_cursor_id:=(v_paid->-1->>'payroll_id')::uuid;
 END LOOP;
 -- Show the whole voucher's Bale as comparison evidence only, never a site
 -- allocation or another cost. Validate recorded math and saved calculation.
 SELECT EXISTS(SELECT 1 FROM jsonb_array_elements(v_paid) a LEFT JOIN public.payroll p ON p.id=(a->>'payroll_id')::uuid LEFT JOIN public.weekly_worker_draft_sources s ON s.payroll_id=p.id
  WHERE p.id IS NULL OR NOT coalesce(p.gross_pay>=0 AND p.bale_deduction>=0 AND p.other_deductions>=0 AND p.net_pay>=0 AND p.gross_pay<10000000000 AND p.bale_deduction<10000000000 AND p.other_deductions<10000000000 AND p.net_pay<10000000000
   AND p.gross_pay=round(p.gross_pay,2) AND p.bale_deduction=round(p.bale_deduction,2) AND p.other_deductions=round(p.other_deductions,2) AND p.net_pay=round(p.net_pay,2)
   AND p.gross_pay-p.bale_deduction-p.other_deductions=p.net_pay AND p.gross_pay=(s.calculation->>'gross')::numeric AND p.bale_deduction=(s.calculation->>'bale')::numeric AND p.net_pay=(s.calculation->>'net')::numeric,false)) INTO v_bad;
 IF v_bad THEN RAISE EXCEPTION 'Paid voucher deduction evidence is inconsistent; investigate' USING ERRCODE='22023'; END IF;
 SELECT coalesce(jsonb_agg(a.value||jsonb_build_object('voucher_gross',p.gross_pay::numeric(12,2)::text,'voucher_bale',p.bale_deduction::numeric(12,2)::text,'voucher_other',p.other_deductions::numeric(12,2)::text,'voucher_net',p.net_pay::numeric(12,2)::text) ORDER BY a.ordinality),'[]'::jsonb) INTO v_paid
 FROM jsonb_array_elements(v_paid) WITH ORDINALITY a(value,ordinality) JOIN public.payroll p ON p.id=(a.value->>'payroll_id')::uuid;
 -- Whole-voucher cases are evidence to investigate, not site allocations.
 -- Include all case fields that can change the review, within the same
 -- statement snapshot. A case can appear at several sites for one voucher.
 SELECT count(*) INTO v_count FROM public.paid_payroll_adjustment_cases c
 WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(v_paid) a WHERE (a->>'payroll_id')::uuid=c.payroll_id);
 IF v_count>500 THEN RAISE EXCEPTION 'More than 500 adjustment cases; separate reconciliation required' USING ERRCODE='54000'; END IF;
 SELECT EXISTS(SELECT 1 FROM public.paid_payroll_adjustment_cases c JOIN public.payroll p ON p.id=c.payroll_id
 WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(v_paid) a WHERE (a->>'payroll_id')::uuid=c.payroll_id)
 AND (c.worker_id IS DISTINCT FROM p.worker_id OR c.difference='NaN'::numeric OR c.difference=0 OR abs(c.difference)>=10000000000 OR c.difference<>round(c.difference,2))) INTO v_bad;
 IF v_bad THEN RAISE EXCEPTION 'Adjustment case evidence is inconsistent; investigate' USING ERRCODE='22023'; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('case_id',c.id,'payroll_id',c.payroll_id,'worker_id',c.worker_id,'difference',c.difference::numeric(12,2)::text,'reason',c.reason,'status',c.status,'created_by',c.created_by,'created_at',c.created_at,'resolved_by',c.resolved_by,'resolved_at',c.resolved_at,'settled_on',c.settled_on,'resolution_note',c.resolution_note) ORDER BY c.created_at DESC,c.id DESC),'[]'::jsonb) INTO v_adjustments
 FROM public.paid_payroll_adjustment_cases c WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(v_paid) a WHERE (a->>'payroll_id')::uuid=c.payroll_id);
 v_result:=jsonb_build_object('project_id',p_project,'captured_at',statement_timestamp(),'expenses',v_expenses,'rentals',v_rentals->'items','paid_allocations',v_paid,'adjustment_cases',v_adjustments);
 IF octet_length(v_result::text)>1048576 THEN RAISE EXCEPTION 'Project reconciliation snapshot too large' USING ERRCODE='54000'; END IF;
 RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.project_cost_reconciliation_preview(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.project_cost_reconciliation_preview(uuid) TO authenticated;
DO $postflight$
BEGIN
 IF has_function_privilege('anon','public.project_cost_reconciliation_preview(uuid)','EXECUTE') OR has_function_privilege('service_role','public.project_cost_reconciliation_preview(uuid)','EXECUTE') OR NOT has_function_privilege('authenticated','public.project_cost_reconciliation_preview(uuid)','EXECUTE') THEN RAISE EXCEPTION 'Unexpected project reconciliation function privileges'; END IF;
END;
$postflight$;


-- supabase/drafts/project_assignment_history.sql sha256 6ae8574037bb9f1e81f25c1538967359dcd3174baba350185202c3f276d099b1
-- UNINSTALLED DRAFT ONLY: apply as a single reviewed transaction, not alone.
-- Existing assignment rows reveal only their CURRENT state, not prior intervals.
-- Installation records a baseline observation, never fabricates past start/end.
-- Exact live catalog, privileged clients, removal guard, recovery and project
-- deletion behavior must be reviewed before any deployment.
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
DO $$ BEGIN
 IF to_regclass('public.project_worker_assignments') IS NULL OR to_regclass('public.workers') IS NULL OR to_regclass('public.projects') IS NULL OR to_regprocedure('public.set_workers_removed_guarded(uuid,uuid[],boolean)') IS NULL OR to_regprocedure('public.is_founder()') IS NULL OR to_regprocedure('public.session_assurance_satisfied()') IS NULL OR to_regprocedure('auth.uid()') IS NULL THEN RAISE EXCEPTION 'Assignment history prerequisites missing'; END IF;
 IF to_regclass('public.project_assignment_history') IS NOT NULL OR to_regprocedure('public.record_project_assignment_history()') IS NOT NULL OR to_regprocedure('public.guard_assignment_history_immutable()') IS NOT NULL OR to_regprocedure('public.founder_assignment_history(uuid,timestamp with time zone,uuid,integer)') IS NOT NULL THEN RAISE EXCEPTION 'Assignment history objects already exist'; END IF;
 -- Match existing worker-removal and assignment lock order. This also ensures
 -- no assignment transition occurs between the baseline and trigger creation.
 LOCK TABLE public.workers IN SHARE ROW EXCLUSIVE MODE;
 LOCK TABLE public.project_worker_assignments IN SHARE ROW EXCLUSIVE MODE;
 IF EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid IN ('public.workers'::regclass,'public.project_worker_assignments'::regclass) AND NOT tgisinternal AND tgenabled<>'D') THEN RAISE EXCEPTION 'Existing worker/assignment triggers require review'; END IF;
END $$;
CREATE TABLE public.project_assignment_history (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE RESTRICT,
 worker_id uuid NOT NULL REFERENCES public.workers(id) ON DELETE RESTRICT,
 event_type text NOT NULL CHECK(event_type IN ('baseline_active','baseline_inactive','assigned','unassigned')),
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 actor_id uuid,
 CHECK((event_type LIKE 'baseline_%' AND actor_id IS NULL) OR event_type IN ('assigned','unassigned'))
);
CREATE INDEX project_assignment_history_worker_order_idx ON public.project_assignment_history(worker_id,occurred_at DESC,id DESC);
ALTER TABLE public.project_assignment_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.project_assignment_history FROM PUBLIC,anon,authenticated,service_role;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r(role_name) WHERE has_table_privilege(r.role_name,'public.project_assignment_history','SELECT,INSERT,UPDATE,DELETE,TRUNCATE') OR EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid='public.project_assignment_history'::regclass AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege(r.role_name,a.attrelid,a.attname,'SELECT,INSERT,UPDATE'))) THEN RAISE EXCEPTION 'Unexpected inherited assignment history privilege'; END IF;
END $$;
-- All baseline rows share an observation instant; created_at/updated_at on the
-- old row do not prove a complete interval or even who originally assigned it.
INSERT INTO public.project_assignment_history(project_id,worker_id,event_type,occurred_at)
 SELECT project_id,worker_id,CASE WHEN active THEN 'baseline_active' ELSE 'baseline_inactive' END,statement_timestamp() FROM public.project_worker_assignments;
CREATE FUNCTION public.guard_assignment_history_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$ BEGIN RAISE EXCEPTION 'Assignment history is immutable' USING ERRCODE='23514'; END $$;
REVOKE ALL ON FUNCTION public.guard_assignment_history_immutable() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER guard_assignment_history_immutable BEFORE UPDATE OR DELETE ON public.project_assignment_history FOR EACH ROW EXECUTE FUNCTION public.guard_assignment_history_immutable();
CREATE FUNCTION public.record_project_assignment_history() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Assignment rows must not be deleted; preserve history' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' AND (NEW.worker_id,NEW.project_id) IS DISTINCT FROM (OLD.worker_id,OLD.project_id) THEN RAISE EXCEPTION 'Assignment identities are immutable' USING ERRCODE='23514'; END IF;
 IF NEW.active IS NULL THEN RAISE EXCEPTION 'Assignment state required' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' OR NEW.active IS DISTINCT FROM OLD.active THEN
  INSERT INTO public.project_assignment_history(project_id,worker_id,event_type,actor_id) VALUES(NEW.project_id,NEW.worker_id,CASE WHEN NEW.active THEN 'assigned' ELSE 'unassigned' END,NEW.updated_by);
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.record_project_assignment_history() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER record_project_assignment_history AFTER INSERT OR UPDATE OR DELETE ON public.project_worker_assignments FOR EACH ROW EXECUTE FUNCTION public.record_project_assignment_history();

-- The installed archive routine deliberately rejects any active worker or
-- assignment trigger. Permit ONLY the exact history trigger, while preserving
-- the check against all other triggers. Refuse unfamiliar function bodies.
DO $patch$
DECLARE v_def text;v_old text:=$old$  IF EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid IN ('public.workers'::regclass,'public.project_worker_assignments'::regclass) AND NOT t.tgisinternal AND t.tgenabled <> 'D') THEN
    RAISE EXCEPTION 'WORKER_REMOVAL_SCHEMA_REVIEW_REQUIRED' USING ERRCODE = 'P1002';
  END IF;$old$;
 v_new text:=$new$  IF NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid='public.project_worker_assignments'::regclass AND t.tgname='record_project_assignment_history' AND t.tgfoid='public.record_project_assignment_history()'::regprocedure AND t.tgtype=29 AND t.tgenabled IN ('O','A') AND NOT t.tgisinternal)
    OR EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid IN ('public.workers'::regclass,'public.project_worker_assignments'::regclass) AND NOT t.tgisinternal AND t.tgenabled <> 'D' AND NOT (t.tgrelid='public.project_worker_assignments'::regclass AND t.tgname='record_project_assignment_history' AND t.tgfoid='public.record_project_assignment_history()'::regprocedure AND t.tgtype=29)) THEN
    RAISE EXCEPTION 'WORKER_REMOVAL_SCHEMA_REVIEW_REQUIRED' USING ERRCODE = 'P1002';
  END IF;$new$;
BEGIN
 SELECT pg_get_functiondef('public.set_workers_removed_guarded(uuid,uuid[],boolean)'::regprocedure) INTO v_def;
 IF position(v_old IN v_def)=0 OR length(v_def)-length(replace(v_def,v_old,''))<>length(v_old) THEN RAISE EXCEPTION 'Removal guard differs; manual review required'; END IF;
 EXECUTE replace(v_def,v_old,v_new);
END $patch$;

-- Founder-only paging across one worker. Supervisors are not given a worker's
-- cross-site history. Baseline values are observations, not inferred start dates.
CREATE FUNCTION public.founder_assignment_history(p_worker uuid,p_cursor_at timestamptz DEFAULT NULL,p_cursor_id uuid DEFAULT NULL,p_limit integer DEFAULT 25)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_result jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access required' USING ERRCODE='42501'; END IF;
 IF p_worker IS NULL OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 OR (p_cursor_at IS NULL)<>(p_cursor_id IS NULL) OR (p_cursor_at IS NOT NULL AND NOT isfinite(p_cursor_at)) THEN RAISE EXCEPTION 'Invalid history cursor' USING ERRCODE='22023'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.workers WHERE id=p_worker) THEN RAISE EXCEPTION 'Worker unavailable' USING ERRCODE='42501'; END IF;
 WITH rows AS MATERIALIZED (SELECT h.*,p.name project_name FROM public.project_assignment_history h JOIN public.projects p ON p.id=h.project_id WHERE h.worker_id=p_worker AND (p_cursor_at IS NULL OR (h.occurred_at,h.id)<(p_cursor_at,p_cursor_id)) ORDER BY h.occurred_at DESC,h.id DESC LIMIT p_limit+1),
 page AS (SELECT * FROM rows ORDER BY occurred_at DESC,id DESC LIMIT p_limit)
 SELECT jsonb_build_object('worker_id',p_worker,'has_more',(SELECT count(*)>p_limit FROM rows),'items',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'project_id',project_id,'project_name',project_name,'event_type',event_type,'occurred_at',occurred_at,'actor_id',actor_id) ORDER BY occurred_at DESC,id DESC) FROM page),'[]'::jsonb)) INTO v_result;
 IF octet_length(v_result::text)>1048576 THEN RAISE EXCEPTION 'Assignment history too large' USING ERRCODE='54000'; END IF;RETURN v_result;
END $$;
REVOKE ALL ON FUNCTION public.founder_assignment_history(uuid,timestamptz,uuid,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.founder_assignment_history(uuid,timestamptz,uuid,integer) TO authenticated;
DO $$ BEGIN IF has_function_privilege('anon','public.founder_assignment_history(uuid,timestamptz,uuid,integer)','EXECUTE') OR has_function_privilege('service_role','public.founder_assignment_history(uuid,timestamptz,uuid,integer)','EXECUTE') THEN RAISE EXCEPTION 'Unexpected inherited history function privileges'; END IF; END $$;


-- supabase/drafts/atomic_worker_move.sql sha256 0cfcfba715231f4c07669f157524081950056a7af51e1348db09734a9b4926e3
-- EXPERIMENTAL, UNINSTALLED, NOT A RELEASE MIGRATION. Requires the separately
-- reviewed assignment-history draft and existing guarded assignment writer.
-- A move is one transaction with two history events, not an effective-dated
-- schedule or a reconstruction of earlier site history. Do not apply alone.
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
DO $preflight$
BEGIN
 IF to_regclass('public.project_assignment_history') IS NULL OR to_regclass('public.project_worker_assignments') IS NULL OR to_regclass('public.workers') IS NULL OR to_regclass('public.users') IS NULL OR to_regclass('public.projects') IS NULL OR to_regprocedure('public.record_project_assignment_history()') IS NULL OR to_regprocedure('public.set_project_worker_guarded(uuid,uuid,uuid,boolean)') IS NULL OR to_regprocedure('public.is_founder()') IS NULL OR to_regprocedure('public.session_assurance_satisfied()') IS NULL OR to_regprocedure('auth.uid()') IS NULL THEN RAISE EXCEPTION 'Atomic move prerequisites missing'; END IF;
 IF to_regclass('public.worker_move_requests') IS NOT NULL OR to_regprocedure('public.move_worker_project(uuid,uuid,uuid,uuid)') IS NOT NULL THEN RAISE EXCEPTION 'Atomic move objects already exist'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid='public.project_worker_assignments'::regclass AND tgname='record_project_assignment_history' AND tgfoid='public.record_project_assignment_history()'::regprocedure AND tgtype=29 AND tgenabled IN ('O','A') AND NOT tgisinternal) THEN RAISE EXCEPTION 'Assignment history trigger unavailable'; END IF;
END;
$preflight$;
CREATE TABLE public.worker_move_requests (
 request_id uuid PRIMARY KEY,
 actor_id uuid NOT NULL,
 worker_id uuid NOT NULL REFERENCES public.workers(id) ON DELETE RESTRICT,
 from_project uuid NOT NULL REFERENCES public.projects(id) ON DELETE RESTRICT,
 to_project uuid NOT NULL REFERENCES public.projects(id) ON DELETE RESTRICT,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(from_project<>to_project)
);
ALTER TABLE public.worker_move_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.worker_move_requests FROM PUBLIC,anon,authenticated,service_role;
DO $acl$
BEGIN
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r(role_name) WHERE has_table_privilege(r.role_name,'public.worker_move_requests','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid='public.worker_move_requests'::regclass AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege(r.role_name,a.attrelid,a.attname,'SELECT,INSERT,UPDATE'))) THEN RAISE EXCEPTION 'Unexpected inherited move-table access'; END IF;
END;
$acl$;
CREATE FUNCTION public.move_worker_project(p_request uuid,p_worker uuid,p_from uuid,p_to uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid:=auth.uid(); v_previous public.worker_move_requests%ROWTYPE; v_active boolean;v_count integer;
BEGIN
 IF v_actor IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access required' USING ERRCODE='42501'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Worker moves require read committed' USING ERRCODE='P1002'; END IF;
 IF p_request IS NULL OR p_worker IS NULL OR p_from IS NULL OR p_to IS NULL OR p_from=p_to THEN RAISE EXCEPTION 'Invalid worker move' USING ERRCODE='22023'; END IF;
 -- Actor pin, request serialization, deterministic project ordering, worker.
 PERFORM 1 FROM public.users WHERE id=v_actor AND role='founder' FOR SHARE;
 IF NOT FOUND OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access required' USING ERRCODE='42501'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('worker-move:'||p_request::text,0));
 SELECT * INTO v_previous FROM public.worker_move_requests WHERE request_id=p_request;
 IF FOUND THEN
  IF (v_previous.actor_id,v_previous.worker_id,v_previous.from_project,v_previous.to_project) IS DISTINCT FROM (v_actor,p_worker,p_from,p_to) THEN RAISE EXCEPTION 'Request ID already used for another move' USING ERRCODE='22023'; END IF;
  RETURN jsonb_build_object('request_id',p_request,'worker_id',p_worker,'from_project',p_from,'to_project',p_to,'replayed',true);
 END IF;
 -- Block trigger disabling while this move checks and writes its history.
 LOCK TABLE public.project_worker_assignments IN ROW SHARE MODE;
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid='public.project_worker_assignments'::regclass AND tgname='record_project_assignment_history' AND tgfoid='public.record_project_assignment_history()'::regprocedure AND tgtype=29 AND tgenabled IN ('O','A') AND NOT tgisinternal) THEN RAISE EXCEPTION 'Assignment history trigger unavailable' USING ERRCODE='P1002'; END IF;
 PERFORM 1 FROM public.projects WHERE id IN (p_from,p_to) ORDER BY id FOR KEY SHARE;
 GET DIAGNOSTICS v_count=ROW_COUNT;
 IF v_count<>2 THEN RAISE EXCEPTION 'Project unavailable' USING ERRCODE='22023'; END IF;
 SELECT active INTO v_active FROM public.workers WHERE id=p_worker FOR UPDATE;
 IF NOT FOUND OR v_active IS NOT TRUE OR EXISTS(SELECT 1 FROM public.users WHERE id=p_worker AND role='supervisor') THEN RAISE EXCEPTION 'Regular active worker required' USING ERRCODE='22023'; END IF;
 IF (SELECT count(*) FROM public.project_worker_assignments WHERE worker_id=p_worker AND active)<>1 OR NOT EXISTS(SELECT 1 FROM public.project_worker_assignments WHERE worker_id=p_worker AND project_id=p_from AND active) THEN
  RAISE EXCEPTION 'Worker assignment changed; refresh and review' USING ERRCODE='40001'; END IF;
 PERFORM public.set_project_worker_guarded(v_actor,p_from,p_worker,false);
 PERFORM public.set_project_worker_guarded(v_actor,p_to,p_worker,true);
 INSERT INTO public.worker_move_requests(request_id,actor_id,worker_id,from_project,to_project) VALUES(p_request,v_actor,p_worker,p_from,p_to);
 RETURN jsonb_build_object('request_id',p_request,'worker_id',p_worker,'from_project',p_from,'to_project',p_to,'replayed',false);
END;
$$;
REVOKE ALL ON FUNCTION public.move_worker_project(uuid,uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.move_worker_project(uuid,uuid,uuid,uuid) TO authenticated;
DO $function_acl$
BEGIN
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['anon','service_role']) r(role_name) WHERE has_function_privilege(r.role_name,'public.move_worker_project(uuid,uuid,uuid,uuid)','EXECUTE')) OR NOT has_function_privilege('authenticated','public.move_worker_project(uuid,uuid,uuid,uuid)','EXECUTE') THEN RAISE EXCEPTION 'Unexpected atomic-move function access'; END IF;
END;
$function_acl$;


-- supabase/drafts/attendance_assignment_guard.sql sha256 97cfcc5201be248c49f483e79704142596a12da29249547fa0a617559134249f
-- UNINSTALLED EXPERIMENTAL DRAFT. NOT a standalone deployment or migration.
-- Prevent Supervisor Roll Call writes for workers outside their current site.
-- Founder backfill for regular workers is unchanged. Linked Supervisor site
-- attendance is read-only: new daily attendance uses the general-day workflow.
-- Existing historical records are retained, not converted or deleted.
-- Current assignments are not historical intervals. After a worker moves,
-- historical edits by the former Supervisor require Founder review/backfill.
-- Auth-less/service/owner attendance writes are blocked by this trigger and
-- need a separate reviewed maintenance design; do not apply to a shared host.
-- The lock order and legacy/upsert clients need full cutover/load review.
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
DO $preflight$
BEGIN
 IF pg_catalog.to_regclass('public.attendance') IS NULL OR pg_catalog.to_regclass('public.users') IS NULL
 OR pg_catalog.to_regclass('public.projects') IS NULL OR pg_catalog.to_regclass('public.workers') IS NULL
 OR pg_catalog.to_regclass('public.project_supervisors') IS NULL OR pg_catalog.to_regclass('public.project_worker_assignments') IS NULL
 OR pg_catalog.to_regprocedure('auth.uid()') IS NULL OR pg_catalog.to_regprocedure('public.session_assurance_satisfied()') IS NULL
 OR pg_catalog.to_regprocedure('public.is_founder()') IS NULL OR pg_catalog.to_regprocedure('public.is_supervisor_assigned(uuid)') IS NULL THEN
  RAISE EXCEPTION 'Attendance guard prerequisites missing'; END IF;
 IF pg_catalog.to_regprocedure('public.guard_attendance_assignment()') IS NOT NULL OR EXISTS
  (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid='public.attendance'::regclass AND tgname='guard_attendance_assignment' AND NOT tgisinternal) THEN
  RAISE EXCEPTION 'Attendance guard objects already exist'; END IF;
 IF NOT (SELECT relrowsecurity AND relkind='r' FROM pg_catalog.pg_class WHERE oid='public.attendance'::regclass) THEN
  RAISE EXCEPTION 'Attendance table must have RLS'; END IF;
END;
$preflight$;
CREATE FUNCTION public.guard_attendance_assignment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid:=auth.uid();v_role text;v_target_role text;v_old_role text;v_active boolean;
BEGIN
 IF v_actor IS NULL OR NOT coalesce(public.session_assurance_satisfied(),false) THEN
  RAISE EXCEPTION 'Attendance access required' USING ERRCODE='42501'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION 'Attendance writes require read committed isolation' USING ERRCODE='P1002'; END IF;
 -- Match guarded assignment lock order: actor, project, authorization, worker.
 SELECT role INTO v_role FROM public.users WHERE id=v_actor FOR SHARE;
 -- Pin a linked target account while checking its role, including Founder writes.
 -- Preserve old site rows as evidence, but do not create or alter them once
 -- the general daily-attendance cutover is active.
 SELECT role INTO v_target_role FROM public.users WHERE id=NEW.worker_id FOR SHARE;
 IF TG_OP='UPDATE' AND OLD.worker_id IS DISTINCT FROM NEW.worker_id THEN
  SELECT role INTO v_old_role FROM public.users WHERE id=OLD.worker_id FOR SHARE;
 END IF;
 IF v_target_role='supervisor' OR v_old_role='supervisor' THEN
  RAISE EXCEPTION 'Supervisor site attendance is read-only; use general daily attendance' USING ERRCODE='22023'; END IF;
 IF v_role='founder' AND coalesce(public.is_founder(),false) AND coalesce(public.session_assurance_satisfied(),false) THEN RETURN NEW; END IF;
 IF v_role IS DISTINCT FROM 'supervisor' OR NOT coalesce(public.session_assurance_satisfied(),false) THEN
  RAISE EXCEPTION 'Attendance access required' USING ERRCODE='42501'; END IF;
 IF TG_OP='UPDATE' AND (NEW.worker_id,NEW.project_id,NEW.date) IS DISTINCT FROM (OLD.worker_id,OLD.project_id,OLD.date) THEN
  RAISE EXCEPTION 'Attendance identity cannot be changed by a Supervisor' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM public.projects WHERE id=NEW.project_id FOR KEY SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Attendance access required' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM public.project_supervisors WHERE project_id=NEW.project_id AND supervisor_id=v_actor FOR KEY SHARE;
 IF NOT FOUND OR NOT coalesce(public.is_supervisor_assigned(NEW.project_id),false) THEN
  RAISE EXCEPTION 'Attendance access required' USING ERRCODE='42501'; END IF;
 SELECT active INTO v_active FROM public.workers WHERE id=NEW.worker_id FOR UPDATE;
 IF NOT FOUND OR v_active IS NOT TRUE THEN RAISE EXCEPTION 'Worker unavailable' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM public.users WHERE id=NEW.worker_id AND role='supervisor')
 OR NOT EXISTS(SELECT 1 FROM public.project_worker_assignments WHERE worker_id=NEW.worker_id AND project_id=NEW.project_id AND active=true)
 OR EXISTS(SELECT 1 FROM public.project_worker_assignments WHERE worker_id=NEW.worker_id AND project_id<>NEW.project_id AND active=true) THEN
  RAISE EXCEPTION 'Worker must have one active assignment at the selected site' USING ERRCODE='22023'; END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_attendance_assignment() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER guard_attendance_assignment BEFORE INSERT OR UPDATE ON public.attendance
 FOR EACH ROW EXECUTE FUNCTION public.guard_attendance_assignment();
DO $postflight$
BEGIN
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r(role_name)
  WHERE pg_catalog.has_function_privilege(r.role_name,'public.guard_attendance_assignment()','EXECUTE')) THEN
  RAISE EXCEPTION 'Attendance guard function exposed through inherited privileges'; END IF;
END;
$postflight$;


-- supabase/drafts/assignment_writer_acl_cutover.sql sha256 84001df56b053f87fc84e1400e3d5064edca5f1deac3d55ac0ba5868b7e2900b
-- EXPERIMENTAL, UNINSTALLED. This is NOT a standalone migration or a complete
-- cutover. It removes direct API/service writes to the assignment table while
-- retaining existing SELECT grants and the server-only SECURITY DEFINER RPCs.
-- It can break imports, maintenance, restores, older server code, integrations,
-- direct admin tools or custom writers. Do not apply to a shared database until
-- every writer, function body/owner/grant, restoration path and old deployment
-- has been reviewed and tested together. A table owner, superuser or a role
-- able to assume one remains privileged. service_role can invoke trusted RPCs
-- with an actor argument; it is NOT a user identity or an untrusted boundary.
-- The caller must wrap this entire draft in a transaction; any exception must
-- roll back the REVOKEs. Existing assignment and history rows are not changed.

-- Block existing SQL writers while changing permissions. This lock can cause
-- downtime; it is not a guarantee against unreviewed privileged writers.
-- These LOCAL limits also apply to later statements in the caller's transaction.
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
LOCK TABLE public.project_worker_assignments IN SHARE ROW EXCLUSIVE MODE;
DO $preflight$
DECLARE v_oid oid; v_signature text; v_owner oid;
BEGIN
 FOREACH v_signature IN ARRAY ARRAY[
  'public.set_project_worker_guarded(uuid,uuid,uuid,boolean)',
  'public.create_project_worker_guarded(uuid,uuid,uuid,text,text,text,numeric,text)',
  'public.set_workers_removed_guarded(uuid,uuid[],boolean)'
 ] LOOP
  v_oid:=pg_catalog.to_regprocedure(v_signature);
  IF v_oid IS NULL OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid=v_oid AND p.prosecdef) OR
    NOT pg_catalog.has_function_privilege('service_role',v_oid,'EXECUTE') THEN
   RAISE EXCEPTION 'Reviewed assignment writer missing or not executable: %',v_signature;
  END IF;
  SELECT proowner INTO v_owner FROM pg_catalog.pg_proc WHERE oid=v_oid;
  IF NOT pg_catalog.has_table_privilege(v_owner,'public.project_worker_assignments','SELECT') OR
     NOT pg_catalog.has_table_privilege(v_owner,'public.project_worker_assignments','INSERT') OR
     NOT pg_catalog.has_table_privilege(v_owner,'public.project_worker_assignments','UPDATE') THEN
   RAISE EXCEPTION 'Assignment writer owner lacks required table privileges: %',v_signature;
  END IF;
 END LOOP;
END $preflight$;

-- Table revokes alone do not remove pre-existing per-column grants. Explicitly
-- revoke both and fail closed if an inherited privilege remains. SELECT is
-- deliberately retained: server and RLS-scoped application reads still need it.
REVOKE INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.project_worker_assignments FROM PUBLIC,anon,authenticated,service_role;
DO $columns$
DECLARE v_columns text;
BEGIN
 SELECT string_agg(pg_catalog.quote_ident(a.attname),',' ORDER BY a.attnum) INTO v_columns
 FROM pg_catalog.pg_attribute a WHERE a.attrelid='public.project_worker_assignments'::regclass AND a.attnum>0 AND NOT a.attisdropped;
 IF v_columns IS NULL THEN RAISE EXCEPTION 'Assignment columns unavailable'; END IF;
 EXECUTE pg_catalog.format('REVOKE INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) ON TABLE public.project_worker_assignments FROM PUBLIC, anon, authenticated, service_role',v_columns);
END $columns$;
DO $postflight$
BEGIN
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r(role_name)
  WHERE pg_catalog.has_table_privilege(r.role_name,'public.project_worker_assignments','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
   OR EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid='public.project_worker_assignments'::regclass
    AND a.attnum>0 AND NOT a.attisdropped AND pg_catalog.has_column_privilege(r.role_name,a.attrelid,a.attname,'INSERT,UPDATE,REFERENCES'))) THEN
  RAISE EXCEPTION 'Inherited assignment write or DDL privilege remains';
 END IF;
END $postflight$;


-- supabase/drafts/weekly_bale_legacy_cutover_guard.sql sha256 e5816e58391634218dc42d04edbde5696c751f8b984ce77609f1c021369b70c3
-- DRAFT ONLY. Not a standalone migration or hosted installation script.
-- This coordinated cutover guard blocks legacy direct Bale inserts and manual
-- deductions for newly scheduled weekly releases, including service/owner
-- maintenance paths. Existing historical records are not rewritten. Resolve
-- legacy open requests and outstanding advances before installing. A trusted
-- privileged owner can disable triggers or forge evidence; this is not a
-- protection against owner tampering, recovery jobs, or every legacy writer.
-- Requires reviewed weekly request, release, expiry, payroll and source guards.

-- Respect the weekly payroll writer's table order. Hold these until commit so
-- an old client cannot insert after the reconciliation check and before DDL.
LOCK TABLE public.advances,public.advance_requests,public.weekly_bale_requests,public.weekly_worker_draft_sources IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN
 IF to_regprocedure('public.record_weekly_bale_release(uuid)') IS NULL OR
    to_regprocedure('public.record_weekly_worker_payment(uuid,date,bigint)') IS NULL OR
    NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid='public.advance_requests'::regclass
      AND t.tgname='guard_weekly_bale_transition' AND NOT t.tgisinternal AND t.tgenabled='O'
      AND t.tgfoid=to_regprocedure('public.guard_weekly_bale_transition()')) THEN
  RAISE EXCEPTION 'Complete weekly Bale and payroll guards required'; END IF;
 IF EXISTS(SELECT 1 FROM public.advance_requests r LEFT JOIN public.weekly_bale_requests w ON w.request_id=r.id
   WHERE r.status IN ('pending_approval','approved_pending_payment') AND w.request_id IS NULL) OR
    EXISTS(SELECT 1 FROM public.advances a WHERE a.status IN ('active','partially_deducted') AND NOT EXISTS(
     SELECT 1 FROM public.advance_requests r JOIN public.weekly_bale_requests w ON w.request_id=r.id WHERE r.issued_advance_id=a.id)) THEN
  RAISE EXCEPTION 'Unresolved legacy open requests or outstanding Bale require reconciliation before cutover'; END IF;
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r(role_name)
  WHERE has_table_privilege(r.role_name,'public.weekly_bale_requests','INSERT,UPDATE,DELETE,TRUNCATE') OR
   has_table_privilege(r.role_name,'public.weekly_worker_draft_sources','INSERT,UPDATE,DELETE,TRUNCATE') OR
   EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid IN ('public.weekly_bale_requests'::regclass,'public.weekly_worker_draft_sources'::regclass)
    AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege(r.role_name,a.attrelid,a.attname,'INSERT,UPDATE'))) THEN
  RAISE EXCEPTION 'Weekly release or payroll evidence is writable through an API role'; END IF;
END $$;

-- The release function inserts an advance before linking it to the issued
-- request. Check the complete evidence at transaction end, not at INSERT.
CREATE FUNCTION public.require_weekly_bale_source_on_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.advance_requests r JOIN public.weekly_bale_requests w ON w.request_id=r.id
   WHERE r.issued_advance_id=NEW.id AND r.status='issued' AND r.worker_id=NEW.worker_id AND r.project_id=NEW.project_id
    AND r.requested_amount=NEW.amount AND NEW.date=w.period_start+3 AND NEW.amount_deducted=0 AND NEW.status='active'
    AND r.issued_by=w.release_actor AND w.release_actor IS NOT NULL AND w.release_xid IS NULL
    AND (r.issued_at AT TIME ZONE 'Asia/Manila')::date=NEW.date) THEN
  RAISE EXCEPTION 'Legacy Bale insertion blocked; refresh the page and check the records before retrying. If cash was already given, do not pay again; ask the Founder to review' USING ERRCODE='22023'; END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.require_weekly_bale_source_on_insert() FROM PUBLIC,anon,authenticated,service_role;
CREATE CONSTRAINT TRIGGER require_weekly_bale_source_on_insert AFTER INSERT ON public.advances
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_weekly_bale_source_on_insert();

-- Once issued, only the exact full deduction during its approved weekly
-- payment transaction may change a linked advance. Corrections cannot mutate
-- the original advance and require separate reconciliation.
CREATE FUNCTION public.guard_weekly_bale_balance_cutover() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.advance_requests r JOIN public.weekly_bale_requests w ON w.request_id=r.id
   WHERE r.issued_advance_id=OLD.id) THEN
  IF TG_OP='UPDATE' AND OLD.status='active' AND OLD.amount_deducted=0 AND NEW.status='fully_deducted'
   AND NEW.amount_deducted=OLD.amount AND (to_jsonb(NEW)-ARRAY['status','amount_deducted']) IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','amount_deducted'])
   AND auth.uid() IS NOT NULL AND EXISTS(SELECT 1 FROM public.weekly_worker_draft_sources s JOIN public.payroll p ON p.id=s.payroll_id
     WHERE s.worker_id=OLD.worker_id AND OLD.date BETWEEN s.period_start AND s.period_start+6 AND p.status='approved'
      AND s.payment_xid=txid_current() AND s.payment_actor=auth.uid()) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Weekly Bale is immutable outside its full source-bound payroll deduction' USING ERRCODE='22023';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_weekly_bale_balance_cutover() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER guard_weekly_bale_balance_cutover BEFORE UPDATE OR DELETE ON public.advances
 FOR EACH ROW EXECUTE FUNCTION public.guard_weekly_bale_balance_cutover();
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r(role_name)
  WHERE has_function_privilege(r.role_name,'public.require_weekly_bale_source_on_insert()','EXECUTE')
   OR has_function_privilege(r.role_name,'public.guard_weekly_bale_balance_cutover()','EXECUTE')) THEN
  RAISE EXCEPTION 'Unexpected inherited weekly Bale cutover trigger privilege'; END IF;
END $$;


-- supabase/drafts/weekly_worker_legacy_cutover_guard.sql sha256 2765d8c37a67b4fddfda0824b12785143401d28272948c59b0a1d4ad5ad15a40
-- DRAFT ONLY: not an installer. Execute only as part of a coordinated,
-- reviewed transaction on an isolated test database. This deliberately breaks
-- legacy payroll writers, including unauthenticated owner/service imports.
-- It does not make old clients safe, reconcile historical pay, enforce Bale
-- scheduling, guard privileged trigger disabling, or transfer money.
-- Requires the exact reviewed weekly generator, approval, allocation, return
-- and their enabled source-bound UPDATE/DELETE guard. Before a real cutover,
-- reconcile ALL unpaid or unrecognized legacy vouchers and identify every writer.
-- Existing paid vouchers are left untouched; new historical externally-paid
-- assertions must use a separate reviewed evidence path, not payroll INSERT.

-- Lock before the preflight so a concurrent legacy writer cannot slip an
-- unresolved voucher in between the check and trigger installation.
LOCK TABLE public.payroll, public.weekly_worker_draft_sources IN SHARE ROW EXCLUSIVE MODE;
DO $$
BEGIN
 IF to_regprocedure('public.create_weekly_worker_draft(uuid,uuid,date)') IS NULL OR
    to_regprocedure('public.approve_weekly_worker_draft(uuid,bigint)') IS NULL OR
    to_regprocedure('public.record_weekly_worker_payment(uuid,date,bigint)') IS NULL OR
    NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid='public.payroll'::regclass
      AND t.tgname='guard_weekly_worker_draft' AND NOT t.tgisinternal AND t.tgenabled='O'
      AND t.tgfoid=to_regprocedure('public.guard_weekly_worker_draft()')) THEN
  RAISE EXCEPTION 'Complete source-bound weekly workflow and enabled voucher guard required'; END IF;
 IF EXISTS(SELECT 1 FROM public.payroll p LEFT JOIN public.weekly_worker_draft_sources s ON s.payroll_id=p.id
   WHERE p.status IS DISTINCT FROM 'paid' AND s.payroll_id IS NULL) THEN
  RAISE EXCEPTION 'Unresolved legacy unpaid or unrecognized payroll requires reconciliation before cutover'; END IF;
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r(role_name)
   WHERE has_table_privilege(r.role_name,'public.weekly_worker_draft_sources','INSERT,UPDATE,DELETE,TRUNCATE')
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid='public.weekly_worker_draft_sources'::regclass
      AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege(r.role_name,a.attrelid,a.attname,'INSERT,UPDATE'))) THEN
  RAISE EXCEPTION 'Weekly source evidence is writable through an API role'; END IF;
END $$;

-- Generator inserts the payroll row first, then its protected source evidence.
-- A deferred check allows that atomic pair but rejects old/manual INSERTs at
-- transaction commit. It is not a substitute for a trusted generator, source
-- table permissions, existing immutability guard or review of privileged roles.
CREATE FUNCTION public.require_weekly_worker_source_on_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.weekly_worker_draft_sources s WHERE s.payroll_id=NEW.id
   AND s.worker_id=NEW.worker_id AND s.period_start=NEW.period_start AND NEW.period_end=NEW.period_start+6) THEN
  RAISE EXCEPTION 'Legacy payroll insertion blocked; refresh the page and use weekly payroll. Check the ledger before retrying' USING ERRCODE='22023'; END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.require_weekly_worker_source_on_insert() FROM PUBLIC,anon,authenticated,service_role;
CREATE CONSTRAINT TRIGGER require_weekly_worker_source_on_insert AFTER INSERT ON public.payroll
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_weekly_worker_source_on_insert();

-- Reject direct paid/approved inserts before the deferred source check. Also
-- prevent finalizing any pre-existing, unsourced legacy voucher after cutover.
-- Existing paid history is not modified; an already-approved legacy voucher
-- must be reconciled before installation rather than paid through an old client.
CREATE FUNCTION public.guard_weekly_worker_legacy_finalization() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.status IS DISTINCT FROM 'draft' THEN RAISE EXCEPTION 'New payroll must start as a source-bound weekly draft' USING ERRCODE='22023'; END IF;
 ELSIF OLD.status='paid' AND NEW.status IS DISTINCT FROM OLD.status AND NOT EXISTS(
  SELECT 1 FROM public.weekly_worker_draft_sources s WHERE s.payroll_id=OLD.id) THEN
  RAISE EXCEPTION 'Legacy paid payroll status is preserved; reconcile separately' USING ERRCODE='22023';
 ELSIF NEW.status IN ('approved','paid') AND NEW.status IS DISTINCT FROM OLD.status AND NOT EXISTS(
  SELECT 1 FROM public.weekly_worker_draft_sources s WHERE s.payroll_id=NEW.id AND s.worker_id=NEW.worker_id
   AND s.period_start=NEW.period_start AND NEW.period_end=NEW.period_start+6) THEN
  RAISE EXCEPTION 'Legacy payroll finalization blocked; refresh the page and reconcile the original voucher before retrying' USING ERRCODE='22023';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_weekly_worker_legacy_finalization() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER guard_weekly_worker_legacy_finalization BEFORE INSERT OR UPDATE ON public.payroll
 FOR EACH ROW EXECUTE FUNCTION public.guard_weekly_worker_legacy_finalization();
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r(role_name)
  WHERE has_function_privilege(r.role_name,'public.require_weekly_worker_source_on_insert()','EXECUTE')
   OR has_function_privilege(r.role_name,'public.guard_weekly_worker_legacy_finalization()','EXECUTE')) THEN
  RAISE EXCEPTION 'Unexpected inherited weekly cutover trigger privilege'; END IF;
END $$;


-- supabase/drafts/weekly_bale_external_monitor.sql sha256 7862a5a80ead566e3d285a048dc97a425d1fc388acc5def0b394efe7c7d0f630
-- DRAFT ONLY. Install alongside the reviewed weekly scheduler, never alone.
-- This provides a minimal read-only signal to an external database monitor.
-- It creates no login, grants no access, schedules nothing, and sends no alert.
-- A separately reviewed least-privilege monitoring login must be granted USAGE
-- on public and EXECUTE on this function by an authorized operator.
-- Keep its credentials outside source control. Do not grant it to an API role.

DO $$ BEGIN
 IF to_regprocedure('public.weekly_bale_clock()') IS NULL OR
    to_regprocedure('public.run_weekly_bale_expiry_job()') IS NULL OR
    to_regclass('public.weekly_bale_expiry_health') IS NULL OR
    to_regclass('public.weekly_bale_requests') IS NULL THEN
  RAISE EXCEPTION 'Weekly Bale scheduler and its dependencies are required';
 END IF;
END $$;

-- No names, IDs, balances or request details are returned. A stale, missing
-- or future heartbeat and any overdue request all fail closed. The clock and
-- the due-count query match the runner, and include rows locked by others.
CREATE FUNCTION public.weekly_bale_external_monitor_healthy() RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_now timestamptz:=public.weekly_bale_clock(); v_last timestamptz;
BEGIN
 IF auth.uid() IS NOT NULL THEN
  RAISE EXCEPTION 'External monitor must not use a user session' USING ERRCODE='42501';
 END IF;
 SELECT last_success INTO v_last FROM public.weekly_bale_expiry_health WHERE singleton;
 RETURN coalesce(v_last<=v_now AND v_last>=v_now-interval '3 minutes',false)
  AND NOT EXISTS(SELECT 1 FROM public.advance_requests r JOIN public.weekly_bale_requests w ON w.request_id=r.id
   WHERE r.status='pending_approval' AND (v_now AT TIME ZONE 'Asia/Manila')::date>w.period_start+2);
END $$;
REVOKE ALL ON FUNCTION public.weekly_bale_external_monitor_healthy() FROM PUBLIC,anon,authenticated,service_role;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r(role_name)
  WHERE has_function_privilege(r.role_name,'public.weekly_bale_external_monitor_healthy()','EXECUTE')) THEN
  RAISE EXCEPTION 'External monitor exposed through an inherited API privilege';
 END IF;
END $$;


-- supabase/drafts/project_cost_review_ledger.sql sha256 41d4c9fd94f1add70467c68b77bd4c5ff6b775071cfbad1d708d5f4e483f6993
-- EXPERIMENTAL DRAFT ONLY. Not a final project cost or release migration.
-- A Founder records an immutable, explicitly incomplete review of one bounded
-- snapshot. No expense, payment, allocation, Bale or accounting ledger is
-- changed. Missing legacy/external pay, unlinked correction cases, correction
-- allocations, duplicates and unrecorded items remain outside the snapshot;
-- a match is not completeness.
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
DO $preflight$
BEGIN
 IF to_regclass('public.projects') IS NULL OR to_regclass('public.users') IS NULL OR to_regprocedure('public.project_cost_reconciliation_preview(uuid)') IS NULL OR to_regprocedure('public.is_founder()') IS NULL OR to_regprocedure('public.session_assurance_satisfied()') IS NULL OR to_regprocedure('auth.uid()') IS NULL THEN RAISE EXCEPTION 'Project review prerequisites missing'; END IF;
 IF to_regclass('public.project_cost_reviews') IS NOT NULL OR to_regprocedure('public.record_project_cost_review(uuid,uuid,integer,jsonb,jsonb,text)') IS NOT NULL OR to_regprocedure('public.project_cost_review(uuid,integer)') IS NOT NULL OR to_regprocedure('public.guard_project_cost_review_immutable()') IS NOT NULL THEN RAISE EXCEPTION 'Project review objects already exist'; END IF;
END;
$preflight$;
CREATE TABLE public.project_cost_reviews (
 request_id uuid PRIMARY KEY,
 project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE RESTRICT,
 revision integer NOT NULL CHECK(revision>0),
 expected_revision integer NOT NULL CHECK(expected_revision>=0 AND revision=expected_revision+1),
 actor_id uuid NOT NULL,
 review_kind text NOT NULL CHECK(review_kind IN ('base','historical')),
 snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object' AND octet_length(snapshot::text)<=2097152),
 choices jsonb NOT NULL CHECK(jsonb_typeof(choices)='object'),
 note text NOT NULL CHECK(length(note) BETWEEN 1 AND 500 AND note=btrim(note)),
 included_expenses numeric(16,2) NOT NULL CHECK(included_expenses>=0),
 excluded_expenses numeric(16,2) NOT NULL CHECK(excluded_expenses>=0),
 paid_gross numeric(16,2) NOT NULL CHECK(paid_gross>=0),
 historical_gross numeric(16,2) NOT NULL CHECK(historical_gross>=0),
 excluded_historical numeric(16,2) NOT NULL CHECK(excluded_historical>=0),
 incomplete_total numeric(16,2) NOT NULL CHECK(incomplete_total=included_expenses+paid_gross+historical_gross),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(project_id,revision)
);
ALTER TABLE public.project_cost_reviews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.project_cost_reviews FROM PUBLIC,anon,authenticated,service_role;
DO $table_acl$
BEGIN
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r(role_name) WHERE has_table_privilege(r.role_name,'public.project_cost_reviews','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid='public.project_cost_reviews'::regclass AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege(r.role_name,a.attrelid,a.attname,'SELECT,INSERT,UPDATE'))) THEN RAISE EXCEPTION 'Unexpected project-review table privilege'; END IF;
END;
$table_acl$;
CREATE FUNCTION public.guard_project_cost_review_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$ BEGIN RAISE EXCEPTION 'Project reviews are immutable; record a new review' USING ERRCODE='23514'; END $$;
REVOKE ALL ON FUNCTION public.guard_project_cost_review_immutable() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER guard_project_cost_review_immutable BEFORE UPDATE OR DELETE ON public.project_cost_reviews FOR EACH ROW EXECUTE FUNCTION public.guard_project_cost_review_immutable();

-- Transaction is a record of a reviewed snapshot, not a lock on source data.
-- The snapshot can become stale immediately; read status always rechecks it.
-- Request and project locks serialize exact retries and revision increments.
CREATE FUNCTION public.record_project_cost_review(p_request uuid,p_project uuid,p_expected_revision integer,p_snapshot jsonb,p_choices jsonb,p_note text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid:=auth.uid();v_existing public.project_cost_reviews%ROWTYPE;v_latest integer;v_now jsonb;v_note text;v_exp numeric;v_excluded numeric;v_paid numeric;v_hist numeric:=0;v_excluded_hist numeric:=0;v_invalid boolean;v_kind text;v_base jsonb;v_exp_choices jsonb;v_hist_choices jsonb;
BEGIN
 IF v_actor IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Project review requires read committed' USING ERRCODE='P1002'; END IF;
 IF p_request IS NULL OR p_project IS NULL OR p_expected_revision IS NULL OR p_expected_revision<0 OR p_expected_revision>=2147483647 OR p_snapshot IS NULL OR jsonb_typeof(p_snapshot)<>'object' OR octet_length(p_snapshot::text)>2097152 OR p_choices IS NULL OR jsonb_typeof(p_choices)<>'object' OR octet_length(p_choices::text)>100000 OR p_note IS NULL OR length(btrim(p_note)) NOT BETWEEN 1 AND 500 OR btrim(p_note) ~ '[[:cntrl:]]' THEN RAISE EXCEPTION 'Invalid project review' USING ERRCODE='22023'; END IF;
 v_note:=btrim(p_note);
 v_kind:=CASE WHEN p_snapshot ? 'base' AND p_snapshot ? 'historical' THEN 'historical' ELSE 'base' END;
 PERFORM 1 FROM public.users WHERE id=v_actor AND role='founder' FOR SHARE;
 IF NOT FOUND OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('project-cost-review-request:'||p_request::text,0));
 SELECT * INTO v_existing FROM public.project_cost_reviews WHERE request_id=p_request;
 IF FOUND THEN
  IF (v_existing.project_id,v_existing.actor_id,v_existing.expected_revision,v_existing.review_kind,CASE WHEN v_kind='historical' THEN v_existing.snapshot #- '{base,captured_at}' ELSE v_existing.snapshot-'captured_at' END,v_existing.choices,v_existing.note) IS DISTINCT FROM (p_project,v_actor,p_expected_revision,v_kind,CASE WHEN v_kind='historical' THEN p_snapshot #- '{base,captured_at}' ELSE p_snapshot-'captured_at' END,p_choices,v_note) THEN RAISE EXCEPTION 'Review request ID already used for different details' USING ERRCODE='22023'; END IF;
  RETURN jsonb_build_object('request_id',p_request,'project_id',p_project,'revision',v_existing.revision,'replayed',true);
 END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('project-cost-review-project:'||p_project::text,0));
 PERFORM 1 FROM public.projects WHERE id=p_project FOR KEY SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Project unavailable' USING ERRCODE='42501'; END IF;
 SELECT coalesce(max(revision),0) INTO v_latest FROM public.project_cost_reviews WHERE project_id=p_project;
 IF v_latest<>p_expected_revision THEN RAISE EXCEPTION 'Project review changed; reload before saving' USING ERRCODE='40001'; END IF;
 IF v_kind='historical' THEN
  IF to_regprocedure('public.project_cost_historical_review(uuid)') IS NULL THEN RAISE EXCEPTION 'Historical review unavailable' USING ERRCODE='P0002'; END IF;
  EXECUTE 'SELECT public.project_cost_historical_review($1)' INTO v_now USING p_project;
  IF v_now #- '{base,captured_at}' IS DISTINCT FROM p_snapshot #- '{base,captured_at}' THEN RAISE EXCEPTION 'Project evidence changed; reload and review again' USING ERRCODE='40001'; END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(p_choices))<>2 OR NOT (p_choices ? 'expenses' AND p_choices ? 'historical') OR jsonb_typeof(p_choices->'expenses') IS DISTINCT FROM 'object' OR jsonb_typeof(p_choices->'historical') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid historical decisions' USING ERRCODE='22023'; END IF;
  v_base:=v_now->'base';v_exp_choices:=p_choices->'expenses';v_hist_choices:=p_choices->'historical';
  IF (SELECT count(*) FROM jsonb_object_keys(v_hist_choices))<>jsonb_array_length(v_now->'historical') THEN RAISE EXCEPTION 'Review every historical attribution exactly once' USING ERRCODE='22023'; END IF;
  SELECT EXISTS(SELECT 1 FROM jsonb_array_elements(v_now->'historical') h WHERE NOT (v_hist_choices ? (h->>'request_id'))) OR EXISTS(
   SELECT 1 FROM jsonb_each(v_hist_choices) c WHERE jsonb_typeof(c.value)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(CASE WHEN jsonb_typeof(c.value)='object' THEN c.value ELSE '{}'::jsonb END))<>2 OR NOT (c.value ? 'decision' AND c.value ? 'reason') OR coalesce(c.value->>'decision','') NOT IN ('include','exclude')
    OR (c.value->>'decision'='include' AND c.value->'reason'<>'null'::jsonb)
    OR (c.value->>'decision'='exclude' AND (jsonb_typeof(c.value->'reason') IS DISTINCT FROM 'string' OR length(btrim(c.value->>'reason')) NOT BETWEEN 1 AND 300 OR btrim(c.value->>'reason')<>(c.value->>'reason') OR (c.value->>'reason') ~ '[[:cntrl:]]'))
  ) OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_now->'historical') h WHERE v_hist_choices->(h->>'request_id')->>'decision'='include' AND ((h->>'case_count')::bigint<>0 OR (h->>'overlapping_vouchers')::bigint<>0)) INTO v_invalid;
  IF v_invalid THEN RAISE EXCEPTION 'Invalid historical decisions or unresolved case or overlap' USING ERRCODE='22023'; END IF;
  SELECT coalesce(sum((h->>'site_gross')::numeric) FILTER (WHERE v_hist_choices->(h->>'request_id')->>'decision'='include'),0),coalesce(sum((h->>'site_gross')::numeric) FILTER (WHERE v_hist_choices->(h->>'request_id')->>'decision'='exclude'),0) INTO v_hist,v_excluded_hist FROM jsonb_array_elements(v_now->'historical') h;
 ELSE
  v_now:=public.project_cost_reconciliation_preview(p_project);
  IF v_now-'captured_at' IS DISTINCT FROM p_snapshot-'captured_at' THEN RAISE EXCEPTION 'Project evidence changed; reload and review again' USING ERRCODE='40001'; END IF;
  v_base:=v_now;v_exp_choices:=p_choices;
 END IF;
 -- Require exactly one explicit decision per expense and a reason for each
 -- exclusion. Do not infer duplicate status from an AI flag or a name.
 IF (SELECT count(*) FROM jsonb_object_keys(v_exp_choices))<>jsonb_array_length(v_base->'expenses') THEN RAISE EXCEPTION 'Review every expense exactly once' USING ERRCODE='22023'; END IF;
 SELECT EXISTS(SELECT 1 FROM jsonb_array_elements(v_base->'expenses') e WHERE NOT (v_exp_choices ? (e->>'id'))) OR EXISTS(
  SELECT 1 FROM jsonb_each(v_exp_choices) c WHERE jsonb_typeof(c.value)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(CASE WHEN jsonb_typeof(c.value)='object' THEN c.value ELSE '{}'::jsonb END))<>2 OR NOT (c.value ? 'decision' AND c.value ? 'reason') OR coalesce(c.value->>'decision','') NOT IN ('include','exclude')
   OR (c.value->>'decision'='include' AND c.value->'reason'<>'null'::jsonb)
   OR (c.value->>'decision'='exclude' AND (jsonb_typeof(c.value->'reason') IS DISTINCT FROM 'string' OR length(btrim(c.value->>'reason')) NOT BETWEEN 1 AND 300 OR btrim(c.value->>'reason')<>(c.value->>'reason') OR (c.value->>'reason') ~ '[[:cntrl:]]'))
 ) INTO v_invalid;
 IF v_invalid THEN RAISE EXCEPTION 'Invalid expense decisions or exclusion reasons' USING ERRCODE='22023'; END IF;
 SELECT coalesce(sum((e->>'amount')::numeric) FILTER (WHERE v_exp_choices->(e->>'id')->>'decision'='include'),0),coalesce(sum((e->>'amount')::numeric) FILTER (WHERE v_exp_choices->(e->>'id')->>'decision'='exclude'),0) INTO v_exp,v_excluded FROM jsonb_array_elements(v_base->'expenses') e;
 SELECT coalesce(sum((a->>'gross')::numeric),0) INTO v_paid FROM jsonb_array_elements(v_base->'paid_allocations') a;
 IF v_exp<0 OR v_excluded<0 OR v_paid<0 OR v_exp<>round(v_exp,2) OR v_excluded<>round(v_excluded,2) OR v_paid<>round(v_paid,2) OR v_hist<0 OR v_excluded_hist<0 OR v_hist<>round(v_hist,2) OR v_excluded_hist<>round(v_excluded_hist,2) OR v_exp+v_paid+v_hist>=100000000000000 THEN RAISE EXCEPTION 'Invalid reviewed totals' USING ERRCODE='22023'; END IF;
 INSERT INTO public.project_cost_reviews(request_id,project_id,revision,expected_revision,actor_id,review_kind,snapshot,choices,note,included_expenses,excluded_expenses,paid_gross,historical_gross,excluded_historical,incomplete_total)
 VALUES(p_request,p_project,v_latest+1,v_latest,v_actor,v_kind,v_now,p_choices,v_note,v_exp,v_excluded,v_paid,v_hist,v_excluded_hist,v_exp+v_paid+v_hist);
 RETURN jsonb_build_object('request_id',p_request,'project_id',p_project,'revision',v_latest+1,'replayed',false);
END;
$$;
REVOKE ALL ON FUNCTION public.record_project_cost_review(uuid,uuid,integer,jsonb,jsonb,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.record_project_cost_review(uuid,uuid,integer,jsonb,jsonb,text) TO authenticated;

-- A matching snapshot means only the included sources match at this read; it
-- does not establish completeness, accounting correctness or proof of payment.
CREATE FUNCTION public.project_cost_review(p_project uuid,p_revision integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_row public.project_cost_reviews%ROWTYPE;v_latest integer;v_now jsonb;v_freshness text:='unavailable';
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 IF p_project IS NULL OR (p_revision IS NOT NULL AND p_revision<1) OR NOT EXISTS(SELECT 1 FROM public.projects WHERE id=p_project) THEN RAISE EXCEPTION 'Project review unavailable' USING ERRCODE='22023'; END IF;
 SELECT coalesce(max(revision),0) INTO v_latest FROM public.project_cost_reviews WHERE project_id=p_project;
 IF v_latest=0 AND p_revision IS NULL THEN RETURN jsonb_build_object('project_id',p_project,'found',false,'latest_revision',0); END IF;
 SELECT * INTO v_row FROM public.project_cost_reviews WHERE project_id=p_project AND revision=coalesce(p_revision,v_latest);
 IF NOT FOUND THEN RAISE EXCEPTION 'Project review unavailable' USING ERRCODE='P0002'; END IF;
 BEGIN
  IF v_row.review_kind='historical' THEN
   IF to_regprocedure('public.project_cost_historical_review(uuid)') IS NULL THEN RAISE EXCEPTION 'Historical review unavailable'; END IF;
   EXECUTE 'SELECT public.project_cost_historical_review($1)' INTO v_now USING p_project;
   v_freshness:=CASE WHEN v_now #- '{base,captured_at}'=v_row.snapshot #- '{base,captured_at}' THEN 'matches' ELSE 'changed' END;
  ELSE
   v_now:=public.project_cost_reconciliation_preview(p_project);
   v_freshness:=CASE WHEN v_now-'captured_at'=v_row.snapshot-'captured_at' THEN 'matches' ELSE 'changed' END;
  END IF;
 EXCEPTION WHEN others THEN v_freshness:='unavailable'; END;
 RETURN jsonb_build_object('project_id',p_project,'found',true,'latest_revision',v_latest,'revision',v_row.revision,'request_id',v_row.request_id,'actor_id',v_row.actor_id,'recorded_at',v_row.recorded_at,'review_kind',v_row.review_kind,'snapshot',v_row.snapshot,'choices',v_row.choices,'note',v_row.note,'included_expenses',v_row.included_expenses::text,'excluded_expenses',v_row.excluded_expenses::text,'paid_gross',v_row.paid_gross::text,'historical_gross',v_row.historical_gross::text,'excluded_historical',v_row.excluded_historical::text,'incomplete_total',v_row.incomplete_total::text,'freshness',v_freshness);
END;
$$;
REVOKE ALL ON FUNCTION public.project_cost_review(uuid,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.project_cost_review(uuid,integer) TO authenticated;
DO $function_acl$
BEGIN
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['anon','service_role']) r(role_name) WHERE has_function_privilege(r.role_name,'public.record_project_cost_review(uuid,uuid,integer,jsonb,jsonb,text)','EXECUTE') OR has_function_privilege(r.role_name,'public.project_cost_review(uuid,integer)','EXECUTE') OR has_function_privilege(r.role_name,'public.guard_project_cost_review_immutable()','EXECUTE')) OR has_function_privilege('authenticated','public.guard_project_cost_review_immutable()','EXECUTE') OR NOT has_function_privilege('authenticated','public.record_project_cost_review(uuid,uuid,integer,jsonb,jsonb,text)','EXECUTE') OR NOT has_function_privilege('authenticated','public.project_cost_review(uuid,integer)','EXECUTE') THEN RAISE EXCEPTION 'Unexpected project-review function privilege'; END IF;
END;
$function_acl$;


-- supabase/drafts/historical_worker_project_attribution.sql sha256 b424d19a1cfc5c556d281c2d1d01bbcda70f5feab39a0815ae371a9e50537c2a
-- UNINSTALLED EXPERIMENT. Founder-reviewed attribution evidence for ONE
-- already-recorded external worker-week assertion. This is not a voucher,
-- payment, transfer, expense, automatic project-cost posting or proof. Never
-- infer a historical site from current assignments. The Founder must review
-- original records, other costs, possible duplicates and ALL original-period
-- cases. Each assertion can be attributed once, in a complete explicit split;
-- changes/corrections require a separately reviewed future design. Do not
-- install alone, enable on a shared database or use as a final ledger.
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
DO $preflight$
BEGIN
 IF to_regclass('public.historical_external_worker_payroll') IS NULL OR to_regclass('public.paid_period_assertion_cases') IS NULL OR to_regclass('public.projects') IS NULL OR to_regclass('public.users') IS NULL OR to_regprocedure('public.historical_external_worker_lookup(uuid)') IS NULL OR to_regprocedure('auth.uid()') IS NULL OR to_regprocedure('public.is_founder()') IS NULL OR to_regprocedure('public.session_assurance_satisfied()') IS NULL THEN RAISE EXCEPTION 'Historical attribution prerequisites missing'; END IF;
 IF to_regclass('public.historical_worker_attributions') IS NOT NULL OR to_regclass('public.historical_worker_attribution_sites') IS NOT NULL OR to_regprocedure('public.record_historical_worker_attribution(uuid,uuid,jsonb,jsonb,text,boolean)') IS NOT NULL OR to_regprocedure('public.historical_worker_attribution(uuid)') IS NOT NULL OR to_regprocedure('public.historical_worker_attribution_projects()') IS NOT NULL OR to_regprocedure('public.project_historical_worker_attributions(uuid)') IS NOT NULL OR to_regprocedure('public.guard_historical_worker_attribution_immutable()') IS NOT NULL THEN RAISE EXCEPTION 'Historical attribution objects already exist'; END IF;
END;
$preflight$;
CREATE TABLE public.historical_worker_attributions (
 request_id uuid PRIMARY KEY,
 source_id uuid NOT NULL UNIQUE REFERENCES public.historical_external_worker_payroll(request_id) ON DELETE RESTRICT,
 source_snapshot jsonb NOT NULL CHECK(jsonb_typeof(source_snapshot)='object' AND octet_length(source_snapshot::text)<=65536),
 split jsonb NOT NULL CHECK(jsonb_typeof(split)='array' AND jsonb_array_length(split) BETWEEN 1 AND 50),
 note text NOT NULL CHECK(length(note) BETWEEN 1 AND 500 AND note=btrim(note)),
 actor_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE public.historical_worker_attribution_sites (
 attribution_id uuid NOT NULL REFERENCES public.historical_worker_attributions(request_id) ON DELETE RESTRICT,
 project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE RESTRICT,
 gross numeric(10,2) NOT NULL CHECK(gross>0),
 PRIMARY KEY(attribution_id,project_id)
);
CREATE INDEX historical_worker_attribution_project_idx ON public.historical_worker_attribution_sites(project_id,attribution_id);
ALTER TABLE public.historical_worker_attributions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.historical_worker_attribution_sites ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.historical_worker_attributions,public.historical_worker_attribution_sites FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.guard_historical_worker_attribution_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$ BEGIN RAISE EXCEPTION 'Historical attribution is immutable; separate review required' USING ERRCODE='23514'; END $$;
REVOKE ALL ON FUNCTION public.guard_historical_worker_attribution_immutable() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER historical_worker_attribution_immutable BEFORE UPDATE OR DELETE ON public.historical_worker_attributions FOR EACH ROW EXECUTE FUNCTION public.guard_historical_worker_attribution_immutable();
CREATE TRIGGER historical_worker_attribution_sites_immutable BEFORE UPDATE OR DELETE ON public.historical_worker_attribution_sites FOR EACH ROW EXECUTE FUNCTION public.guard_historical_worker_attribution_immutable();

-- All projects, including completed/archived ones, are candidates for a
-- historical split. This list does not prove work occurred at any of them.
CREATE FUNCTION public.historical_worker_attribution_projects() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_items jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 IF (SELECT count(*) FROM public.projects)>2000 THEN RAISE EXCEPTION 'Project catalog exceeds attribution limit' USING ERRCODE='54000'; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name) ORDER BY name,id),'[]'::jsonb) INTO v_items FROM public.projects;
 IF octet_length(v_items::text)>1048576 THEN RAISE EXCEPTION 'Project catalog too large' USING ERRCODE='54000'; END IF;
 RETURN jsonb_build_object('projects',v_items);
END;
$$;

CREATE FUNCTION public.record_historical_worker_attribution(p_request uuid,p_source uuid,p_expected jsonb,p_split jsonb,p_note text,p_ack boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid:=auth.uid();v_old public.historical_worker_attributions%ROWTYPE;v_source public.historical_external_worker_payroll%ROWTYPE;v_split jsonb;v_note text;v_amount numeric;v_item jsonb;v_project uuid;v_sum numeric:=0;v_projects uuid[]:='{}';
BEGIN
 IF v_actor IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Historical attribution requires read committed isolation' USING ERRCODE='P1002'; END IF;
 IF p_request IS NULL OR p_source IS NULL OR p_expected IS NULL OR jsonb_typeof(p_expected)<>'object' OR octet_length(p_expected::text)>65536 OR p_split IS NULL OR jsonb_typeof(p_split)<>'array' OR octet_length(p_split::text)>16384 OR jsonb_array_length(p_split) NOT BETWEEN 1 AND 50 OR p_note IS NULL OR length(btrim(p_note)) NOT BETWEEN 1 AND 500 OR btrim(p_note) ~ '[[:cntrl:]]' OR p_ack IS DISTINCT FROM true THEN RAISE EXCEPTION 'Invalid attribution request' USING ERRCODE='22023'; END IF;
 v_note:=btrim(p_note);v_split:='[]'::jsonb;
 FOR v_item IN SELECT value FROM jsonb_array_elements(p_split) LOOP
  IF jsonb_typeof(v_item)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(CASE WHEN jsonb_typeof(v_item)='object' THEN v_item ELSE '{}'::jsonb END))<>2 OR NOT (v_item ? 'project_id' AND v_item ? 'gross') OR jsonb_typeof(v_item->'project_id') IS DISTINCT FROM 'string' OR (v_item->>'project_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR jsonb_typeof(v_item->'gross') IS DISTINCT FROM 'string' OR (v_item->>'gross') !~ '^(0|[1-9][0-9]{0,7})\.[0-9]{2}$' THEN RAISE EXCEPTION 'Invalid attribution site or gross' USING ERRCODE='22023'; END IF;
  v_project:=(v_item->>'project_id')::uuid;v_amount:=(v_item->>'gross')::numeric;
  IF v_amount<=0 OR v_project=ANY(v_projects) THEN RAISE EXCEPTION 'Duplicate project or non-positive attribution' USING ERRCODE='22023'; END IF;
  v_projects:=array_append(v_projects,v_project);v_sum:=v_sum+v_amount;
  v_split:=v_split||jsonb_build_array(jsonb_build_object('project_id',v_project,'gross',v_amount::numeric(10,2)::text));
 END LOOP;
 -- Canonical project order makes retries and evidence comparisons stable.
 SELECT jsonb_agg(value ORDER BY (value->>'project_id')::uuid) INTO v_split FROM jsonb_array_elements(v_split);
 PERFORM 1 FROM public.users WHERE id=v_actor AND role='founder' FOR SHARE;
 IF NOT FOUND OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('historical-attribution-request:'||p_request::text,0));
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('historical-attribution-source:'||p_source::text,0));
 SELECT * INTO v_old FROM public.historical_worker_attributions WHERE request_id=p_request;
 IF FOUND THEN
  IF (v_old.source_id,v_old.source_snapshot,v_old.split,v_old.note,v_old.actor_id) IS DISTINCT FROM (p_source,p_expected,v_split,v_note,v_actor) THEN RAISE EXCEPTION 'Attribution request ID used for different details' USING ERRCODE='22023'; END IF;
  IF public.historical_external_worker_lookup(p_source) IS DISTINCT FROM v_old.source_snapshot OR
   (SELECT coalesce(jsonb_agg(jsonb_build_object('project_id',x.project_id,'gross',x.gross::text) ORDER BY x.project_id),'[]'::jsonb) FROM public.historical_worker_attribution_sites x WHERE x.attribution_id=v_old.request_id) IS DISTINCT FROM v_old.split THEN
   RAISE EXCEPTION 'Historical attribution evidence differs; investigate before retry' USING ERRCODE='22023'; END IF;
  RETURN jsonb_build_object('request_id',p_request,'source_id',p_source,'replayed',true);
 END IF;
 SELECT * INTO v_source FROM public.historical_external_worker_payroll WHERE request_id=p_source FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Historical assertion unavailable' USING ERRCODE='P0002'; END IF;
 IF public.historical_external_worker_lookup(p_source) IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'Historical assertion changed; reload and review' USING ERRCODE='40001'; END IF;
 IF v_source.gross<=0 OR v_sum<>v_source.gross THEN RAISE EXCEPTION 'Site amounts must equal the full positive original gross' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM public.historical_worker_attributions WHERE source_id=p_source) THEN RAISE EXCEPTION 'Historical assertion already attributed; separate review required' USING ERRCODE='23505'; END IF;
 IF (SELECT count(*) FROM public.projects WHERE id=ANY(v_projects))<>cardinality(v_projects) THEN RAISE EXCEPTION 'Attribution project unavailable' USING ERRCODE='22023'; END IF;
 INSERT INTO public.historical_worker_attributions(request_id,source_id,source_snapshot,split,note,actor_id) VALUES(p_request,p_source,p_expected,v_split,v_note,v_actor);
 INSERT INTO public.historical_worker_attribution_sites(attribution_id,project_id,gross) SELECT p_request,(v->>'project_id')::uuid,(v->>'gross')::numeric FROM jsonb_array_elements(v_split) v;
 RETURN jsonb_build_object('request_id',p_request,'source_id',p_source,'replayed',false);
END;
$$;

-- Complete original plus split; a missing result is not proof an in-flight
-- request failed. A changed privileged source is returned as changed, never
-- silently re-attributed. The case count is a signal, not a site allocation.
CREATE FUNCTION public.historical_worker_attribution(p_source uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_row public.historical_worker_attributions%ROWTYPE;v_current jsonb;v_cases bigint;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 IF p_source IS NULL THEN RAISE EXCEPTION 'Historical assertion required' USING ERRCODE='22023'; END IF;
 SELECT * INTO v_row FROM public.historical_worker_attributions WHERE source_id=p_source;
 IF NOT FOUND THEN RETURN jsonb_build_object('found',false); END IF;
 v_current:=public.historical_external_worker_lookup(p_source);
 IF (SELECT coalesce(jsonb_agg(jsonb_build_object('project_id',x.project_id,'gross',x.gross::text) ORDER BY x.project_id),'[]'::jsonb) FROM public.historical_worker_attribution_sites x WHERE x.attribution_id=v_row.request_id) IS DISTINCT FROM v_row.split THEN
  RAISE EXCEPTION 'Historical attribution split differs; investigate' USING ERRCODE='22023'; END IF;
 SELECT count(*) INTO v_cases FROM public.paid_period_assertion_cases WHERE external_worker_id=p_source;
 RETURN jsonb_build_object('found',true,'request_id',v_row.request_id,'source_id',p_source,'source',v_row.source_snapshot,'source_changed',v_current IS DISTINCT FROM v_row.source_snapshot,'split',v_row.split,'note',v_row.note,'actor_id',v_row.actor_id,'recorded_at',v_row.recorded_at,'case_count',v_cases);
END;
$$;

CREATE FUNCTION public.project_historical_worker_attributions(p_project uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_count bigint;v_items jsonb;v_bad boolean;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 IF p_project IS NULL OR NOT EXISTS(SELECT 1 FROM public.projects WHERE id=p_project) THEN RAISE EXCEPTION 'Project unavailable' USING ERRCODE='42501'; END IF;
 SELECT count(*) INTO v_count FROM public.historical_worker_attribution_sites WHERE project_id=p_project;
 IF v_count>200 THEN RAISE EXCEPTION 'More than 200 historical attributions; separate reconciliation required' USING ERRCODE='54000'; END IF;
 -- Fail closed if privileged writes ever alter a stored split or site total.
 SELECT EXISTS(SELECT 1 FROM public.historical_worker_attribution_sites s JOIN public.historical_worker_attributions a ON a.request_id=s.attribution_id JOIN public.historical_external_worker_payroll h ON h.request_id=a.source_id WHERE s.project_id=p_project AND (
  a.source_snapshot IS DISTINCT FROM public.historical_external_worker_lookup(a.source_id) OR
  (SELECT coalesce(sum(x.gross),0) FROM public.historical_worker_attribution_sites x WHERE x.attribution_id=a.request_id)<>h.gross OR
  (SELECT coalesce(jsonb_agg(jsonb_build_object('project_id',x.project_id,'gross',x.gross::text) ORDER BY x.project_id),'[]'::jsonb) FROM public.historical_worker_attribution_sites x WHERE x.attribution_id=a.request_id) IS DISTINCT FROM a.split)) INTO v_bad;
 IF v_bad THEN RAISE EXCEPTION 'Historical attribution evidence differs; investigate' USING ERRCODE='22023'; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('request_id',a.request_id,'source_id',a.source_id,'worker_id',h.worker_id,'worker_name',h.worker_snapshot->>'name','period_start',h.period_start,'period_end',h.period_end,'paid_on',h.paid_on,'original_gross',h.gross::text,'site_gross',s.gross::text,'note',a.note,'recorded_by',a.actor_id,'recorded_at',a.recorded_at,'case_count',(SELECT count(*) FROM public.paid_period_assertion_cases c WHERE c.external_worker_id=h.request_id)) ORDER BY h.period_start DESC,a.request_id DESC),'[]'::jsonb) INTO v_items
 FROM public.historical_worker_attribution_sites s JOIN public.historical_worker_attributions a ON a.request_id=s.attribution_id JOIN public.historical_external_worker_payroll h ON h.request_id=a.source_id WHERE s.project_id=p_project;
 IF octet_length(v_items::text)>1048576 THEN RAISE EXCEPTION 'Historical attribution list too large' USING ERRCODE='54000'; END IF;
 RETURN jsonb_build_object('project_id',p_project,'items',v_items);
END;
$$;
REVOKE ALL ON FUNCTION public.record_historical_worker_attribution(uuid,uuid,jsonb,jsonb,text,boolean),public.historical_worker_attribution(uuid),public.project_historical_worker_attributions(uuid),public.historical_worker_attribution_projects() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.record_historical_worker_attribution(uuid,uuid,jsonb,jsonb,text,boolean),public.historical_worker_attribution(uuid),public.project_historical_worker_attributions(uuid),public.historical_worker_attribution_projects() TO authenticated;
DO $postflight$
DECLARE n text; r text; t regclass;
BEGIN
 FOREACH n IN ARRAY ARRAY['public.historical_worker_attributions','public.historical_worker_attribution_sites'] LOOP
  t:=pg_catalog.to_regclass(n);
  FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
   IF pg_catalog.has_table_privilege(r,t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid=t AND a.attnum>0 AND NOT a.attisdropped AND pg_catalog.has_column_privilege(r,t,a.attname,'SELECT,INSERT,UPDATE,REFERENCES')) THEN RAISE EXCEPTION 'Unexpected historical attribution table privilege'; END IF;
  END LOOP;
 END LOOP;
 FOREACH n IN ARRAY ARRAY['public.record_historical_worker_attribution(uuid,uuid,jsonb,jsonb,text,boolean)','public.historical_worker_attribution(uuid)','public.project_historical_worker_attributions(uuid)','public.historical_worker_attribution_projects()'] LOOP
  IF pg_catalog.has_function_privilege('anon',n,'EXECUTE') OR pg_catalog.has_function_privilege('service_role',n,'EXECUTE') OR NOT pg_catalog.has_function_privilege('authenticated',n,'EXECUTE') THEN RAISE EXCEPTION 'Unexpected historical attribution RPC privilege'; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) AS roles(role_name) WHERE pg_catalog.has_function_privilege(roles.role_name,'public.guard_historical_worker_attribution_immutable()','EXECUTE')) THEN RAISE EXCEPTION 'Unexpected historical attribution guard privilege'; END IF;
END;
$postflight$;


-- supabase/drafts/project_cost_historical_review.sql sha256 f547cda26c4848940c0c9871910d0f50f897377ab3d579692e35cf4d15b634dd
-- UNINSTALLED, READ-ONLY CANDIDATE. Combine bounded current project-cost
-- evidence and attributed external worker history in ONE statement snapshot.
-- No payment, accounting posting, saved review, allocation, or transfer.
-- A same-worker overlapping voucher is only a duplicate signal; it does not
-- prove payment or find duplicate expenses/identities/external transactions.
-- Historical case counts are whole-period signals, not site corrections.
-- Requires both exact reviewed underlying candidates and coordinated cutover.
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
DO $preflight$
BEGIN
 IF to_regprocedure('public.project_cost_reconciliation_preview(uuid)') IS NULL OR
    to_regprocedure('public.project_historical_worker_attributions(uuid)') IS NULL OR
    to_regclass('public.payroll') IS NULL OR to_regprocedure('public.is_founder()') IS NULL OR
    to_regprocedure('public.session_assurance_satisfied()') IS NULL OR to_regprocedure('auth.uid()') IS NULL THEN
  RAISE EXCEPTION 'Combined project review prerequisites missing'; END IF;
 IF to_regprocedure('public.project_cost_historical_review(uuid)') IS NOT NULL THEN RAISE EXCEPTION 'Combined project review already exists'; END IF;
END;
$preflight$;
CREATE FUNCTION public.project_cost_historical_review(p_project uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_base jsonb;v_history jsonb;v_items jsonb;v_result jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN
  RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 v_base:=public.project_cost_reconciliation_preview(p_project);
 v_history:=public.project_historical_worker_attributions(p_project);
 -- Count matching worker/date-range vouchers at ANY project and ANY status.
 -- Even a draft may signal a duplicate; never infer a real-world payment.
 SELECT coalesce(jsonb_agg(item.value||jsonb_build_object('overlapping_vouchers',
  (SELECT count(*) FROM public.payroll p WHERE p.worker_id=(item.value->>'worker_id')::uuid
   AND p.period_start<=(item.value->>'period_end')::date AND p.period_end>=(item.value->>'period_start')::date))
  ORDER BY item.ordinality),'[]'::jsonb) INTO v_items
 FROM jsonb_array_elements(v_history->'items') WITH ORDINALITY item(value,ordinality);
 v_result:=jsonb_build_object('project_id',p_project,'base',v_base,'historical',v_items);
 IF octet_length(v_result::text)>2097152 THEN RAISE EXCEPTION 'Combined review too large' USING ERRCODE='54000'; END IF;
 RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.project_cost_historical_review(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.project_cost_historical_review(uuid) TO authenticated;
DO $postflight$
BEGIN
 IF has_function_privilege('anon','public.project_cost_historical_review(uuid)','EXECUTE') OR
    has_function_privilege('service_role','public.project_cost_historical_review(uuid)','EXECUTE') OR
    NOT has_function_privilege('authenticated','public.project_cost_historical_review(uuid)','EXECUTE') OR
    NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.project_cost_historical_review(uuid)'::regprocedure AND prosecdef AND provolatile='s' AND proconfig @> ARRAY['search_path=""']) THEN
  RAISE EXCEPTION 'Unexpected combined project review privileges'; END IF;
END;
$postflight$;


-- supabase/drafts/owned_equipment_allocations.sql sha256 27493b4694da127b6be3293763a10eabfe2911ba1079137f1d5ba2f229730411
-- UNINSTALLED DRAFT. Execute only as a reviewed single transaction, after
-- compatibility, permissions, legacy clients, history and recovery checks.
-- Opt-in adoption requires explicit physical confirmation by a Founder.
-- A NULL legacy project may mean unassigned, not necessarily depot stock.
-- Site adoption preserves the entire recorded stock at the original site.
-- No existing records are converted or updated by installation.
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
DO $preflight$
DECLARE v_missing text; n text;
BEGIN
 IF to_regclass('public.tools') IS NULL OR to_regclass('public.projects') IS NULL OR to_regclass('public.users') IS NULL OR to_regprocedure('auth.uid()') IS NULL OR to_regprocedure('public.is_founder()') IS NULL OR to_regprocedure('public.is_supervisor_assigned(uuid)') IS NULL OR to_regprocedure('public.session_assurance_satisfied()') IS NULL THEN RAISE EXCEPTION 'Equipment prerequisites missing'; END IF;
 LOCK TABLE public.tools IN SHARE MODE;
 SELECT string_agg(r.rel||'.'||r.col,', ' ORDER BY r.rel,r.col) INTO v_missing FROM
 (VALUES ('tools','id','uuid'),('tools','name','text'),('tools','quantity','integer'),('tools','condition','text'),('tools','project_id','uuid'),('projects','id','uuid'),('projects','name','text'),('users','id','uuid'),('users','role','text')) r(rel,col,typ)
 LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=to_regclass('public.'||r.rel) AND a.attname=r.col AND a.attnum>0 AND NOT a.attisdropped
 WHERE a.attname IS NULL OR pg_catalog.format_type(a.atttypid,a.atttypmod) IS DISTINCT FROM r.typ;
 IF v_missing IS NOT NULL THEN RAISE EXCEPTION 'Equipment prerequisite columns missing or different: %',v_missing; END IF;
 FOREACH n IN ARRAY ARRAY['public.managed_owned_equipment','public.owned_equipment_allocations','public.owned_equipment_events'] LOOP
  IF to_regclass(n) IS NOT NULL THEN RAISE EXCEPTION 'Equipment relation already exists: %',n; END IF;
 END LOOP;
 FOREACH n IN ARRAY ARRAY['public.guard_managed_equipment()','public.change_owned_equipment(uuid,uuid,text,uuid,integer,integer,integer)','public.owned_equipment_snapshot()','public.owned_equipment_operation_status(uuid)','public.project_equipment_snapshot(uuid)'] LOOP
  IF to_regprocedure(n) IS NOT NULL THEN RAISE EXCEPTION 'Equipment function already exists: %',n; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.tools'::regclass AND NOT tgisinternal) THEN RAISE EXCEPTION 'Existing equipment triggers require separate review'; END IF;
END;
$preflight$;

CREATE TABLE public.managed_owned_equipment (
 tool_id uuid PRIMARY KEY REFERENCES public.tools(id) ON DELETE RESTRICT,
 adopted_by uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 adopted_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE public.owned_equipment_allocations (
 tool_id uuid NOT NULL REFERENCES public.managed_owned_equipment(tool_id) ON DELETE RESTRICT,
 project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE RESTRICT,
 quantity integer NOT NULL CHECK(quantity>0),
 PRIMARY KEY(tool_id,project_id)
);
CREATE TABLE public.owned_equipment_events (
 id uuid PRIMARY KEY,
 actor_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 tool_id uuid NOT NULL REFERENCES public.managed_owned_equipment(tool_id) ON DELETE RESTRICT,
 action text NOT NULL CHECK(action IN ('adopt','adopt_site','allocate')),
 project_id uuid REFERENCES public.projects(id) ON DELETE RESTRICT,
 quantity integer,
 expected_stock integer NOT NULL,
 expected_site integer,
 result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((action='adopt' AND project_id IS NULL AND quantity IS NULL AND expected_site IS NULL) OR (action='adopt_site' AND project_id IS NOT NULL AND quantity IS NOT NULL AND quantity>0 AND quantity=expected_stock AND expected_site IS NULL) OR (action='allocate' AND project_id IS NOT NULL AND quantity IS NOT NULL AND quantity>=0 AND expected_site IS NOT NULL AND expected_site>=0))
);
ALTER TABLE public.managed_owned_equipment ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.owned_equipment_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.owned_equipment_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.managed_owned_equipment,public.owned_equipment_allocations,public.owned_equipment_events FROM PUBLIC,anon,authenticated,service_role;

-- Old clients may still edit total stock. Row locking in UPDATE serializes them
-- with allocations; they cannot reduce it below allocated stock or assign a
-- single legacy project once the item is managed. FK prevents deletion.
CREATE FUNCTION public.guard_managed_equipment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_allocated bigint;
BEGIN
 IF EXISTS(SELECT 1 FROM public.managed_owned_equipment WHERE tool_id=OLD.id) THEN
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Managed equipment updates require read committed isolation' USING ERRCODE='P1002'; END IF;
  SELECT coalesce(sum(quantity),0) INTO v_allocated FROM public.owned_equipment_allocations WHERE tool_id=OLD.id;
  IF NEW.project_id IS NOT NULL THEN RAISE EXCEPTION 'Managed equipment uses project allocations, not the legacy single-site field' USING ERRCODE='23514'; END IF;
  IF NEW.quantity IS NULL OR NEW.quantity<v_allocated THEN RAISE EXCEPTION 'Stock cannot be lower than allocated equipment' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_managed_equipment() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER guard_managed_equipment BEFORE UPDATE OF quantity,project_id ON public.tools FOR EACH ROW EXECUTE FUNCTION public.guard_managed_equipment();

-- Callers choose an idempotency ID. Each change compares the stock and target
-- allocation seen by the Founder. The tool row serializes old/new writers.
CREATE FUNCTION public.change_owned_equipment(p_id uuid,p_tool uuid,p_action text,p_project uuid,p_quantity integer,p_expected_stock integer,p_expected_site integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_prev public.owned_equipment_events%ROWTYPE; v_tool public.tools%ROWTYPE; v_site integer; v_allocated bigint; v_result jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access required' USING ERRCODE='42501'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Equipment changes require read committed isolation' USING ERRCODE='P1002'; END IF;
 IF p_id IS NULL OR p_tool IS NULL OR p_action IS NULL OR p_expected_stock IS NULL OR p_expected_stock<0 OR
  NOT ((p_action='adopt' AND p_project IS NULL AND p_quantity IS NULL AND p_expected_site IS NULL) OR (p_action='adopt_site' AND p_project IS NOT NULL AND p_quantity IS NOT NULL AND p_quantity>0 AND p_quantity=p_expected_stock AND p_expected_site IS NULL) OR (p_action='allocate' AND p_project IS NOT NULL AND p_quantity IS NOT NULL AND p_quantity>=0 AND p_expected_site IS NOT NULL AND p_expected_site>=0)) THEN RAISE EXCEPTION 'Invalid equipment operation' USING ERRCODE='22023'; END IF;
 PERFORM 1 FROM public.users WHERE id=auth.uid() AND role='founder' FOR SHARE;
 IF NOT FOUND OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access required' USING ERRCODE='42501'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('equipment-operation:'||p_id::text,0));
 SELECT * INTO v_prev FROM public.owned_equipment_events WHERE id=p_id;
 IF FOUND THEN
  IF (v_prev.actor_id,v_prev.tool_id,v_prev.action,v_prev.project_id,v_prev.quantity,v_prev.expected_stock,v_prev.expected_site) IS DISTINCT FROM (auth.uid(),p_tool,p_action,p_project,p_quantity,p_expected_stock,p_expected_site) THEN RAISE EXCEPTION 'Operation ID already used for a different request' USING ERRCODE='22023'; END IF;
  RETURN v_prev.result||jsonb_build_object('replayed',true);
 END IF;
 SELECT * INTO v_tool FROM public.tools WHERE id=p_tool FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Equipment unavailable' USING ERRCODE='P0002'; END IF;
 IF v_tool.quantity IS DISTINCT FROM p_expected_stock THEN RAISE EXCEPTION 'Stock changed; refresh inventory' USING ERRCODE='40001'; END IF;
 IF p_action='adopt' THEN
  IF v_tool.project_id IS NOT NULL THEN RAISE EXCEPTION 'Legacy site-assigned equipment requires separate reconciliation' USING ERRCODE='22023'; END IF;
  IF EXISTS(SELECT 1 FROM public.managed_owned_equipment WHERE tool_id=p_tool) THEN RAISE EXCEPTION 'Equipment already managed; refresh' USING ERRCODE='40001'; END IF;
  -- Force a new row version so a legacy repeatable-read transaction whose
  -- snapshot predates adoption cannot update the tool using stale visibility.
  UPDATE public.tools SET quantity=quantity WHERE id=p_tool;
  INSERT INTO public.managed_owned_equipment(tool_id,adopted_by) VALUES(p_tool,auth.uid());
  v_site:=0;v_allocated:=0;
 ELSIF p_action='adopt_site' THEN
  IF EXISTS(SELECT 1 FROM public.managed_owned_equipment WHERE tool_id=p_tool) THEN RAISE EXCEPTION 'Equipment already managed; refresh' USING ERRCODE='40001'; END IF;
  IF v_tool.project_id IS DISTINCT FROM p_project THEN RAISE EXCEPTION 'Legacy site changed; refresh inventory' USING ERRCODE='40001'; END IF;
  PERFORM 1 FROM public.projects WHERE id=p_project FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Project unavailable' USING ERRCODE='P0002'; END IF;
  -- Update the parent first, while it is not yet managed. One transaction
  -- atomically replaces the old site pointer with an equal allocation.
  UPDATE public.tools SET project_id=NULL WHERE id=p_tool;
  INSERT INTO public.managed_owned_equipment(tool_id,adopted_by) VALUES(p_tool,auth.uid());
  IF p_quantity>0 THEN INSERT INTO public.owned_equipment_allocations(tool_id,project_id,quantity) VALUES(p_tool,p_project,p_quantity); END IF;
  v_site:=p_quantity;v_allocated:=p_quantity;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM public.managed_owned_equipment WHERE tool_id=p_tool) OR v_tool.project_id IS NOT NULL THEN RAISE EXCEPTION 'Equipment is not ready for allocations' USING ERRCODE='22023'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.projects WHERE id=p_project) THEN RAISE EXCEPTION 'Project unavailable' USING ERRCODE='P0002'; END IF;
  SELECT coalesce((SELECT quantity FROM public.owned_equipment_allocations WHERE tool_id=p_tool AND project_id=p_project),0) INTO v_site;
  IF v_site<>p_expected_site THEN RAISE EXCEPTION 'Site allocation changed; refresh inventory' USING ERRCODE='40001'; END IF;
  SELECT coalesce(sum(quantity),0) INTO v_allocated FROM public.owned_equipment_allocations WHERE tool_id=p_tool;
  IF v_allocated-v_site+p_quantity>v_tool.quantity THEN RAISE EXCEPTION 'Allocation exceeds owned stock' USING ERRCODE='23514'; END IF;
  -- As at adoption, a new parent-row version makes concurrent stale-snapshot
  -- legacy updates fail rather than seeing an obsolete allocation total.
  UPDATE public.tools SET quantity=quantity WHERE id=p_tool;
  IF p_quantity=0 THEN DELETE FROM public.owned_equipment_allocations WHERE tool_id=p_tool AND project_id=p_project;
  ELSE INSERT INTO public.owned_equipment_allocations(tool_id,project_id,quantity) VALUES(p_tool,p_project,p_quantity) ON CONFLICT(tool_id,project_id) DO UPDATE SET quantity=EXCLUDED.quantity; END IF;
  v_allocated:=v_allocated-v_site+p_quantity;v_site:=p_quantity;
 END IF;
 v_result:=jsonb_build_object('id',p_id,'tool_id',p_tool,'stock',v_tool.quantity,'allocated',v_allocated,'depot',v_tool.quantity-v_allocated,'site_quantity',v_site,'replayed',false);
 INSERT INTO public.owned_equipment_events(id,actor_id,tool_id,action,project_id,quantity,expected_stock,expected_site,result) VALUES(p_id,auth.uid(),p_tool,p_action,p_project,p_quantity,p_expected_stock,p_expected_site,v_result);
 RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.change_owned_equipment(uuid,uuid,text,uuid,integer,integer,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.change_owned_equipment(uuid,uuid,text,uuid,integer,integer,integer) TO authenticated;

CREATE FUNCTION public.owned_equipment_snapshot() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_items jsonb; v_projects jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access required' USING ERRCODE='42501'; END IF;
 IF (SELECT count(*) FROM public.tools)>2000 OR (SELECT count(*) FROM public.projects)>2000 OR (SELECT count(*) FROM public.owned_equipment_allocations)>10000 THEN RAISE EXCEPTION 'Equipment snapshot exceeds limit' USING ERRCODE='54000'; END IF;
 IF EXISTS(SELECT 1 FROM public.managed_owned_equipment m JOIN public.tools t ON t.id=m.tool_id WHERE t.project_id IS NOT NULL OR t.quantity<(SELECT coalesce(sum(a.quantity),0) FROM public.owned_equipment_allocations a WHERE a.tool_id=t.id)) THEN RAISE EXCEPTION 'Equipment stock requires reconciliation' USING ERRCODE='23514'; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',t.id,'name',t.name,'stock',t.quantity,'condition',t.condition,'legacy_project_id',t.project_id,'managed',m.tool_id IS NOT NULL,
 'sites',coalesce((SELECT jsonb_agg(jsonb_build_object('project_id',a.project_id,'name',p.name,'quantity',a.quantity) ORDER BY p.name,p.id) FROM public.owned_equipment_allocations a JOIN public.projects p ON p.id=a.project_id WHERE a.tool_id=t.id),'[]'::jsonb)) ORDER BY t.name,t.id),'[]'::jsonb) INTO v_items
 FROM public.tools t LEFT JOIN public.managed_owned_equipment m ON m.tool_id=t.id;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name) ORDER BY name,id),'[]'::jsonb) INTO v_projects FROM public.projects;
 RETURN jsonb_build_object('items',v_items,'projects',v_projects);
END;
$$;
REVOKE ALL ON FUNCTION public.owned_equipment_snapshot() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.owned_equipment_snapshot() TO authenticated;

-- Lookup is restricted to the original actor. A missing event does not establish
-- that an in-flight request has failed; retrying the same ID remains safest.
CREATE FUNCTION public.owned_equipment_operation_status(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_event public.owned_equipment_events%ROWTYPE;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access required' USING ERRCODE='42501'; END IF;
 IF p_id IS NULL THEN RAISE EXCEPTION 'Operation ID required' USING ERRCODE='22023'; END IF;
 SELECT * INTO v_event FROM public.owned_equipment_events WHERE id=p_id AND actor_id=auth.uid();
 IF NOT FOUND THEN RETURN jsonb_build_object('found',false); END IF;
 RETURN jsonb_build_object('found',true,'attempt',jsonb_build_object('id',v_event.id,'tool',v_event.tool_id,'action',v_event.action,'project',v_event.project_id,'quantity',v_event.quantity,'expectedStock',v_event.expected_stock,'expectedSite',v_event.expected_site),'result',v_event.result);
END;
$$;
REVOKE ALL ON FUNCTION public.owned_equipment_operation_status(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.owned_equipment_operation_status(uuid) TO authenticated;
-- Only the requested authorized site is visible. Legacy single-site records
-- and managed allocations are separate; neither proves current physical stock.
CREATE FUNCTION public.project_equipment_snapshot(p_project uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_items jsonb; v_total bigint;
BEGIN
 IF auth.uid() IS NULL OR p_project IS NULL OR NOT coalesce(public.session_assurance_satisfied(),false) OR NOT (
  coalesce(public.is_founder(),false) OR (EXISTS(SELECT 1 FROM public.users WHERE id=auth.uid() AND role='supervisor') AND coalesce(public.is_supervisor_assigned(p_project),false))
 ) THEN RAISE EXCEPTION 'Project equipment access required' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.projects WHERE id=p_project) THEN RAISE EXCEPTION 'Project unavailable' USING ERRCODE='P0002'; END IF;
 IF EXISTS(SELECT 1 FROM public.tools t JOIN public.managed_owned_equipment m ON m.tool_id=t.id WHERE t.project_id=p_project) THEN RAISE EXCEPTION 'Equipment location requires reconciliation' USING ERRCODE='23514'; END IF;
 SELECT count(*) INTO v_total FROM (
  SELECT t.id FROM public.tools t WHERE t.project_id=p_project AND NOT EXISTS(SELECT 1 FROM public.managed_owned_equipment m WHERE m.tool_id=t.id)
  UNION ALL SELECT a.tool_id FROM public.owned_equipment_allocations a WHERE a.project_id=p_project
 ) q;
 IF v_total>2000 THEN RAISE EXCEPTION 'Project equipment exceeds snapshot limit' USING ERRCODE='54000'; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',q.id,'name',q.name,'condition',q.condition,'quantity',q.quantity,'source',q.source) ORDER BY q.name,q.id),'[]'::jsonb) INTO v_items FROM (
  SELECT t.id,t.name,t.condition,t.quantity,'legacy'::text AS source FROM public.tools t WHERE t.project_id=p_project AND NOT EXISTS(SELECT 1 FROM public.managed_owned_equipment m WHERE m.tool_id=t.id)
  UNION ALL SELECT t.id,t.name,t.condition,a.quantity,'allocated'::text AS source FROM public.owned_equipment_allocations a JOIN public.tools t ON t.id=a.tool_id WHERE a.project_id=p_project
 ) q;
 RETURN jsonb_build_object('project_id',p_project,'items',v_items);
END;
$$;
REVOKE ALL ON FUNCTION public.project_equipment_snapshot(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.project_equipment_snapshot(uuid) TO authenticated;

-- RLS alone does not protect these tables from service roles with BYPASSRLS.
-- Reject inherited table/column or function grants as well as direct defaults.
-- An owner, superuser, role administrator or trigger-disabling maintenance
-- operation can still bypass these controls and needs separate review.
DO $postflight$
DECLARE n text; role_name text; target regclass;
BEGIN
 FOREACH n IN ARRAY ARRAY['public.managed_owned_equipment','public.owned_equipment_allocations','public.owned_equipment_events'] LOOP
  target:=pg_catalog.to_regclass(n);
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
   IF pg_catalog.has_table_privilege(role_name,target,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR EXISTS(
    SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid=target AND a.attnum>0 AND NOT a.attisdropped
     AND pg_catalog.has_column_privilege(role_name,target,a.attname,'SELECT,INSERT,UPDATE,REFERENCES')) THEN
    RAISE EXCEPTION 'Unexpected inherited equipment table or column privileges'; END IF;
  END LOOP;
 END LOOP;
 FOREACH n IN ARRAY ARRAY['public.change_owned_equipment(uuid,uuid,text,uuid,integer,integer,integer)','public.owned_equipment_snapshot()','public.owned_equipment_operation_status(uuid)','public.project_equipment_snapshot(uuid)'] LOOP
  IF pg_catalog.has_function_privilege('anon',n,'EXECUTE') OR pg_catalog.has_function_privilege('service_role',n,'EXECUTE') OR NOT pg_catalog.has_function_privilege('authenticated',n,'EXECUTE') THEN RAISE EXCEPTION 'Unexpected inherited equipment function privileges'; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r(role_name)
  WHERE pg_catalog.has_function_privilege(r.role_name,'public.guard_managed_equipment()','EXECUTE')) THEN
  RAISE EXCEPTION 'Unexpected inherited equipment trigger privilege'; END IF;
END;
$postflight$;


-- Enable the staged time writer only after the rest of the chain and guards exist.
DO $before_time_activation$ BEGIN
 IF to_regprocedure('public.create_weekly_worker_draft(uuid,uuid,date)') IS NULL OR to_regprocedure('public.record_weekly_bale_release(uuid)') IS NULL OR to_regprocedure('public.run_weekly_bale_expiry_job()') IS NULL OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.payroll'::regclass AND tgname='require_weekly_worker_source_on_insert' AND tgenabled='O' AND NOT tgisinternal) OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.advances'::regclass AND tgname='require_weekly_bale_source_on_insert' AND tgenabled='O' AND NOT tgisinternal) THEN RAISE EXCEPTION 'Weekly cutover is incomplete'; END IF;
END $before_time_activation$;
GRANT EXECUTE ON FUNCTION public.record_attendance_time_detail(uuid,uuid,timestamptz,numeric,numeric,text) TO authenticated;
DO $final_checks$ BEGIN
 IF has_function_privilege('anon','public.record_attendance_time_detail(uuid,uuid,timestamptz,numeric,numeric,text)','EXECUTE') OR has_function_privilege('service_role','public.record_attendance_time_detail(uuid,uuid,timestamptz,numeric,numeric,text)','EXECUTE') OR NOT has_function_privilege('authenticated','public.record_attendance_time_detail(uuid,uuid,timestamptz,numeric,numeric,text)','EXECUTE') THEN RAISE EXCEPTION 'Unexpected time writer execute privilege'; END IF;
END $final_checks$;
