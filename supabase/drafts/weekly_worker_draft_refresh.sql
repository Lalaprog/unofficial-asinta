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
