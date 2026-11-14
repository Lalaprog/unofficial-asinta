-- EXPERIMENTAL, UNINSTALLED. This is NOT a standalone migration or a complete
-- cutover. It removes direct API/service writes to the assignment table while
-- retaining existing SELECT grants and the server-only SECURITY DEFINER RPCs.
-- It can break imports, maintenance, restores, older server code, integrations,
-- direct admin tools or custom writers. Do not apply to a shared database until
-- every writer, function body/owner/grant, restoration path and old deployment
-- has been reviewed and tested together. A table owner, superuser or a role
-- able to assume one remains privileged. service_role can invoke trusted RPCs
-- with an actor argument; it is NOT a user identity or an untrusted boundary.
-- The caller must wrap this entire draft in a transaction; any exception must
-- roll back the REVOKEs. Existing assignment and history rows are not changed.

-- Block existing SQL writers while changing permissions. This lock can cause
-- downtime; it is not a guarantee against unreviewed privileged writers.
-- These LOCAL limits also apply to later statements in the caller's transaction.
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
LOCK TABLE public.project_worker_assignments IN SHARE ROW EXCLUSIVE MODE;
DO $preflight$
DECLARE v_oid oid; v_signature text; v_owner oid;
BEGIN
 FOREACH v_signature IN ARRAY ARRAY[
  'public.set_project_worker_guarded(uuid,uuid,uuid,boolean)',
  'public.create_project_worker_guarded(uuid,uuid,uuid,text,text,text,numeric,text)',
  'public.set_workers_removed_guarded(uuid,uuid[],boolean)'
 ] LOOP
  v_oid:=pg_catalog.to_regprocedure(v_signature);
  IF v_oid IS NULL OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid=v_oid AND p.prosecdef) OR
    NOT pg_catalog.has_function_privilege('service_role',v_oid,'EXECUTE') THEN
   RAISE EXCEPTION 'Reviewed assignment writer missing or not executable: %',v_signature;
  END IF;
  SELECT proowner INTO v_owner FROM pg_catalog.pg_proc WHERE oid=v_oid;
  IF NOT pg_catalog.has_table_privilege(v_owner,'public.project_worker_assignments','SELECT') OR
     NOT pg_catalog.has_table_privilege(v_owner,'public.project_worker_assignments','INSERT') OR
     NOT pg_catalog.has_table_privilege(v_owner,'public.project_worker_assignments','UPDATE') THEN
   RAISE EXCEPTION 'Assignment writer owner lacks required table privileges: %',v_signature;
  END IF;
 END LOOP;
END $preflight$;

-- Table revokes alone do not remove pre-existing per-column grants. Explicitly
-- revoke both and fail closed if an inherited privilege remains. SELECT is
-- deliberately retained: server and RLS-scoped application reads still need it.
REVOKE INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.project_worker_assignments FROM PUBLIC,anon,authenticated,service_role;
DO $columns$
DECLARE v_columns text;
BEGIN
 SELECT string_agg(pg_catalog.quote_ident(a.attname),',' ORDER BY a.attnum) INTO v_columns
 FROM pg_catalog.pg_attribute a WHERE a.attrelid='public.project_worker_assignments'::regclass AND a.attnum>0 AND NOT a.attisdropped;
 IF v_columns IS NULL THEN RAISE EXCEPTION 'Assignment columns unavailable'; END IF;
 EXECUTE pg_catalog.format('REVOKE INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) ON TABLE public.project_worker_assignments FROM PUBLIC, anon, authenticated, service_role',v_columns);
END $columns$;
DO $postflight$
BEGIN
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r(role_name)
  WHERE pg_catalog.has_table_privilege(r.role_name,'public.project_worker_assignments','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
   OR EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid='public.project_worker_assignments'::regclass
    AND a.attnum>0 AND NOT a.attisdropped AND pg_catalog.has_column_privilege(r.role_name,a.attrelid,a.attname,'INSERT,UPDATE,REFERENCES'))) THEN
  RAISE EXCEPTION 'Inherited assignment write or DDL privilege remains';
 END IF;
END $postflight$;
