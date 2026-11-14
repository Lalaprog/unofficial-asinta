-- Targeted DEVELOPMENT hardening for the observed private Founder-only
-- expenses table. No financial rows, policies, functions, authenticated or
-- service-role grants are changed. Run as one managed transaction only, on
-- the independently verified development project, after rollback rehearsal.
-- Anonymous RLS had no permissive policy, but table grants still allowed
-- maintenance/reference/trigger capabilities beyond normal RLS filtering.
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='20s';
LOCK TABLE public.expenses IN SHARE ROW EXCLUSIVE MODE;
DO $expenses_preflight$
DECLARE p text;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid='public.expenses'::regclass AND relkind='r' AND relrowsecurity AND pg_get_userbyid(relowner)='postgres') THEN RAISE EXCEPTION 'Expense table identity or RLS changed'; END IF;
 IF pg_has_role('anon','authenticated','USAGE') OR pg_has_role('authenticated','anon','USAGE') THEN RAISE EXCEPTION 'Anonymous role inheritance changed'; END IF;
 IF (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='expenses')<>2 OR NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='expenses' AND policyname='Founders full access to expenses' AND permissive='PERMISSIVE' AND roles=ARRAY['authenticated']::name[] AND cmd='ALL' AND qual='is_founder()' AND with_check IS NULL) OR NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='expenses' AND policyname='mfa_session_required' AND permissive='RESTRICTIVE' AND roles=ARRAY['authenticated']::name[] AND cmd='ALL' AND qual='( SELECT session_assurance_satisfied() AS session_assurance_satisfied)' AND with_check='( SELECT session_assurance_satisfied() AS session_assurance_satisfied)') THEN RAISE EXCEPTION 'Expense RLS policies changed'; END IF;
 IF EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.expenses'::regclass AND attnum>0 AND NOT attisdropped AND attacl IS NOT NULL) OR EXISTS(SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid='public.expenses'::regclass AND a.grantee=0) THEN RAISE EXCEPTION 'Unexpected column or PUBLIC expense grants'; END IF;
 FOREACH p IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE','REFERENCES','TRIGGER','MAINTAIN'] LOOP
  IF NOT has_table_privilege('anon','public.expenses',p) THEN RAISE EXCEPTION 'Anonymous expense grants changed: %',p; END IF;
 END LOOP;
 IF has_table_privilege('anon','public.expenses','TRUNCATE') THEN RAISE EXCEPTION 'Anonymous TRUNCATE unexpectedly enabled'; END IF;
 FOREACH p IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE'] LOOP
  IF NOT has_table_privilege('authenticated','public.expenses',p) OR NOT has_table_privilege('service_role','public.expenses',p) THEN RAISE EXCEPTION 'Authenticated or service expense grants changed: %',p; END IF;
 END LOOP;
END $expenses_preflight$;
REVOKE ALL PRIVILEGES ON TABLE public.expenses FROM anon;
DO $expenses_postflight$
DECLARE p text;
BEGIN
 FOREACH p IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'] LOOP
  IF has_table_privilege('anon','public.expenses',p) THEN RAISE EXCEPTION 'Anonymous expense privilege still effective: %',p; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid='public.expenses'::regclass AND a.attnum>0 AND NOT a.attisdropped AND (has_column_privilege('anon',a.attrelid,a.attname,'SELECT') OR has_column_privilege('anon',a.attrelid,a.attname,'INSERT') OR has_column_privilege('anon',a.attrelid,a.attname,'UPDATE') OR has_column_privilege('anon',a.attrelid,a.attname,'REFERENCES'))) THEN RAISE EXCEPTION 'Anonymous expense column privilege still effective'; END IF;
 FOREACH p IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE'] LOOP
  IF NOT has_table_privilege('authenticated','public.expenses',p) OR NOT has_table_privilege('service_role','public.expenses',p) THEN RAISE EXCEPTION 'Authenticated or service expense grants changed: %',p; END IF;
 END LOOP;
END $expenses_postflight$;
