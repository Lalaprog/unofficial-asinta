-- AUDIT COPY: applied to the connected DEVELOPMENT project as hosted migration
-- 20261113223101_legacy_bale_anon_execute_hardening. This is not in the normal
-- migration chain and must not be replayed blindly on another database. The
-- three known body hashes deliberately bind this one change to that environment.
-- It revokes only PUBLIC/anon EXECUTE; authenticated and service_role remain.
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='15s';
DO $$
DECLARE signature text; target regprocedure;
BEGIN
 FOREACH signature IN ARRAY ARRAY['public.review_advance_request(uuid,text)','public.approve_advance_requests(uuid[])','public.issue_advance_request(uuid)'] LOOP
  target:=pg_catalog.to_regprocedure(signature);
  IF target IS NULL OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc WHERE oid=target AND prosecdef)
    OR NOT pg_catalog.has_function_privilege('authenticated',target,'EXECUTE') THEN
   RAISE EXCEPTION 'Expected authenticated legacy Bale definer missing or inaccessible: %',signature;
  END IF;
 END LOOP;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.review_advance_request(uuid,text)'))<>'17e15b9018eb6a9a22b90bc0e2fe4f9a'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.approve_advance_requests(uuid[])'))<>'c24e527ae6e7240ab513f2ca44188696'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.issue_advance_request(uuid)'))<>'036f1f78fb6f1af8cbf94f9a378cbe05' THEN
  RAISE EXCEPTION 'Legacy Bale function bodies changed; reassess before hardening';
 END IF;
END $$;
REVOKE ALL ON FUNCTION public.review_advance_request(uuid,text) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.approve_advance_requests(uuid[]) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.issue_advance_request(uuid) FROM PUBLIC,anon;
DO $$
DECLARE signature text; target regprocedure;
BEGIN
 FOREACH signature IN ARRAY ARRAY['public.review_advance_request(uuid,text)','public.approve_advance_requests(uuid[])','public.issue_advance_request(uuid)'] LOOP
  target:=pg_catalog.to_regprocedure(signature);
  IF pg_catalog.has_function_privilege('anon',target,'EXECUTE')
   OR NOT pg_catalog.has_function_privilege('authenticated',target,'EXECUTE')
   OR NOT pg_catalog.has_function_privilege('service_role',target,'EXECUTE') THEN
   RAISE EXCEPTION 'Unexpected inherited anon access or lost authenticated/service legacy Bale access: %',signature;
  END IF;
 END LOOP;
END $$;
