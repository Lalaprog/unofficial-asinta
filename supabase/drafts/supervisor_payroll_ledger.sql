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
 -- Cross-ledger historical identity/lock coordination is not implemented yet.
 -- Never silently permit both sources to claim an overlapping external payment.
 IF to_regclass('public.historical_external_worker_payroll') IS NOT NULL THEN RAISE EXCEPTION 'Historical external worker evidence requires coordinated cross-ledger reconciliation'; END IF;
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

-- Called only while the invoking writer holds all source locks. Capture identity
-- and all relevant pending/approved day/leave records, not project assignments.
CREATE FUNCTION public.supervisor_period_compute_locked(p_supervisor uuid,p_start date,p_rate numeric) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_input jsonb; v_sources jsonb; v_day jsonb; v_date date; v_today date; v_approved integer; v_units integer:=0; v_known integer:=0; v_unmarked jsonb:='[]'::jsonb; v_gross numeric; v_person jsonb; v_worker jsonb;
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
 v_sources:=jsonb_build_object('person',v_person,'linked_worker',v_worker,'input',v_input-'as_of');
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
 RETURN jsonb_build_object('person',v_person,'linked_worker',v_worker,'input',v_input);
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
 v_current:=jsonb_build_object('person',v_person,'linked_worker',v_worker,'input',v_input-'as_of');
 RETURN jsonb_build_object('id',v_row.id,'supervisor_id',v_row.supervisor_id,'supervisor_name',v_row.supervisor_name,'period_start',v_row.period_start,'period_end',v_row.period_end,'daily_rate',v_row.daily_rate::text,'half_day_units',v_row.half_day_units,'gross',v_row.gross::text,'status',v_row.status,'unmarked_dates',v_row.unmarked_dates,'paid_on',v_row.paid_on,'created_by',v_row.created_by,'created_at',v_row.created_at,'approved_by',v_row.approved_by,'approved_at',v_row.approved_at,'paid_by',v_row.paid_by,'recorded_paid_at',v_row.recorded_paid_at,'source_changed',v_current IS DISTINCT FROM v_row.source_snapshot,'as_of',v_input->'as_of');
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
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r CROSS JOIN unnest(ARRAY['public.supervisor_leave_list_before_ledger(integer)','public.supervisor_day_list_before_ledger(integer)','public.supervisor_period_compute_locked(uuid,date,numeric)','public.guard_legacy_supervisor_period_overlap()','public.guard_supervisor_payroll_events_immutable()']) f WHERE has_function_privilege(r,f,'EXECUTE')) THEN RAISE EXCEPTION 'Unexpected internal Supervisor ledger privilege'; END IF;
 FOREACH v IN ARRAY ARRAY['public.supervisor_leave_list(integer)','public.supervisor_day_list(integer)','public.supervisor_paid_company_evidence(date,date)','public.supervisor_period_prepare(uuid,date)','public.create_supervisor_period_draft(uuid,uuid,date,numeric,jsonb)','public.transition_supervisor_period_payroll(uuid,uuid,text,date,boolean)','public.supervisor_period_payroll_review(uuid,date)'] LOOP
  IF has_function_privilege('anon',v,'EXECUTE') OR has_function_privilege('service_role',v,'EXECUTE') OR NOT has_function_privilege('authenticated',v,'EXECUTE') THEN RAISE EXCEPTION 'Unexpected Supervisor ledger RPC privilege'; END IF;
 END LOOP;
END;
$postflight$;
