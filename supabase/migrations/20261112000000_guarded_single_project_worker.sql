-- Do not alter existing assignments. All ordinary assignment writes go through
-- service-only guarded functions; authenticated clients have SELECT only.
-- A worker row lock serializes assignment and archive/restore operations.
CREATE OR REPLACE FUNCTION public.set_project_worker_guarded(p_actor uuid,p_project uuid,p_worker uuid,p_active boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_worker_active boolean; v_is_supervisor boolean;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'ASSIGNMENT_REQUIRES_READ_COMMITTED' USING ERRCODE='P1002';
  END IF;
  PERFORM app_private.lock_project_worker_access(p_actor,p_project);
  IF p_active IS NULL THEN RAISE EXCEPTION 'Invalid assignment' USING ERRCODE='22023'; END IF;
  SELECT active INTO v_worker_active FROM public.workers WHERE id=p_worker FOR UPDATE;
  IF NOT FOUND OR (p_active AND v_worker_active IS NOT TRUE) THEN RAISE EXCEPTION 'Worker unavailable' USING ERRCODE='22023'; END IF;
  IF p_active THEN
    -- Supervisors are attached to sites through project_supervisors and must
    -- remain able to hold multiple projects. Identity is based on the linked
    -- account UUID, not a free-text position or name.
    SELECT EXISTS(SELECT 1 FROM public.users WHERE id=p_worker AND role='supervisor') INTO v_is_supervisor;
    IF NOT v_is_supervisor AND EXISTS (
      SELECT 1 FROM public.project_worker_assignments
      WHERE worker_id=p_worker AND active=true AND project_id<>p_project
    ) THEN
      RAISE EXCEPTION 'Worker already has an active project' USING ERRCODE='P1003';
    END IF;
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

-- Return only the minimum fields of available workers; never expose another
-- site's assignments. Do not depend on the shared store's possibly truncated list.
CREATE FUNCTION public.available_project_workers_guarded(p_actor uuid,p_project uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_ids jsonb;
BEGIN
  PERFORM app_private.lock_project_worker_access(p_actor,p_project);
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',w.id,'name',w.name,'position',w.position,'contact_number',w.contact_number) ORDER BY w.name,w.id), '[]'::jsonb) INTO v_ids
    FROM public.workers w
    WHERE w.active=true
      AND NOT EXISTS (SELECT 1 FROM public.project_worker_assignments a WHERE a.worker_id=w.id AND a.active=true)
      AND NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id=w.id AND u.role='supervisor');
  RETURN v_ids;
END;
$$;
REVOKE ALL ON FUNCTION public.available_project_workers_guarded(uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.available_project_workers_guarded(uuid,uuid) TO service_role;
