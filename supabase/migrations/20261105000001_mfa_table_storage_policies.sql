-- DRAFT: DO NOT APPLY TO A HOSTED PROJECT until the full MFA rollout is ready.
-- Requires the session_assurance_satisfied() prerequisite. This is only table
-- and storage RLS: SECURITY DEFINER functions and service-role routes need
-- their own safeguards; it is not sufficient to enable email recovery.
-- Existing permissive policies remain in force (the restrictive rules AND with
-- them). An unenrolled user can continue with aal1, while an enrolled user
-- requires aal2. The own profile read exception is only for MFA bootstrapping.

-- Refuse deployment if a listed table is missing or no longer has RLS, or
-- if an unexpected public relation is accessible to authenticated clients.
-- This does not discover definer functions; audit those separately.
DO $$
DECLARE
  t text;
  expected text[] := ARRAY['advance_requests', 'advances', 'attendance', 'audit_log', 'clients', 'email_logs', 'email_templates', 'expenses', 'invoices', 'payroll', 'project_supervisors', 'projects', 'reminder_dispatches', 'sms_logs', 'tools', 'user_notifications', 'vendor_memory', 'workers', 'users'];
BEGIN
  IF pg_catalog.to_regprocedure('public.session_assurance_satisfied()') IS NULL THEN
    RAISE EXCEPTION 'Missing session assurance prerequisite';
  END IF;
  FOREACH t IN ARRAY expected LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = t
        AND c.relkind IN ('r','p') AND c.relrowsecurity) THEN
      RAISE EXCEPTION 'Expected RLS-enabled public table missing: %', t;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m')
      AND NOT (c.relname = ANY(expected))
      AND (pg_catalog.has_table_privilege('authenticated', c.oid, 'SELECT, INSERT, UPDATE, DELETE')
        OR pg_catalog.has_any_column_privilege('authenticated', c.oid, 'SELECT, INSERT, UPDATE'))) THEN
    RAISE EXCEPTION 'Unexpected authenticated-accessible public relation: review before deployment';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'storage' AND c.relname = 'objects'
      AND c.relkind IN ('r','p') AND c.relrowsecurity) THEN
    RAISE EXCEPTION 'Expected RLS-enabled storage.objects missing';
  END IF;
END $$;

DROP POLICY IF EXISTS mfa_session_required ON public.advance_requests;
CREATE POLICY mfa_session_required ON public.advance_requests AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.session_assurance_satisfied()))
  WITH CHECK ((SELECT public.session_assurance_satisfied()));

DROP POLICY IF EXISTS mfa_session_required ON public.advances;
CREATE POLICY mfa_session_required ON public.advances AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.session_assurance_satisfied()))
  WITH CHECK ((SELECT public.session_assurance_satisfied()));

DROP POLICY IF EXISTS mfa_session_required ON public.attendance;
CREATE POLICY mfa_session_required ON public.attendance AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.session_assurance_satisfied()))
  WITH CHECK ((SELECT public.session_assurance_satisfied()));

DROP POLICY IF EXISTS mfa_session_required ON public.audit_log;
CREATE POLICY mfa_session_required ON public.audit_log AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.session_assurance_satisfied()))
  WITH CHECK ((SELECT public.session_assurance_satisfied()));

DROP POLICY IF EXISTS mfa_session_required ON public.clients;
CREATE POLICY mfa_session_required ON public.clients AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.session_assurance_satisfied()))
  WITH CHECK ((SELECT public.session_assurance_satisfied()));

DROP POLICY IF EXISTS mfa_session_required ON public.email_logs;
CREATE POLICY mfa_session_required ON public.email_logs AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.session_assurance_satisfied()))
  WITH CHECK ((SELECT public.session_assurance_satisfied()));

DROP POLICY IF EXISTS mfa_session_required ON public.email_templates;
CREATE POLICY mfa_session_required ON public.email_templates AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.session_assurance_satisfied()))
  WITH CHECK ((SELECT public.session_assurance_satisfied()));

DROP POLICY IF EXISTS mfa_session_required ON public.expenses;
CREATE POLICY mfa_session_required ON public.expenses AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.session_assurance_satisfied()))
  WITH CHECK ((SELECT public.session_assurance_satisfied()));

DROP POLICY IF EXISTS mfa_session_required ON public.invoices;
CREATE POLICY mfa_session_required ON public.invoices AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.session_assurance_satisfied()))
  WITH CHECK ((SELECT public.session_assurance_satisfied()));

DROP POLICY IF EXISTS mfa_session_required ON public.payroll;
CREATE POLICY mfa_session_required ON public.payroll AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.session_assurance_satisfied()))
  WITH CHECK ((SELECT public.session_assurance_satisfied()));

DROP POLICY IF EXISTS mfa_session_required ON public.project_supervisors;
CREATE POLICY mfa_session_required ON public.project_supervisors AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.session_assurance_satisfied()))
  WITH CHECK ((SELECT public.session_assurance_satisfied()));

DROP POLICY IF EXISTS mfa_session_required ON public.projects;
CREATE POLICY mfa_session_required ON public.projects AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.session_assurance_satisfied()))
  WITH CHECK ((SELECT public.session_assurance_satisfied()));

DROP POLICY IF EXISTS mfa_session_required ON public.reminder_dispatches;
CREATE POLICY mfa_session_required ON public.reminder_dispatches AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.session_assurance_satisfied()))
  WITH CHECK ((SELECT public.session_assurance_satisfied()));

DROP POLICY IF EXISTS mfa_session_required ON public.sms_logs;
CREATE POLICY mfa_session_required ON public.sms_logs AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.session_assurance_satisfied()))
  WITH CHECK ((SELECT public.session_assurance_satisfied()));

DROP POLICY IF EXISTS mfa_session_required ON public.tools;
CREATE POLICY mfa_session_required ON public.tools AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.session_assurance_satisfied()))
  WITH CHECK ((SELECT public.session_assurance_satisfied()));

DROP POLICY IF EXISTS mfa_session_required ON public.user_notifications;
CREATE POLICY mfa_session_required ON public.user_notifications AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.session_assurance_satisfied()))
  WITH CHECK ((SELECT public.session_assurance_satisfied()));

DROP POLICY IF EXISTS mfa_session_required ON public.vendor_memory;
CREATE POLICY mfa_session_required ON public.vendor_memory AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.session_assurance_satisfied()))
  WITH CHECK ((SELECT public.session_assurance_satisfied()));

DROP POLICY IF EXISTS mfa_session_required ON public.workers;
CREATE POLICY mfa_session_required ON public.workers AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.session_assurance_satisfied()))
  WITH CHECK ((SELECT public.session_assurance_satisfied()));

-- Only the signed-in user's own profile can be read at aal1 while a verified
-- factor awaits challenge. It does not grant profile access: existing permissive
-- policies still apply. Never allow writes through the bootstrap exception.
DROP POLICY IF EXISTS mfa_profile_read ON public.users;
CREATE POLICY mfa_profile_read ON public.users AS RESTRICTIVE FOR SELECT TO authenticated
  USING (
    ((id = (SELECT auth.uid())) AND (SELECT auth.jwt()->>'aal') IN ('aal1', 'aal2'))
    OR (SELECT public.session_assurance_satisfied())
  );
DROP POLICY IF EXISTS mfa_profile_insert ON public.users;
CREATE POLICY mfa_profile_insert ON public.users AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK ((SELECT public.session_assurance_satisfied()));
DROP POLICY IF EXISTS mfa_profile_update ON public.users;
CREATE POLICY mfa_profile_update ON public.users AS RESTRICTIVE FOR UPDATE TO authenticated
  USING ((SELECT public.session_assurance_satisfied()))
  WITH CHECK ((SELECT public.session_assurance_satisfied()));
DROP POLICY IF EXISTS mfa_profile_delete ON public.users;
CREATE POLICY mfa_profile_delete ON public.users AS RESTRICTIVE FOR DELETE TO authenticated
  USING ((SELECT public.session_assurance_satisfied()));

DROP POLICY IF EXISTS mfa_session_required ON storage.objects;
CREATE POLICY mfa_session_required ON storage.objects AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.session_assurance_satisfied()))
  WITH CHECK ((SELECT public.session_assurance_satisfied()));
