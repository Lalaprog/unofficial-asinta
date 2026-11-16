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
