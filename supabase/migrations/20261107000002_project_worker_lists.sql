-- Explicit current project membership. No historic attendance is inferred.
CREATE TABLE public.project_worker_assignments (
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  worker_id uuid NOT NULL REFERENCES public.workers(id) ON DELETE RESTRICT,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  PRIMARY KEY(project_id,worker_id)
);
ALTER TABLE public.project_worker_assignments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.project_worker_assignments FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.project_worker_assignments TO authenticated;
GRANT ALL ON public.project_worker_assignments TO service_role;
CREATE POLICY "Project members can view worker assignments" ON public.project_worker_assignments
  FOR SELECT TO authenticated USING ((SELECT public.is_founder()) OR public.is_supervisor_assigned(project_id));
CREATE POLICY "mfa_session_required" ON public.project_worker_assignments AS RESTRICTIVE
  FOR SELECT TO authenticated USING ((SELECT public.session_assurance_satisfied()));

-- These rows make a retry of the exact same registration request safe. They are
-- private to service-role functions and contain no names, pay or contact details.
CREATE TABLE app_private.project_worker_create_requests (
  request_id uuid PRIMARY KEY,
  actor_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  project_id uuid REFERENCES public.projects(id) ON DELETE CASCADE,
  worker_id uuid NOT NULL REFERENCES public.workers(id) ON DELETE RESTRICT,
  fingerprint text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON app_private.project_worker_create_requests FROM PUBLIC, anon, authenticated, service_role;

-- All functions below are server-only: the API checks verified Auth + MFA and
-- passes that identity; the database independently rechecks and locks scope.
CREATE FUNCTION app_private.lock_project_worker_access(p_actor uuid, p_project uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_role text;
BEGIN
  SELECT role INTO v_role FROM public.users WHERE id=p_actor FOR SHARE;
  IF v_role IS NULL OR v_role NOT IN ('founder','supervisor') THEN
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
REVOKE ALL ON FUNCTION app_private.lock_project_worker_access(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.set_project_worker_guarded(p_actor uuid,p_project uuid,p_worker uuid,p_active boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_worker_active boolean;
BEGIN
  PERFORM app_private.lock_project_worker_access(p_actor,p_project);
  IF p_active IS NULL THEN RAISE EXCEPTION 'Invalid assignment' USING ERRCODE='22023'; END IF;
  SELECT active INTO v_worker_active FROM public.workers WHERE id=p_worker FOR SHARE;
  IF NOT FOUND OR (p_active AND v_worker_active IS NOT TRUE) THEN RAISE EXCEPTION 'Worker unavailable' USING ERRCODE='22023'; END IF;
  IF p_active THEN
    INSERT INTO public.project_worker_assignments(project_id,worker_id,active,updated_by)
      VALUES(p_project,p_worker,true,p_actor)
      ON CONFLICT (project_id,worker_id) DO UPDATE SET active=true,updated_at=now(),updated_by=p_actor;
  ELSE
    UPDATE public.project_worker_assignments SET active=false,updated_at=now(),updated_by=p_actor
      WHERE project_id=p_project AND worker_id=p_worker AND active=true;
  END IF;
  RETURN jsonb_build_object('worker_id',p_worker,'active',p_active);
END;
$$;
REVOKE ALL ON FUNCTION public.set_project_worker_guarded(uuid,uuid,uuid,boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_project_worker_guarded(uuid,uuid,uuid,boolean) TO service_role;

CREATE FUNCTION public.create_project_worker_guarded(
  p_actor uuid,p_project uuid,p_request uuid,p_name text,p_position text,p_contact text,p_rate numeric,p_rate_type text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_previous app_private.project_worker_create_requests%ROWTYPE; v_fingerprint text;
BEGIN
  PERFORM app_private.lock_project_worker_access(p_actor,p_project);
  IF p_request IS NULL OR p_name IS NULL OR length(btrim(p_name)) NOT BETWEEN 2 AND 120
    OR p_position IS NULL OR length(btrim(p_position)) NOT BETWEEN 1 AND 120
    OR p_contact IS NULL OR length(btrim(p_contact)) > 100
    OR p_rate IS NULL OR p_rate < 0 OR p_rate > 99999999.99 OR p_rate <> trunc(p_rate,2)
    OR p_rate_type NOT IN ('daily','hourly') OR p_rate_type IS NULL THEN
    RAISE EXCEPTION 'Invalid worker details' USING ERRCODE='22023';
  END IF;
  v_fingerprint := md5(jsonb_build_array(btrim(p_name),btrim(p_position),btrim(p_contact),p_rate,p_rate_type)::text);
  PERFORM pg_advisory_xact_lock(hashtextextended('project-worker:' || p_request::text,0));
  SELECT * INTO v_previous FROM app_private.project_worker_create_requests WHERE request_id=p_request;
  IF FOUND THEN
    IF v_previous.actor_id IS DISTINCT FROM p_actor OR v_previous.project_id IS DISTINCT FROM p_project OR v_previous.fingerprint IS DISTINCT FROM v_fingerprint THEN
      RAISE EXCEPTION 'Registration request does not match' USING ERRCODE='22023';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.project_worker_assignments WHERE project_id=p_project AND worker_id=v_previous.worker_id AND active=true) THEN
      RAISE EXCEPTION 'Registration already completed; check project team' USING ERRCODE='22023';
    END IF;
    RETURN jsonb_build_object('worker_id',v_previous.worker_id,'replayed',true);
  END IF;
  -- A collision never updates an existing worker or their pay.
  INSERT INTO public.workers(id,name,position,contact_number,pay_rate,pay_rate_type,active)
    VALUES(p_request,btrim(p_name),btrim(p_position),COALESCE(NULLIF(btrim(p_contact),''),'—'),p_rate,p_rate_type,true);
  INSERT INTO public.project_worker_assignments(project_id,worker_id,active,updated_by)
    VALUES(p_project,p_request,true,p_actor);
  INSERT INTO app_private.project_worker_create_requests(request_id,actor_id,project_id,worker_id,fingerprint)
    VALUES(p_request,p_actor,p_project,p_request,v_fingerprint);
  RETURN jsonb_build_object('worker_id',p_request,'replayed',false);
END;
$$;
REVOKE ALL ON FUNCTION public.create_project_worker_guarded(uuid,uuid,uuid,text,text,text,numeric,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_project_worker_guarded(uuid,uuid,uuid,text,text,text,numeric,text) TO service_role;
