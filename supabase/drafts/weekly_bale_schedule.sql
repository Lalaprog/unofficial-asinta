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
