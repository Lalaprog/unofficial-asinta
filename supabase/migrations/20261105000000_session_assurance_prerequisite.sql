-- Additive MFA-assurance prerequisite. This migration does not restrict any
-- existing access or change an account. It must be installed and verified before
-- an application calls the function. Hosted migration versions may differ;
-- follow the documented rollout, not an unconditional `supabase db push`.
--
-- Only the authenticated caller's own verified-factor presence is consulted.
-- The return value is boolean; factor identifiers, types and secrets are never
-- returned. auth.uid() and auth.jwt() reflect Supabase-verified request claims.
CREATE OR REPLACE FUNCTION public.session_assurance_satisfied()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT CASE
    WHEN auth.uid() IS NULL THEN false
    WHEN (auth.jwt()->>'aal') NOT IN ('aal1', 'aal2') OR (auth.jwt()->>'aal') IS NULL THEN false
    WHEN (auth.jwt()->>'aal') = 'aal2' THEN true
    ELSE NOT EXISTS (
      SELECT 1 FROM auth.mfa_factors AS factor
      WHERE factor.user_id = auth.uid() AND factor.status = 'verified'
    )
  END;
$$;

REVOKE ALL ON FUNCTION public.session_assurance_satisfied() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.session_assurance_satisfied() TO authenticated;
