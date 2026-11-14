-- DEVELOPMENT PREPARATION ONLY. Read-only, point-in-time catalog guard for
-- selected direct textual writers of the correction review's source tables.
-- This is NOT an exhaustive writer audit: dynamic SQL, quoted identifiers,
-- indirect calls, owner actions, triggers and DDL changes can evade this
-- search. The operator must independently verify the target and coordinate
-- a quiet migration; this does not lock function definitions against DDL.
DO $corrected_writer_audit$
DECLARE r record; v_oid oid; v_known oid[]:='{}'::oid[]; v_found integer;
BEGIN
 FOR r IN SELECT * FROM (VALUES
  ('public.confirm_rental_expense(uuid,uuid,uuid,numeric,date,text,text,text,integer,date,date)','fed9d8ec95c7a119fe4fe9ca59b3e91a62ddee3d5662143f1c8cc8d2ea504198',true),
  ('public.create_weekly_worker_draft(uuid,uuid,date)','303f3a42eceb0f16eb01063de08636ededaa9de169f3c830f7c7c29268924018',true),
  ('public.open_paid_payroll_adjustment(uuid,uuid,jsonb,numeric,text)','ff403a8ef943eb27208a00005ba51d493f5b01bb13171d10f15607977696cfb4',true),
  ('public.open_paid_period_assertion_case(uuid,text,uuid,jsonb,numeric,text)','c6d3c6c12c7c59bf020a0c3b7401f935b654f20ef2962c39bbe8f95570a38a5d',true),
  ('public.record_historical_worker_attribution(uuid,uuid,jsonb,jsonb,text,boolean)','ee533b4a2c620cf011bc3df71e3cff322c087b70bda9ab181d7330b77ca4792d',true),
  ('public.refresh_weekly_worker_draft(uuid,uuid,bigint)','cf6ed49a80b94bf27d7a2cf1a789cfc99cf17b3609185d2c33a89b71a684822c',true),
  ('public.resolve_paid_payroll_adjustment(uuid,text,date,text)','32c702ee23f4ad1b55fb06cca419fdc0494c3dd42a9cee4d023f4fab0ec25e37',true),
  ('public.resolve_paid_period_assertion_case(uuid,text,date,text,boolean)','11aa2505d96e023a116d33fd672ccb442bfd80b464f5c2803a410f92fe30869e',true),
  ('public.return_weekly_worker_to_draft(uuid,uuid,bigint,text)','8dfde320739baef335c2ba9b5a18b48e7233f1458d441d76caac920462cf5bfb',true),
  ('public.weekly_payment_date_internal(uuid,date)','7aff33302c8ce5b9dca2bd2a6ca67b27868a31cbfed04a50b23346886ea95ef0',false),
  ('public.weekly_worker_approval_internal(uuid)','34f2ce1bb4173312d76c74acb65cc72c28af1846088dec3e67c5ad7481ae5f93',false),
  ('public.weekly_worker_payment_internal(uuid,date)','a124cbfb4c8e3a8d035fe0cd90c4280899ab33be3795dd46c8a6d94080415f36',false)
 ) AS expected(signature,digest,authenticated_execute) LOOP
  v_oid:=to_regprocedure(r.signature);
  IF v_oid IS NULL OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=v_oid AND p.prokind='f' AND p.prosecdef AND pg_get_userbyid(p.proowner)='postgres') OR encode(sha256(convert_to(pg_get_functiondef(v_oid),'UTF8')),'hex') IS DISTINCT FROM r.digest OR has_function_privilege('anon',v_oid,'EXECUTE') OR has_function_privilege('service_role',v_oid,'EXECUTE') OR has_function_privilege('authenticated',v_oid,'EXECUTE') IS DISTINCT FROM r.authenticated_execute THEN
   RAISE EXCEPTION 'Selected development source writer changed: %',r.signature;
  END IF;
  v_known:=array_append(v_known,v_oid);
 END LOOP;
 SELECT count(*) INTO v_found FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname IN ('public','app_private') AND p.prokind='f'
  AND p.prosrc ~* '(insert\s+into|update|delete\s+from|truncate)\s+(public\.)?(expenses|confirmed_rental_expenses|weekly_worker_paid_allocations|weekly_worker_draft_sources|payroll_payment_dates|historical_worker_attributions|historical_worker_attribution_sites|paid_payroll_adjustment_cases|paid_period_assertion_cases)'
  AND NOT(p.oid=ANY(v_known));
 IF v_found<>0 THEN RAISE EXCEPTION 'Additional selected textual source writer found; review required'; END IF;
END $corrected_writer_audit$;
