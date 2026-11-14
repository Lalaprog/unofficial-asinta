-- DEVELOPMENT ONLY. Remove redundant anonymous grants from the observed
-- private payroll, Bale and attendance tables. No policies, data, functions,
-- authenticated or service-role privileges are intentionally changed.
-- Run in a managed transaction only after target and rollback checks.
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='20s';
LOCK TABLE public.advance_requests, public.advances, public.attendance, public.payroll IN SHARE ROW EXCLUSIVE MODE;
DO $hardening$
DECLARE t regclass; r record; p text; v_before jsonb; v_after jsonb; v_anon oid:=to_regrole('anon');
BEGIN
 IF v_anon IS NULL OR to_regrole('authenticated') IS NULL OR to_regrole('service_role') IS NULL OR pg_has_role('anon','authenticated','USAGE') OR pg_has_role('authenticated','anon','USAGE') OR pg_has_role('service_role','anon','USAGE') THEN RAISE EXCEPTION 'API role identity or inheritance changed'; END IF;
 FOREACH t IN ARRAY ARRAY['public.advance_requests'::regclass,'public.advances'::regclass,'public.attendance'::regclass,'public.payroll'::regclass] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=t AND c.relkind='r' AND c.relrowsecurity AND pg_get_userbyid(c.relowner)='postgres') THEN RAISE EXCEPTION 'Table identity or RLS changed: %',t; END IF;
  IF EXISTS(SELECT 1 FROM pg_policy q CROSS JOIN LATERAL unnest(q.polroles) role_id WHERE q.polrelid=t AND (role_id=0 OR pg_has_role(v_anon,role_id,'USAGE'))) THEN RAISE EXCEPTION 'Anonymous or PUBLIC policy present: %',t; END IF;
  IF EXISTS(SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid=t AND a.grantee=0) OR EXISTS(SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) x WHERE a.attrelid=t AND a.attnum>0 AND NOT a.attisdropped AND x.grantee IN (0,v_anon)) THEN RAISE EXCEPTION 'Unexpected PUBLIC or anonymous column grant: %',t; END IF;
  IF NOT has_table_privilege('anon',t,'SELECT') OR NOT has_table_privilege('authenticated',t,'SELECT') OR NOT has_table_privilege('service_role',t,'SELECT') THEN RAISE EXCEPTION 'Observed access changed: %',t; END IF;
 END LOOP;
 -- Preserve all other table and explicit column ACL entries, including the
 -- authenticated column-only payroll and request permissions.
 SELECT coalesce(jsonb_agg(rowdata ORDER BY rowdata::text),'[]'::jsonb) INTO v_before FROM (
  SELECT jsonb_build_array('table',c.oid::text,a.grantor,a.grantee,a.privilege_type,a.is_grantable) rowdata FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid=ANY(ARRAY['public.advance_requests'::regclass,'public.advances'::regclass,'public.attendance'::regclass,'public.payroll'::regclass]) AND a.grantee<>v_anon
  UNION ALL SELECT jsonb_build_array('column',a.attrelid::text,a.attnum,x.grantor,x.grantee,x.privilege_type,x.is_grantable) FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) x WHERE a.attrelid=ANY(ARRAY['public.advance_requests'::regclass,'public.advances'::regclass,'public.attendance'::regclass,'public.payroll'::regclass]) AND a.attnum>0 AND NOT a.attisdropped
 ) acl;
 REVOKE ALL PRIVILEGES ON TABLE public.advance_requests,public.advances,public.attendance,public.payroll FROM anon;
 SELECT coalesce(jsonb_agg(rowdata ORDER BY rowdata::text),'[]'::jsonb) INTO v_after FROM (
  SELECT jsonb_build_array('table',c.oid::text,a.grantor,a.grantee,a.privilege_type,a.is_grantable) rowdata FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid=ANY(ARRAY['public.advance_requests'::regclass,'public.advances'::regclass,'public.attendance'::regclass,'public.payroll'::regclass]) AND a.grantee<>v_anon
  UNION ALL SELECT jsonb_build_array('column',a.attrelid::text,a.attnum,x.grantor,x.grantee,x.privilege_type,x.is_grantable) FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) x WHERE a.attrelid=ANY(ARRAY['public.advance_requests'::regclass,'public.advances'::regclass,'public.attendance'::regclass,'public.payroll'::regclass]) AND a.attnum>0 AND NOT a.attisdropped
 ) acl;
 IF v_before IS DISTINCT FROM v_after THEN RAISE EXCEPTION 'Non-anonymous grants changed'; END IF;
 FOREACH t IN ARRAY ARRAY['public.advance_requests'::regclass,'public.advances'::regclass,'public.attendance'::regclass,'public.payroll'::regclass] LOOP
  FOREACH p IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'] LOOP
   IF has_table_privilege('anon',t,p) THEN RAISE EXCEPTION 'Anonymous table privilege still effective: % %',t,p; END IF;
  END LOOP;
  FOR r IN SELECT attname FROM pg_attribute WHERE attrelid=t AND attnum>0 AND NOT attisdropped LOOP
   FOREACH p IN ARRAY ARRAY['SELECT','INSERT','UPDATE','REFERENCES'] LOOP
    IF has_column_privilege('anon',t,r.attname,p) THEN RAISE EXCEPTION 'Anonymous column privilege still effective: % % %',t,r.attname,p; END IF;
   END LOOP;
  END LOOP;
  IF NOT has_table_privilege('authenticated',t,'SELECT') OR NOT has_table_privilege('service_role',t,'SELECT') THEN RAISE EXCEPTION 'Required access changed: %',t; END IF;
 END LOOP;
END $hardening$;
