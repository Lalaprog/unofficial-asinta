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
