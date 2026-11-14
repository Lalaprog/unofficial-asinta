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
