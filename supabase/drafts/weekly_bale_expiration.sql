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
   RAISE EXCEPTION 'Use the controlled Wednesday external-release action' USING ERRCODE='22023'; END IF;
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
