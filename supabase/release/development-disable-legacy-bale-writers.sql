-- Target-specific follow-up to development finance cutover 20261114002332.
-- Requires ONE caller-managed transaction. Never replay blindly on another DB.
-- The weekly UI still uses the old review/approval functions, so leave those
-- unchanged. Disable only obsolete release and manual-deduction API calls.
-- This does not remove owner privileges or prove that every legacy writer is
-- blocked. Existing financial records are never modified by this migration.
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
LOCK TABLE public.advances, public.advance_requests, public.payroll IN SHARE ROW EXCLUSIVE MODE;
DO $preflight$
DECLARE item record;
BEGIN
 FOR item IN SELECT * FROM (VALUES
  ('public.issue_advance_request(uuid)','e13682f4109effd605b0e6f4345442cb'),
  ('public.record_advance_deduction_atomic(uuid,numeric)','48bf0e5af8ac1069b6a195c6450ef5f1'),
  ('public.record_weekly_bale_release(uuid)','cef0a73eba1cab46cba3406a339c9e94'),
  ('public.record_weekly_worker_payment(uuid,date,bigint)','24f9a6cceda75d6b8c978ff738b8a655')
 ) expected(signature,fingerprint) LOOP
  IF to_regprocedure(item.signature) IS NULL OR
   (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p WHERE p.oid=to_regprocedure(item.signature)) IS DISTINCT FROM item.fingerprint THEN
   RAISE EXCEPTION 'Function missing or changed: %',item.signature; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM public.advances) OR EXISTS(SELECT 1 FROM public.advance_requests) OR EXISTS(SELECT 1 FROM public.payroll) THEN
  RAISE EXCEPTION 'Development finance is not empty; reconcile before disabling legacy writers'; END IF;
 FOR item IN SELECT * FROM (VALUES
  ('public.advance_requests','guard_weekly_bale_transition','public.guard_weekly_bale_transition()'),
  ('public.advances','guard_weekly_bale_balance_cutover','public.guard_weekly_bale_balance_cutover()'),
  ('public.advances','require_weekly_bale_source_on_insert','public.require_weekly_bale_source_on_insert()'),
  ('public.payroll','guard_weekly_worker_draft','public.guard_weekly_worker_draft()'),
  ('public.payroll','require_weekly_worker_source_on_insert','public.require_weekly_worker_source_on_insert()')
 ) required(relation_name,trigger_name,function_name) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=to_regclass(item.relation_name)
    AND t.tgname=item.trigger_name AND t.tgenabled='O' AND NOT t.tgisinternal
    AND t.tgfoid=to_regprocedure(item.function_name)) THEN
   RAISE EXCEPTION 'Required cutover guard missing or disabled: %',item.trigger_name; END IF;
 END LOOP;
 IF NOT has_function_privilege('authenticated','public.record_weekly_bale_release(uuid)','EXECUTE') OR
    NOT has_function_privilege('authenticated','public.record_weekly_worker_payment(uuid,date,bigint)','EXECUTE') OR
    has_function_privilege('anon','public.record_weekly_bale_release(uuid)','EXECUTE') OR
    has_function_privilege('service_role','public.record_weekly_bale_release(uuid)','EXECUTE') OR
    has_function_privilege('anon','public.record_weekly_worker_payment(uuid,date,bigint)','EXECUTE') OR
    has_function_privilege('service_role','public.record_weekly_worker_payment(uuid,date,bigint)','EXECUTE') THEN
  RAISE EXCEPTION 'Replacement privileges differ from the reviewed development state'; END IF;
END $preflight$;
REVOKE ALL ON FUNCTION public.issue_advance_request(uuid), public.record_advance_deduction_atomic(uuid,numeric) FROM PUBLIC,anon,authenticated,service_role;
DO $verify$
DECLARE role_name text; signature text;
BEGIN
 FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  FOREACH signature IN ARRAY ARRAY['public.issue_advance_request(uuid)','public.record_advance_deduction_atomic(uuid,numeric)'] LOOP
   IF has_function_privilege(role_name,signature,'EXECUTE') THEN
    RAISE EXCEPTION 'Inherited legacy writer privilege remains: % / %',role_name,signature; END IF;
  END LOOP;
 END LOOP;
END $verify$;
