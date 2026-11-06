-- Project assignments are replaced in one transaction, not a delete followed
-- by a separate insert. Caller authorization is verified by the server and
-- again under the same team-profile guard used by profile changes.
CREATE OR REPLACE FUNCTION public.replace_supervisor_projects_guarded(
  p_actor uuid, p_target uuid, p_projects uuid[]
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_projects uuid[];
BEGIN
  PERFORM app_private.lock_founder_guard();
  IF NOT EXISTS (SELECT 1 FROM public.users WHERE id=p_actor AND role='founder') THEN
    RAISE EXCEPTION 'Founder access is required.' USING ERRCODE='42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.users WHERE id=p_target AND role='supervisor' FOR UPDATE) THEN
    RAISE EXCEPTION 'Supervisor account not found.' USING ERRCODE='22023';
  END IF;
  IF p_projects IS NULL OR cardinality(p_projects)>1000 OR array_position(p_projects, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'Invalid project list.' USING ERRCODE='22023';
  END IF;
  SELECT coalesce(array_agg(DISTINCT p ORDER BY p), ARRAY[]::uuid[]) INTO v_projects FROM unnest(p_projects) p;
  -- Prevent project deletion between validation and insertion.
  PERFORM id FROM public.projects WHERE id=ANY(v_projects) ORDER BY id FOR KEY SHARE;
  IF (SELECT count(*) FROM public.projects WHERE id=ANY(v_projects)) <> cardinality(v_projects) THEN
    RAISE EXCEPTION 'One or more projects are unavailable.' USING ERRCODE='22023';
  END IF;
  DELETE FROM public.project_supervisors WHERE supervisor_id=p_target AND NOT (project_id=ANY(v_projects));
  INSERT INTO public.project_supervisors (project_id, supervisor_id)
    SELECT p, p_target FROM unnest(v_projects) p ON CONFLICT (project_id,supervisor_id) DO NOTHING;
  RETURN jsonb_build_object('project_count',cardinality(v_projects));
END;
$$;
REVOKE ALL ON FUNCTION public.replace_supervisor_projects_guarded(uuid,uuid,uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.replace_supervisor_projects_guarded(uuid,uuid,uuid[]) TO service_role;
