-- HELD CANDIDATE: do not deploy alone. It adds an authenticated RPC without
-- removing the old table INSERT path. A compatible client must retain the same
-- request UUID and exact details for retries. Old clients, different UUIDs,
-- lost client storage and owner/privileged writes can still create duplicates.
-- This RPC records a request only; it neither releases nor transfers money.
-- Caller must wrap this draft in a transaction. Validate the target catalog,
-- trigger bodies, RLS, role inheritance, rollout and recovery first.
DO $hold$ BEGIN
 IF current_setting('app.weekly_bale_idempotent_submission_reviewed',true) IS DISTINCT FROM 'yes' THEN
  RAISE EXCEPTION 'Idempotent Bale submission held pending review';
 END IF;
END $hold$;
DO $preflight$
DECLARE n text;
BEGIN
 IF to_regprocedure('public.submit_weekly_bale_request(uuid,uuid,uuid,numeric,date)') IS NOT NULL OR
    to_regclass('public.advance_requests') IS NULL OR to_regclass('public.weekly_bale_requests') IS NULL THEN
  RAISE EXCEPTION 'Bale submission dependencies missing or already installed'; END IF;
 FOREACH n IN ARRAY ARRAY['guard_advance_request_site','guard_weekly_bale_submission','register_weekly_bale_submission','audit_advance_request_change','notify_advance_request_event'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid='public.advance_requests'::regclass AND t.tgname=n AND NOT t.tgisinternal AND t.tgenabled IN ('O','A')) THEN
   RAISE EXCEPTION 'Required request trigger is missing or disabled: %',n; END IF;
 END LOOP;
END $preflight$;

CREATE FUNCTION public.submit_weekly_bale_request(p_request uuid,p_worker uuid,p_project uuid,p_amount numeric,p_period_start date)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid:=auth.uid();v_row public.advance_requests%ROWTYPE;v_replayed boolean:=false;
BEGIN
 IF v_actor IS NULL OR NOT coalesce(public.session_assurance_satisfied(),false) OR NOT coalesce(public.current_user_role()='supervisor',false) THEN
  RAISE EXCEPTION 'Supervisor access required' USING ERRCODE='42501'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Bale request requires read committed isolation' USING ERRCODE='P1002'; END IF;
 IF p_request IS NULL OR p_worker IS NULL OR p_project IS NULL OR p_period_start IS NULL OR extract(dow FROM p_period_start)<>0 OR p_amount IS NULL OR p_amount='NaN'::numeric OR p_amount<=0 OR p_amount>=100000000 OR p_amount<>round(p_amount,2) THEN
  RAISE EXCEPTION 'Invalid Bale request' USING ERRCODE='22023'; END IF;
 -- Keep actor role stable while waiting for concurrent exact retries. A later
 -- retry can read its own original request even after the site/window changes.
 PERFORM 1 FROM public.users WHERE id=v_actor AND role='supervisor' FOR SHARE;
 IF NOT FOUND OR NOT coalesce(public.session_assurance_satisfied(),false) OR NOT coalesce(public.current_user_role()='supervisor',false) THEN
  RAISE EXCEPTION 'Supervisor access required' USING ERRCODE='42501'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('weekly-bale-submit-request:'||p_request::text,0));
 SELECT * INTO v_row FROM public.advance_requests WHERE id=p_request FOR SHARE;
 IF FOUND THEN
  IF v_row.submitted_by IS DISTINCT FROM v_actor OR v_row.worker_id IS DISTINCT FROM p_worker OR v_row.project_id IS DISTINCT FROM p_project OR v_row.requested_amount IS DISTINCT FROM p_amount OR
   NOT EXISTS(SELECT 1 FROM public.weekly_bale_requests WHERE request_id=p_request AND period_start=p_period_start) THEN
   RAISE EXCEPTION 'Request unavailable or details differ; investigate before submitting again' USING ERRCODE='22023'; END IF;
  v_replayed:=true;
 ELSE
  -- Existing BEFORE triggers check Supervisor/site/worker and server clock;
  -- AFTER triggers record the weekly marker, audit and in-app notification.
  -- They all run in this same transaction. No independent external send.
  INSERT INTO public.advance_requests(id,worker_id,project_id,requested_amount,submitted_by)
   VALUES(p_request,p_worker,p_project,p_amount,v_actor) RETURNING * INTO v_row;
  IF NOT EXISTS(SELECT 1 FROM public.weekly_bale_requests WHERE request_id=p_request AND period_start=p_period_start) THEN
   RAISE EXCEPTION 'Request week changed or weekly submission marker missing' USING ERRCODE='22023'; END IF;
 END IF;
 RETURN jsonb_build_object('replayed',v_replayed,'request',to_jsonb(v_row));
END $$;
REVOKE ALL ON FUNCTION public.submit_weekly_bale_request(uuid,uuid,uuid,numeric,date) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.submit_weekly_bale_request(uuid,uuid,uuid,numeric,date) TO authenticated;
DO $postflight$ BEGIN
 IF has_function_privilege('anon','public.submit_weekly_bale_request(uuid,uuid,uuid,numeric,date)','EXECUTE') OR
    has_function_privilege('service_role','public.submit_weekly_bale_request(uuid,uuid,uuid,numeric,date)','EXECUTE') OR
    NOT has_function_privilege('authenticated','public.submit_weekly_bale_request(uuid,uuid,uuid,numeric,date)','EXECUTE') THEN
  RAISE EXCEPTION 'Unexpected idempotent Bale submission privilege'; END IF;
END $postflight$;
