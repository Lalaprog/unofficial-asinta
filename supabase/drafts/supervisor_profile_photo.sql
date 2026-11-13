-- UNINSTALLED EXPERIMENTAL DRAFT. Not a release migration. An optional small
-- portrait is stored in one private database row per Supervisor, not a public
-- bucket. This adds no data and changes no existing account or role.
-- Founder uploads/removes; Founder and the Supervisor themself may view.
-- Requires a compatible client, reviewed access/backup/size and target catalog.
-- An account deletion cascades its image row; backups must protect portraits.
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
DO $preflight$
BEGIN
 IF to_regclass('public.users') IS NULL OR to_regprocedure('auth.uid()') IS NULL
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
