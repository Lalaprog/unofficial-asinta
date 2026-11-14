-- Development-only Supervisor photo artifact. Use in ONE managed transaction.
-- Source SHA256 10408a904dcb43d965214c40317a2760e5591f92acd8f07f94ba736d0ce7b6e7
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
LOCK TABLE public.users, public.audit_log IN SHARE ROW EXCLUSIVE MODE;
DO $preflight$ BEGIN
 IF current_database()<>'postgres' THEN RAISE EXCEPTION 'Unexpected database';END IF;
 IF (SELECT count(*) FROM public.users WHERE role='founder')<>1 OR (SELECT count(*) FROM public.users WHERE role='supervisor')<>1 THEN RAISE EXCEPTION 'Development profile state changed';END IF;
 IF NOT coalesce((SELECT relrowsecurity FROM pg_class WHERE oid='public.users'::regclass),false) OR
  md5(pg_get_functiondef('public.is_founder()'::regprocedure))<>'4ed57b18b9d05216cfa70359ca2553fb' OR
  md5(pg_get_functiondef('public.session_assurance_satisfied()'::regprocedure))<>'390d4f2b3755c6a961ac1f1892d3e801' OR
  md5(pg_get_functiondef('auth.uid()'::regprocedure))<>'ea3b41bf29e2ad573067939329aa088e' THEN RAISE EXCEPTION 'Account authorization drift';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.users'::regclass AND tgname='lock_user_mutations' AND tgenabled='O') OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.users'::regclass AND tgname='check_founder_after_update' AND tgenabled='O') OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.users'::regclass AND tgname='check_founder_after_delete' AND tgenabled='O') THEN RAISE EXCEPTION 'Account mutation guards changed';END IF;
END $preflight$;
-- UNINSTALLED EXPERIMENTAL DRAFT. Not a release migration. An optional small
-- portrait is stored in one private database row per Supervisor, not a public
-- bucket. This adds no data and changes no existing account or role.
-- Founder uploads/removes; Founder and the Supervisor themself may view.
-- Requires a compatible client, reviewed access/backup/size and target catalog.
-- An account deletion cascades its image row; backups must protect portraits.
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
DO $preflight$
BEGIN
 IF to_regclass('public.users') IS NULL OR to_regclass('public.audit_log') IS NULL OR to_regprocedure('auth.uid()') IS NULL
 OR to_regprocedure('public.is_founder()') IS NULL OR to_regprocedure('public.session_assurance_satisfied()') IS NULL THEN
  RAISE EXCEPTION 'Supervisor portrait prerequisites missing'; END IF;
 IF to_regclass('public.supervisor_profile_photos') IS NOT NULL
 OR to_regprocedure('public.supervisor_profile_photo(uuid)') IS NOT NULL
 OR to_regprocedure('public.set_supervisor_profile_photo(uuid,uuid,uuid,text,text)') IS NOT NULL THEN
  RAISE EXCEPTION 'Supervisor portrait objects already exist'; END IF;
END;
$preflight$;
CREATE TABLE public.supervisor_profile_photos (
 supervisor_id uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
 version uuid NOT NULL UNIQUE,
 previous_version uuid,
 actor_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
 mime text,
 photo bytea,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK ((photo IS NULL AND mime IS NULL) OR (photo IS NOT NULL AND mime IN ('image/jpeg','image/png','image/webp') AND octet_length(photo) BETWEEN 1 AND 262144))
);
ALTER TABLE public.supervisor_profile_photos ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.supervisor_profile_photos FROM PUBLIC,anon,authenticated,service_role;
DO $table_acl$
BEGIN
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r(role_name)
 WHERE has_table_privilege(r.role_name,'public.supervisor_profile_photos','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR EXISTS
  (SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid='public.supervisor_profile_photos'::regclass AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege(r.role_name,a.attrelid,a.attname,'SELECT,INSERT,UPDATE'))) THEN
  RAISE EXCEPTION 'Unexpected inherited portrait-table privilege'; END IF;
END;
$table_acl$;

-- Reads return one bounded image only. A missing portrait is not an error;
-- unknown/inaccessible/non-Supervisor targets fail closed with the same error.
CREATE FUNCTION public.supervisor_profile_photo(p_supervisor uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid:=auth.uid();v_role text;v_row public.supervisor_profile_photos%ROWTYPE;
BEGIN
 IF v_actor IS NULL OR p_supervisor IS NULL OR NOT coalesce(public.session_assurance_satisfied(),false) THEN
  RAISE EXCEPTION 'Profile photo access required' USING ERRCODE='42501'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Profile photos require read committed' USING ERRCODE='P1002'; END IF;
 SELECT role INTO v_role FROM public.users WHERE id=v_actor FOR SHARE;
 IF NOT FOUND OR (v_role<>'founder' AND v_actor<>p_supervisor) OR (v_role='founder' AND NOT coalesce(public.is_founder(),false)) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN
  RAISE EXCEPTION 'Profile photo access required' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM public.users WHERE id=p_supervisor AND role='supervisor' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Profile photo access required' USING ERRCODE='42501'; END IF;
 SELECT * INTO v_row FROM public.supervisor_profile_photos WHERE supervisor_id=p_supervisor;
 RETURN jsonb_build_object('supervisor_id',p_supervisor,'version',v_row.version,'has_photo',v_row.photo IS NOT NULL,
  'mime',v_row.mime,'data',CASE WHEN v_row.photo IS NULL THEN NULL ELSE replace(encode(v_row.photo,'base64'),E'\n','') END);
END;
$$;
REVOKE ALL ON FUNCTION public.supervisor_profile_photo(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.supervisor_profile_photo(uuid) TO authenticated;

-- Request ID is also the new version. An exact retry of the latest operation is
-- safe. A replaced operation is a conflict, not permission to overwrite newer
-- work. A null photo is a versioned removal (tombstone), not row deletion.
CREATE FUNCTION public.set_supervisor_profile_photo(p_supervisor uuid,p_operation uuid,p_expected_version uuid,p_mime text,p_data text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid:=auth.uid();v_role text;v_photo bytea;v_row public.supervisor_profile_photos%ROWTYPE;v_exists boolean;
BEGIN
 IF v_actor IS NULL OR p_supervisor IS NULL OR p_operation IS NULL OR NOT coalesce(public.session_assurance_satisfied(),false) THEN
  RAISE EXCEPTION 'Founder access required' USING ERRCODE='42501'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Profile photos require read committed' USING ERRCODE='P1002'; END IF;
 SELECT role INTO v_role FROM public.users WHERE id=v_actor FOR SHARE;
 IF v_role IS DISTINCT FROM 'founder' OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN
  RAISE EXCEPTION 'Founder access required' USING ERRCODE='42501'; END IF;
 -- Serialize both initial writes and role changes, including the absent-row case.
 PERFORM 1 FROM public.users WHERE id=p_supervisor AND role='supervisor' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Supervisor unavailable' USING ERRCODE='22023'; END IF;
 IF (p_data IS NULL) IS DISTINCT FROM (p_mime IS NULL) THEN RAISE EXCEPTION 'Invalid profile photo' USING ERRCODE='22023'; END IF;
 IF p_data IS NOT NULL THEN
  IF p_mime NOT IN ('image/jpeg','image/png','image/webp') OR length(p_data)>349528 OR length(p_data)=0 OR length(p_data)%4<>0 OR p_data !~ '^[A-Za-z0-9+/]*={0,2}$' THEN RAISE EXCEPTION 'Invalid profile photo' USING ERRCODE='22023'; END IF;
  BEGIN v_photo:=decode(p_data,'base64'); EXCEPTION WHEN others THEN RAISE EXCEPTION 'Invalid profile photo' USING ERRCODE='22023'; END;
  IF octet_length(v_photo) NOT BETWEEN 1 AND 262144 OR
   (p_mime='image/jpeg' AND substring(v_photo FROM 1 FOR 3)<>decode('ffd8ff','hex')) OR
   (p_mime='image/png' AND substring(v_photo FROM 1 FOR 8)<>decode('89504e470d0a1a0a','hex')) OR
   (p_mime='image/webp' AND (substring(v_photo FROM 1 FOR 4)<>decode('52494646','hex') OR substring(v_photo FROM 9 FOR 4)<>decode('57454250','hex'))) THEN
   RAISE EXCEPTION 'Invalid profile photo' USING ERRCODE='22023'; END IF;
 END IF;
 SELECT * INTO v_row FROM public.supervisor_profile_photos WHERE supervisor_id=p_supervisor FOR UPDATE;v_exists:=FOUND;
 IF v_exists AND v_row.version=p_operation THEN
  IF (v_row.actor_id,v_row.previous_version,v_row.mime,v_row.photo) IS DISTINCT FROM (v_actor,p_expected_version,p_mime,v_photo) THEN
   RAISE EXCEPTION 'Profile photo retry differs' USING ERRCODE='22023'; END IF;
  RETURN jsonb_build_object('supervisor_id',p_supervisor,'version',v_row.version,'has_photo',v_row.photo IS NOT NULL,'replayed',true);
 END IF;
 IF (CASE WHEN v_exists THEN v_row.version ELSE NULL END) IS DISTINCT FROM p_expected_version OR p_operation IS NOT DISTINCT FROM p_expected_version THEN
  RAISE EXCEPTION 'Profile photo changed; refresh before retrying' USING ERRCODE='40001'; END IF;
 INSERT INTO public.supervisor_profile_photos(supervisor_id,version,previous_version,actor_id,mime,photo)
 VALUES(p_supervisor,p_operation,p_expected_version,v_actor,p_mime,v_photo)
 ON CONFLICT(supervisor_id) DO UPDATE SET version=EXCLUDED.version,previous_version=EXCLUDED.previous_version,actor_id=EXCLUDED.actor_id,mime=EXCLUDED.mime,photo=EXCLUDED.photo,updated_at=clock_timestamp();
 -- Record metadata only: never copy image bytes or base64 to the audit log.
 -- An exact replay returns above and cannot create a duplicate audit row.
 INSERT INTO public.audit_log(actor_id,action,table_name,record_id,before_row,after_row)
 VALUES(v_actor,CASE WHEN v_exists THEN 'update' ELSE 'insert' END,'supervisor_profile_photos',p_supervisor,
  CASE WHEN v_exists THEN jsonb_build_object('version',v_row.version,'has_photo',v_row.photo IS NOT NULL,'mime',v_row.mime) ELSE NULL END,
  jsonb_build_object('version',p_operation,'has_photo',v_photo IS NOT NULL,'mime',p_mime));
 RETURN jsonb_build_object('supervisor_id',p_supervisor,'version',p_operation,'has_photo',v_photo IS NOT NULL,'replayed',false);
END;
$$;
REVOKE ALL ON FUNCTION public.set_supervisor_profile_photo(uuid,uuid,uuid,text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.set_supervisor_profile_photo(uuid,uuid,uuid,text,text) TO authenticated;
DO $function_acl$
BEGIN
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['anon','service_role']) r(role_name) WHERE has_function_privilege(r.role_name,'public.supervisor_profile_photo(uuid)','EXECUTE') OR has_function_privilege(r.role_name,'public.set_supervisor_profile_photo(uuid,uuid,uuid,text,text)','EXECUTE'))
 OR NOT has_function_privilege('authenticated','public.supervisor_profile_photo(uuid)','EXECUTE') OR NOT has_function_privilege('authenticated','public.set_supervisor_profile_photo(uuid,uuid,uuid,text,text)','EXECUTE') THEN
  RAISE EXCEPTION 'Unexpected portrait-function privileges'; END IF;
END;
$function_acl$;

DO $postflight$ BEGIN
 IF EXISTS(SELECT 1 FROM public.supervisor_profile_photos) OR NOT coalesce((SELECT relrowsecurity FROM pg_class WHERE oid='public.supervisor_profile_photos'::regclass),false) THEN RAISE EXCEPTION 'Portrait postflight failed';END IF;
END $postflight$;
