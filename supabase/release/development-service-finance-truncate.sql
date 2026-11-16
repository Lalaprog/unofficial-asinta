-- Narrow development hardening: deny service_role table-wide TRUNCATE on
-- three observed finance evidence tables. Does not change data, RLS, ordinary
-- DML, function execute privileges, owners or other roles. Service-role DML,
-- definer functions and owners can still mutate records. Not a complete audit.
-- Verify the project independently; execute only in one managed transaction
-- after rehearsal. Maintenance that legitimately truncates these tables must
-- use a separately reviewed owner-operated procedure.
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='20s';
LOCK TABLE public.expenses,public.payroll_payment_dates,public.weekly_worker_paid_allocations IN SHARE ROW EXCLUSIVE MODE;
DO $preflight$
DECLARE t text; p text;
BEGIN
 FOREACH t IN ARRAY ARRAY['public.expenses','public.payroll_payment_dates','public.weekly_worker_paid_allocations'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid=to_regclass(t) AND relkind='r' AND relrowsecurity AND pg_get_userbyid(relowner)='postgres') THEN RAISE EXCEPTION 'Finance table identity, owner or RLS changed: %',t; END IF;
  IF NOT has_table_privilege('service_role',t,'TRUNCATE') OR has_table_privilege('anon',t,'TRUNCATE') OR has_table_privilege('authenticated',t,'TRUNCATE') THEN RAISE EXCEPTION 'Finance TRUNCATE privileges changed: %',t; END IF;
  FOREACH p IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE'] LOOP
   IF NOT has_table_privilege('service_role',t,p) THEN RAISE EXCEPTION 'Finance service DML privileges changed: % %',t,p; END IF;
  END LOOP;
 END LOOP;
END $preflight$;
REVOKE TRUNCATE ON TABLE public.expenses,public.payroll_payment_dates,public.weekly_worker_paid_allocations FROM service_role;
DO $postflight$
DECLARE t text; p text;
BEGIN
 FOREACH t IN ARRAY ARRAY['public.expenses','public.payroll_payment_dates','public.weekly_worker_paid_allocations'] LOOP
  IF has_table_privilege('service_role',t,'TRUNCATE') OR has_table_privilege('anon',t,'TRUNCATE') OR has_table_privilege('authenticated',t,'TRUNCATE') THEN RAISE EXCEPTION 'Finance TRUNCATE still effective: %',t; END IF;
  FOREACH p IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE'] LOOP
   IF NOT has_table_privilege('service_role',t,p) THEN RAISE EXCEPTION 'Finance service DML unexpectedly changed: % %',t,p; END IF;
  END LOOP;
 END LOOP;
END $postflight$;
