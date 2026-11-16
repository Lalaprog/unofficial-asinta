-- Development-specific worker SELECT policy cutover. No business rows changed.
-- Historical attendance in an
-- authorized project and the Supervisor's own Bale requests retain names. This
-- also retains active profiles matching the Supervisor's own name so the older
-- Roll Call identity-collision check continues to block; these exceptions expose
-- entire worker rows, including current pay/contact, not just names. They are not
-- proof of selected-site-only privacy. Unassigned-worker discovery stays in the
-- separately authorized service RPC. This development artifact is not a fresh-install bundle.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
DO $preflight$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid='public.workers'::regclass AND c.relrowsecurity AND c.relkind='r' AND pg_catalog.pg_get_userbyid(c.relowner)='postgres')
 OR pg_catalog.to_regclass('public.project_worker_assignments') IS NULL OR pg_catalog.to_regclass('public.attendance') IS NULL
 OR pg_catalog.to_regclass('public.advance_requests') IS NULL OR pg_catalog.to_regclass('public.users') IS NULL
 OR pg_catalog.to_regprocedure('auth.uid()') IS NULL OR pg_catalog.to_regprocedure('public.current_user_role()') IS NULL
 OR pg_catalog.to_regprocedure('public.is_supervisor_assigned(uuid)') IS NULL OR pg_catalog.to_regprocedure('public.session_assurance_satisfied()') IS NULL THEN
  RAISE EXCEPTION 'Worker visibility prerequisites missing'; END IF;
 IF (SELECT count(*) FROM pg_catalog.pg_policies WHERE schemaname='public' AND tablename='workers' AND cmd IN ('ALL','SELECT')) <> 3
 OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policies WHERE schemaname='public' AND tablename='workers' AND policyname='Supervisors can view active workers' AND cmd='SELECT' AND permissive='PERMISSIVE' AND roles=ARRAY['authenticated']::name[] AND qual='((auth.uid() IS NOT NULL) AND (active = true))')
 OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policies WHERE schemaname='public' AND tablename='workers' AND policyname='Founders full access to workers' AND cmd='ALL' AND permissive='PERMISSIVE' AND roles=ARRAY['authenticated']::name[] AND qual='is_founder()')
 OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policies WHERE schemaname='public' AND tablename='workers' AND policyname='mfa_session_required' AND cmd='ALL' AND permissive='RESTRICTIVE' AND roles=ARRAY['authenticated']::name[])
 THEN RAISE EXCEPTION 'Worker policies changed; review before cutover'; END IF;
END $preflight$;
DROP POLICY "Supervisors can view active workers" ON public.workers;
CREATE POLICY "Supervisors view authorized project workers and history" ON public.workers
 FOR SELECT TO authenticated
 USING (
  (SELECT public.session_assurance_satisfied()) IS TRUE
  AND (SELECT public.current_user_role()) = 'supervisor'
  AND (
   id = (SELECT auth.uid())
   OR EXISTS (SELECT 1 FROM public.project_worker_assignments a
     WHERE a.worker_id=workers.id AND a.active IS TRUE AND public.is_supervisor_assigned(a.project_id))
   OR EXISTS (SELECT 1 FROM public.attendance a
     WHERE a.worker_id=workers.id AND public.is_supervisor_assigned(a.project_id))
   OR EXISTS (SELECT 1 FROM public.advance_requests r
     WHERE r.worker_id=workers.id AND r.submitted_by=(SELECT auth.uid()))
   OR (active IS TRUE AND EXISTS (SELECT 1 FROM public.users u
     WHERE u.id=(SELECT auth.uid()) AND u.role='supervisor' AND u.id<>workers.id
       AND nullif(btrim(u.name),'') IS NOT NULL
       AND lower(btrim(u.name))=lower(btrim(workers.name))))
  )
 );
DO $postflight$
BEGIN
 IF EXISTS (SELECT 1 FROM pg_catalog.pg_policies WHERE schemaname='public' AND tablename='workers' AND policyname='Supervisors can view active workers')
 OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policies WHERE schemaname='public' AND tablename='workers' AND policyname='Supervisors view authorized project workers and history' AND cmd='SELECT' AND roles=ARRAY['authenticated']::name[])
 THEN RAISE EXCEPTION 'Worker visibility policy not installed as expected'; END IF;
END $postflight$;
