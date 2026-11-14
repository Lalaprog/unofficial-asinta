-- GENERIC DRAFT: not a standalone deployment. A separately fingerprint-bound
-- variant was installed on the development project; see applied_development/.
-- The three existing legacy RPCs remain authenticated-callable, and their
-- bodies and triggers are unchanged. PUBLIC and explicit anon EXECUTE are
-- removed; effective inherited anon access aborts the transaction. PUBLIC
-- revocation can also affect other roles, so inventory non-API integrations
-- and validate them before rollout. This does not disable authenticated old
-- clients, replace weekly guards, install a scheduler, or secure other RPCs.
-- Execute as one transaction under the reviewed function owner; roll back on
-- any error. Owners/superusers and privileged role administrators can bypass.
DO $$
DECLARE signature text; target regprocedure;
BEGIN
 FOREACH signature IN ARRAY ARRAY['public.review_advance_request(uuid,text)',
   'public.approve_advance_requests(uuid[])','public.issue_advance_request(uuid)'] LOOP
  target := pg_catalog.to_regprocedure(signature);
  IF target IS NULL OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc WHERE oid=target AND prosecdef)
     OR NOT pg_catalog.has_function_privilege('authenticated',target,'EXECUTE') THEN
   RAISE EXCEPTION 'Expected authenticated legacy Bale definer missing or inaccessible: %',signature;
  END IF;
 END LOOP;
END $$;

REVOKE ALL ON FUNCTION public.review_advance_request(uuid,text) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.approve_advance_requests(uuid[]) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.issue_advance_request(uuid) FROM PUBLIC,anon;

DO $$
DECLARE signature text; target regprocedure;
BEGIN
 FOREACH signature IN ARRAY ARRAY['public.review_advance_request(uuid,text)',
   'public.approve_advance_requests(uuid[])','public.issue_advance_request(uuid)'] LOOP
  target := pg_catalog.to_regprocedure(signature);
  IF pg_catalog.has_function_privilege('anon',target,'EXECUTE') OR
     NOT pg_catalog.has_function_privilege('authenticated',target,'EXECUTE') THEN
   RAISE EXCEPTION 'Unexpected inherited anon access or lost authenticated legacy Bale access: %',signature;
  END IF;
 END LOOP;
END $$;
