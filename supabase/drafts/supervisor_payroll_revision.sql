-- DRAFT: coordinated upgrade, not yet installed. One transaction only.
-- Revision-bound decisions prevent a stale confirmation approving/paying a
-- refreshed amount. Return/refresh never touches paid records, sends money,
-- adds project cost or carries differences into a later period. The older
-- decision RPC becomes internal; a matching UI is required before installation.
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
DO $preflight$
BEGIN
 IF to_regclass('public.supervisor_period_payroll') IS NULL OR to_regclass('public.supervisor_period_payroll_events') IS NULL OR
  to_regprocedure('public.transition_supervisor_period_payroll(uuid,uuid,text,date,boolean)') IS NULL OR
  to_regprocedure('public.supervisor_period_compute_locked(uuid,date,numeric)') IS NULL OR
  to_regprocedure('public.supervisor_period_payroll_review(uuid,date)') IS NULL THEN
  RAISE EXCEPTION 'Supervisor ledger prerequisites missing'; END IF;
 IF to_regclass('public.supervisor_payroll_revision_events') IS NOT NULL OR
  to_regprocedure('public.supervisor_payroll_revision_action(uuid,uuid,bigint,text,numeric,jsonb,text,date,boolean)') IS NOT NULL OR
  EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.supervisor_period_payroll'::regclass AND attname='revision' AND NOT attisdropped) THEN
  RAISE EXCEPTION 'Supervisor revision objects already exist'; END IF;
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r
   WHERE has_table_privilege(r,'public.supervisor_period_payroll','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
         has_table_privilege(r,'public.supervisor_period_payroll_events','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
         EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid IN ('public.supervisor_period_payroll'::regclass,'public.supervisor_period_payroll_events'::regclass) AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege(r,a.attrelid,a.attname,'SELECT,INSERT,UPDATE,REFERENCES'))) THEN
  RAISE EXCEPTION 'Unexpected Supervisor ledger privileges'; END IF;
END $preflight$;
LOCK TABLE public.users,public.workers,public.attendance,public.payroll,public.supervisor_daily_attendance,public.supervisor_leave_requests,public.supervisor_period_payroll,public.supervisor_period_payroll_events IN SHARE ROW EXCLUSIVE MODE;
ALTER TABLE public.supervisor_period_payroll ADD COLUMN revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0);
CREATE TABLE public.supervisor_payroll_revision_events (
 request_id uuid PRIMARY KEY,
 payroll_id uuid NOT NULL REFERENCES public.supervisor_period_payroll(id) ON DELETE RESTRICT,
 actor_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 action text NOT NULL CHECK(action IN ('refresh','return_to_draft','approved','recorded_paid')),
 expected_revision bigint NOT NULL CHECK(expected_revision>=0),
 arguments jsonb NOT NULL,
 before_row jsonb NOT NULL,
 after_row jsonb NOT NULL,
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.supervisor_payroll_revision_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.supervisor_payroll_revision_events FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.guard_supervisor_payroll_revision_events() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN RAISE EXCEPTION 'Supervisor revision events are immutable' USING ERRCODE='22023'; END $$;
REVOKE ALL ON FUNCTION public.guard_supervisor_payroll_revision_events() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER guard_supervisor_payroll_revision_events BEFORE UPDATE OR DELETE ON public.supervisor_payroll_revision_events FOR EACH ROW EXECUTE FUNCTION public.guard_supervisor_payroll_revision_events();
-- An old confirmation must never approve a newly refreshed row. Existing
-- callers lose direct access and must send the revision they actually reviewed.
REVOKE ALL ON FUNCTION public.transition_supervisor_period_payroll(uuid,uuid,text,date,boolean) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.supervisor_period_payroll_review_v2(p_supervisor uuid,p_start date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_row jsonb;v_revision bigint;
BEGIN
 v_row:=public.supervisor_period_payroll_review(p_supervisor,p_start);
 IF v_row IS NULL THEN RETURN NULL; END IF;
 SELECT revision INTO v_revision FROM public.supervisor_period_payroll WHERE id=(v_row->>'id')::uuid;
 IF v_revision IS NULL THEN RAISE EXCEPTION 'Supervisor ledger changed; reload' USING ERRCODE='40001'; END IF;
 RETURN v_row||jsonb_build_object('revision',v_revision::text);
END $$;
REVOKE ALL ON FUNCTION public.supervisor_period_payroll_review_v2(uuid,date) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.supervisor_period_payroll_review_v2(uuid,date) TO authenticated;

CREATE FUNCTION public.supervisor_payroll_revision_action(p_request uuid,p_id uuid,p_revision bigint,p_action text,p_rate numeric,p_expected jsonb,p_reason text,p_paid_on date,p_ack boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_row public.supervisor_period_payroll%ROWTYPE;v_before jsonb;v_prev public.supervisor_payroll_revision_events%ROWTYPE;v_args jsonb;v_calc jsonb;v_out jsonb;v_reason text;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Supervisor payroll requires read committed isolation' USING ERRCODE='P1002'; END IF;
 IF p_request IS NULL OR p_id IS NULL OR p_revision IS NULL OR p_revision<0 OR p_revision>=9223372036854775807 OR p_action IS NULL OR p_action NOT IN ('refresh','return_to_draft','approved','recorded_paid') OR p_ack IS DISTINCT FROM true THEN RAISE EXCEPTION 'Invalid revision action' USING ERRCODE='22023'; END IF;
 v_reason:=nullif(btrim(p_reason),'');
 IF p_action='refresh' THEN
  IF p_rate IS NULL OR p_rate='NaN'::numeric OR p_rate<=0 OR p_rate>=100000000 OR p_rate<>round(p_rate,2) OR p_expected IS NULL OR v_reason IS NULL OR length(v_reason)>500 OR p_paid_on IS NOT NULL THEN RAISE EXCEPTION 'Invalid refresh details' USING ERRCODE='22023'; END IF;
 ELSIF p_action='return_to_draft' THEN
  IF p_rate IS NOT NULL OR p_expected IS NOT NULL OR v_reason IS NULL OR length(v_reason)>500 OR p_paid_on IS NOT NULL THEN RAISE EXCEPTION 'Invalid return details' USING ERRCODE='22023'; END IF;
 ELSE
  IF p_rate IS NOT NULL OR p_expected IS NOT NULL OR p_reason IS NOT NULL OR (p_action='approved' AND p_paid_on IS NOT NULL) OR (p_action='recorded_paid' AND (p_paid_on IS NULL OR NOT isfinite(p_paid_on) OR p_paid_on<DATE '1900-01-01' OR p_paid_on>(clock_timestamp() AT TIME ZONE 'Asia/Manila')::date)) THEN RAISE EXCEPTION 'Invalid decision details' USING ERRCODE='22023'; END IF;
 END IF;
 v_args:=jsonb_build_object('rate',p_rate,'expected',p_expected,'reason',v_reason,'paid_on',p_paid_on);
 PERFORM pg_catalog.set_config('lock_timeout','3s',true);
 LOCK TABLE public.users,public.workers,public.attendance,public.payroll,public.supervisor_daily_attendance,public.supervisor_leave_requests,public.supervisor_period_payroll,public.supervisor_period_payroll_events,public.supervisor_payroll_revision_events IN SHARE ROW EXCLUSIVE MODE;
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 SELECT * INTO v_prev FROM public.supervisor_payroll_revision_events WHERE request_id=p_request;
 IF FOUND THEN
  IF (v_prev.payroll_id,v_prev.actor_id,v_prev.action,v_prev.expected_revision,v_prev.arguments) IS DISTINCT FROM (p_id,auth.uid(),p_action,p_revision,v_args) THEN RAISE EXCEPTION 'Request ID used for a different action' USING ERRCODE='22023'; END IF;
  RETURN jsonb_build_object('id',p_id,'request_id',p_request,'revision',(p_revision+1)::text,'replayed',true);
 END IF;
 IF EXISTS(SELECT 1 FROM public.supervisor_period_payroll_events WHERE request_id=p_request) THEN RAISE EXCEPTION 'Request ID already used' USING ERRCODE='22023'; END IF;
 SELECT * INTO v_row FROM public.supervisor_period_payroll WHERE id=p_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Supervisor payroll not found' USING ERRCODE='P0002'; END IF;
 IF v_row.revision<>p_revision THEN RAISE EXCEPTION 'Supervisor payroll revision changed; reload and review' USING ERRCODE='40001'; END IF;
 v_before:=to_jsonb(v_row);
 IF p_action='refresh' THEN
  IF v_row.status<>'draft' THEN RAISE EXCEPTION 'Only a draft can be refreshed' USING ERRCODE='22023'; END IF;
  v_calc:=public.supervisor_period_compute_locked(v_row.supervisor_id,v_row.period_start,p_rate);
  IF (v_calc->'sources'||jsonb_build_object('input',v_calc->'input')) IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'Supervisor identity or source snapshot changed; reload' USING ERRCODE='40001'; END IF;
  UPDATE public.supervisor_period_payroll SET supervisor_name=v_calc->'sources'->'person'->>'name',daily_rate=p_rate,half_day_units=(v_calc->>'half_day_units')::integer,gross=(v_calc->>'gross')::numeric,source_snapshot=v_calc->'sources',unmarked_dates=v_calc->'unmarked',revision=revision+1 WHERE id=p_id RETURNING * INTO v_row;
 ELSIF p_action='return_to_draft' THEN
  IF v_row.status<>'approved' THEN RAISE EXCEPTION 'Only an approved unpaid record can return to draft' USING ERRCODE='22023'; END IF;
  UPDATE public.supervisor_period_payroll SET status='draft',approved_by=NULL,approved_at=NULL,revision=revision+1 WHERE id=p_id RETURNING * INTO v_row;
 ELSE
  -- The old implementation retains the source recheck and immutable events.
  -- It is callable only here by the trusted function owner, not by API roles.
  v_out:=public.transition_supervisor_period_payroll(p_request,p_id,p_action,p_paid_on,true);
  IF v_out->>'replayed' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'Unexpected old decision replay' USING ERRCODE='22023'; END IF;
  UPDATE public.supervisor_period_payroll SET revision=revision+1 WHERE id=p_id RETURNING * INTO v_row;
 END IF;
 INSERT INTO public.supervisor_payroll_revision_events(request_id,payroll_id,actor_id,action,expected_revision,arguments,before_row,after_row) VALUES(p_request,p_id,auth.uid(),p_action,p_revision,v_args,v_before,to_jsonb(v_row));
 RETURN jsonb_build_object('id',p_id,'request_id',p_request,'revision',v_row.revision::text,'replayed',false);
END $$;
REVOKE ALL ON FUNCTION public.supervisor_payroll_revision_action(uuid,uuid,bigint,text,numeric,jsonb,text,date,boolean) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.supervisor_payroll_revision_action(uuid,uuid,bigint,text,numeric,jsonb,text,date,boolean) TO authenticated;
DO $$
DECLARE r text;f text;
BEGIN
 FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF has_table_privilege(r,'public.supervisor_payroll_revision_events','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid='public.supervisor_payroll_revision_events'::regclass AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege(r,a.attrelid,a.attname,'SELECT,INSERT,UPDATE,REFERENCES')) THEN RAISE EXCEPTION 'Revision evidence exposed'; END IF;
  IF has_function_privilege(r,'public.transition_supervisor_period_payroll(uuid,uuid,text,date,boolean)','EXECUTE') OR has_function_privilege(r,'public.guard_supervisor_payroll_revision_events()','EXECUTE') THEN RAISE EXCEPTION 'Internal Supervisor writer exposed'; END IF;
 END LOOP;
 FOREACH f IN ARRAY ARRAY['public.supervisor_period_payroll_review_v2(uuid,date)','public.supervisor_payroll_revision_action(uuid,uuid,bigint,text,numeric,jsonb,text,date,boolean)'] LOOP
  IF has_function_privilege('anon',f,'EXECUTE') OR has_function_privilege('service_role',f,'EXECUTE') OR NOT has_function_privilege('authenticated',f,'EXECUTE') THEN RAISE EXCEPTION 'Unexpected Supervisor revision RPC privileges'; END IF;
 END LOOP;
END $$;
