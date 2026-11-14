-- Targeted DEVELOPMENT cutover hardening. Remove direct service_role writes
-- to two paid-evidence tables, preserving SELECT and the assured-Founder
-- SECURITY DEFINER payment workflow. No rows, RLS or function grants change.
-- Independently verify project, matching function bodies and compatible clients;
-- run the complete synthetic payment test and hosted rollback rehearsal first.
-- Owners, indirect functions, DDL and service access to other tables remain
-- outside this change. Emergency maintenance requires a reviewed procedure.
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='20s';
LOCK TABLE public.payroll_payment_dates,public.weekly_worker_paid_allocations IN SHARE ROW EXCLUSIVE MODE;
DO $preflight$
DECLARE t text; p text; r record;
BEGIN
 FOREACH t IN ARRAY ARRAY['public.payroll_payment_dates','public.weekly_worker_paid_allocations'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid=to_regclass(t) AND relkind='r' AND relrowsecurity AND pg_get_userbyid(relowner)='postgres') THEN RAISE EXCEPTION 'Paid evidence table identity changed: %',t; END IF;
  IF NOT has_table_privilege('service_role',t,'SELECT') OR has_table_privilege('service_role',t,'TRUNCATE') THEN RAISE EXCEPTION 'Paid evidence service privileges changed: %',t; END IF;
  FOREACH p IN ARRAY ARRAY['INSERT','UPDATE','DELETE'] LOOP
   IF NOT has_table_privilege('service_role',t,p) OR has_table_privilege('anon',t,p) OR has_table_privilege('authenticated',t,p) THEN RAISE EXCEPTION 'Paid evidence writer privileges changed: % %',t,p; END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass(t) AND attnum>0 AND NOT attisdropped AND attacl IS NOT NULL) THEN RAISE EXCEPTION 'Paid evidence column ACLs changed: %',t; END IF;
 END LOOP;
 FOR r IN SELECT * FROM (VALUES
  ('public.record_weekly_worker_payment(uuid,date,bigint)',true),
  ('public.weekly_worker_payment_internal(uuid,date)',false),
  ('public.weekly_payment_date_internal(uuid,date)',false)
 ) AS f(signature,auth_exec) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure(r.signature) AND prosecdef AND pg_get_userbyid(proowner)='postgres' AND proconfig @> ARRAY['search_path=""']) OR has_function_privilege('authenticated',r.signature,'EXECUTE') IS DISTINCT FROM r.auth_exec OR has_function_privilege('service_role',r.signature,'EXECUTE') THEN RAISE EXCEPTION 'Payment writer changed: %',r.signature; END IF;
 END LOOP;
END $preflight$;
REVOKE INSERT,UPDATE,DELETE ON TABLE public.payroll_payment_dates,public.weekly_worker_paid_allocations FROM service_role;
DO $postflight$
DECLARE t text; p text;
BEGIN
 FOREACH t IN ARRAY ARRAY['public.payroll_payment_dates','public.weekly_worker_paid_allocations'] LOOP
  IF NOT has_table_privilege('service_role',t,'SELECT') THEN RAISE EXCEPTION 'Paid evidence SELECT changed: %',t; END IF;
  FOREACH p IN ARRAY ARRAY['INSERT','UPDATE','DELETE','TRUNCATE'] LOOP
   IF has_table_privilege('service_role',t,p) OR has_table_privilege('anon',t,p) OR has_table_privilege('authenticated',t,p) THEN RAISE EXCEPTION 'Paid evidence direct writer remains: % %',t,p; END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass(t) AND a.attnum>0 AND NOT a.attisdropped AND (has_column_privilege('service_role',a.attrelid,a.attname,'INSERT') OR has_column_privilege('service_role',a.attrelid,a.attname,'UPDATE'))) THEN RAISE EXCEPTION 'Paid evidence column writer remains: %',t; END IF;
 END LOOP;
END $postflight$;
