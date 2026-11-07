-- STAGED ONLY: DO NOT APPLY TO HOSTED until every authenticated table,
-- SECURITY DEFINER function, Storage policy and service-role route has been
-- reviewed, the UI and Auth recovery are complete, and deployment is approved.
-- This is a database access gate, NOT an Auth ban or invalidation of issued
-- JWTs, signed URLs, already-running requests or already-copied data.
-- A row means access is blocked; absence of a row is not a proof of identity.
CREATE TABLE public.team_access_revocations (
  user_id uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE RESTRICT,
  revoked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_by uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT
);
ALTER TABLE public.team_access_revocations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.team_access_revocations FROM PUBLIC, anon, authenticated, service_role;

-- Called only after the server has authenticated and verified the Founder.
-- Do not offer reactivation without a reviewed session/Auth recovery process.
CREATE FUNCTION public.revoke_supervisor_access_guarded(p_actor uuid, p_target uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_actor_email text; v_target public.users%ROWTYPE;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'TEAM_ACCESS_REQUIRES_READ_COMMITTED' USING ERRCODE='P1002';
  END IF;
  PERFORM app_private.lock_founder_guard();
  SELECT email INTO v_actor_email FROM public.users
    WHERE id=p_actor AND role='founder'
      AND NOT EXISTS (SELECT 1 FROM public.team_access_revocations r WHERE r.user_id=p_actor);
  IF NOT FOUND THEN RAISE EXCEPTION 'Founder access is required.' USING ERRCODE='42501'; END IF;
  IF p_target IS NULL OR p_actor=p_target THEN
    RAISE EXCEPTION 'Cannot revoke your own access.' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_target FROM public.users WHERE id=p_target FOR UPDATE;
  IF NOT FOUND OR v_target.role <> 'supervisor' THEN
    RAISE EXCEPTION 'Supervisor account not found.' USING ERRCODE='22023';
  END IF;
  IF EXISTS (SELECT 1 FROM public.team_access_revocations WHERE user_id=p_target) THEN RETURN false; END IF;
  INSERT INTO public.team_access_revocations (user_id,revoked_by) VALUES (p_target,p_actor);
  INSERT INTO public.audit_log(actor_id,actor_email,action,table_name,record_id,before_row,after_row)
    VALUES (p_actor,v_actor_email,'update','users',p_target,
      pg_catalog.jsonb_build_object('access','active'),pg_catalog.jsonb_build_object('access','revoked'));
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.revoke_supervisor_access_guarded(uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_supervisor_access_guarded(uuid,uuid) TO service_role;

-- Existing reviewed RLS gates and role helpers call this function. Profile
-- bootstrap, unreviewed definer functions, service-role requests and Storage
-- links require separate verification: this alone is NOT complete revocation.
CREATE OR REPLACE FUNCTION public.session_assurance_satisfied()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE
    WHEN auth.uid() IS NULL THEN false
    WHEN NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id=auth.uid() AND u.role IN ('founder','supervisor')) THEN false
    WHEN EXISTS (SELECT 1 FROM public.team_access_revocations r WHERE r.user_id=auth.uid()) THEN false
    WHEN (auth.jwt()->>'aal') NOT IN ('aal1','aal2') OR (auth.jwt()->>'aal') IS NULL THEN false
    WHEN (auth.jwt()->>'aal') = 'aal2' THEN true
    ELSE NOT EXISTS (SELECT 1 FROM auth.mfa_factors AS factor WHERE factor.user_id=auth.uid() AND factor.status='verified')
  END;
$$;
REVOKE ALL ON FUNCTION public.session_assurance_satisfied() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.session_assurance_satisfied() TO authenticated;

-- The service-role worker assignment RPCs bypass RLS. Serialize their access
-- check with revocation using the same user-row lock. A call already holding
-- the share lock finishes before revocation commits; a later call must see the
-- revocation. Other service-role operations still need independent review.
CREATE OR REPLACE FUNCTION app_private.lock_project_worker_access(p_actor uuid, p_project uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_role text;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'TEAM_ACCESS_REQUIRES_READ_COMMITTED' USING ERRCODE='P1002';
  END IF;
  SELECT role INTO v_role FROM public.users WHERE id=p_actor FOR SHARE;
  IF v_role IS NULL OR v_role NOT IN ('founder','supervisor') OR
     EXISTS (SELECT 1 FROM public.team_access_revocations WHERE user_id=p_actor) THEN
    RAISE EXCEPTION 'Project access required' USING ERRCODE='42501';
  END IF;
  PERFORM id FROM public.projects WHERE id=p_project FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Project not found' USING ERRCODE='22023'; END IF;
  IF v_role='supervisor' THEN
    PERFORM 1 FROM public.project_supervisors WHERE supervisor_id=p_actor AND project_id=p_project FOR KEY SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Project access required' USING ERRCODE='42501'; END IF;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION app_private.lock_project_worker_access(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

-- Keep a blocked Supervisor from being promoted to Founder through either the
-- guarded API or a direct allowed users UPDATE. This replaces the existing
-- statement-trigger function, preserving the original last-Founder guard.
-- The existing check_founder_after_update trigger MUST be verified at rollout.
CREATE OR REPLACE FUNCTION app_private.check_founder_after_update()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM old_user_rows WHERE role = 'founder') AND
     NOT EXISTS (SELECT 1 FROM public.users WHERE role = 'founder') THEN
    RAISE EXCEPTION 'Cannot remove the last Founder account.' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM public.users u JOIN public.team_access_revocations r ON r.user_id=u.id WHERE u.role='founder') THEN
    RAISE EXCEPTION 'A blocked account cannot become a Founder.' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
