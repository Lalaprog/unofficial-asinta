-- ISOLATED TEST FIXTURE ONLY. Not a migration. Do not run on hosted Supabase.
-- This explores one possible assurance policy; it does not cover the real app.
-- Its deliberately fictional tables are built by mfa-recovery-prototype.test.ts.

CREATE SCHEMA assurance_private;
REVOKE ALL ON SCHEMA assurance_private FROM PUBLIC;
GRANT USAGE ON SCHEMA assurance_private TO authenticated;

-- The definer sees factor status without granting clients access to factor rows.
-- There is no user-id argument: the only identity consulted is auth.uid().
CREATE FUNCTION assurance_private.session_satisfies_mfa()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE
    WHEN auth.uid() IS NULL THEN false
    WHEN (auth.jwt()->>'aal') NOT IN ('aal1', 'aal2') OR (auth.jwt()->>'aal') IS NULL THEN false
    WHEN (auth.jwt()->>'aal') = 'aal2' THEN true
    ELSE NOT EXISTS (
      SELECT 1 FROM auth.mfa_factors AS f
      WHERE f.user_id = auth.uid() AND f.status = 'verified'
    )
  END;
$$;
REVOKE ALL ON FUNCTION assurance_private.session_satisfies_mfa() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION assurance_private.session_satisfies_mfa() TO authenticated;

-- Restrictive policies combine with existing permissive access rules via AND.
CREATE POLICY enforce_assurance ON public.private_entries AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT assurance_private.session_satisfies_mfa()))
  WITH CHECK ((SELECT assurance_private.session_satisfies_mfa()));
CREATE POLICY enforce_assurance ON storage.objects AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT assurance_private.session_satisfies_mfa()))
  WITH CHECK ((SELECT assurance_private.session_satisfies_mfa()));

-- Bootstrapping needs the current user's own profile before the MFA challenge.
-- Other users' profiles and all writes still require a satisfactory session.
CREATE POLICY profile_select_assurance ON public.profiles AS RESTRICTIVE FOR SELECT TO authenticated
  USING ((id = (SELECT auth.uid()) AND (SELECT auth.jwt()->>'aal') IN ('aal1', 'aal2'))
    OR (SELECT assurance_private.session_satisfies_mfa()));
CREATE POLICY profile_insert_assurance ON public.profiles AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK ((SELECT assurance_private.session_satisfies_mfa()));
CREATE POLICY profile_update_assurance ON public.profiles AS RESTRICTIVE FOR UPDATE TO authenticated
  USING ((SELECT assurance_private.session_satisfies_mfa()))
  WITH CHECK ((SELECT assurance_private.session_satisfies_mfa()));
CREATE POLICY profile_delete_assurance ON public.profiles AS RESTRICTIVE FOR DELETE TO authenticated
  USING ((SELECT assurance_private.session_satisfies_mfa()));

-- SECURITY DEFINER functions may bypass table RLS; they need an explicit guard.
CREATE FUNCTION public.guarded_entries()
RETURNS SETOF public.private_entries LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF assurance_private.session_satisfies_mfa() IS NOT TRUE THEN
    RAISE EXCEPTION 'Additional verification required' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT * FROM public.private_entries WHERE owner_id = auth.uid();
END;
$$;
REVOKE ALL ON FUNCTION public.guarded_entries() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.guarded_entries() TO authenticated;
