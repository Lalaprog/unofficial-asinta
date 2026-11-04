-- Phase 2: breaking access change. Apply only after the app using
-- visible_projects() is deployed and users have refreshed. See rollout guide.
-- Refuse to remove direct access if the replacement function is not ready.
DO $$
BEGIN
  IF to_regprocedure('public.visible_projects()') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.visible_projects()') AND prosecdef)
     OR NOT coalesce(has_function_privilege('authenticated',to_regprocedure('public.visible_projects()'),'EXECUTE'),false)
     OR coalesce(has_function_privilege('anon',to_regprocedure('public.visible_projects()'),'EXECUTE'),true) THEN
    RAISE EXCEPTION 'Install and verify visible_projects before restricting project columns.';
  END IF;
END $$;
-- Revoking a table grant does not remove independent column-level grants.
REVOKE SELECT ON public.projects FROM PUBLIC, anon, authenticated;
REVOKE SELECT (id, name, client_id, location, budget_estimate, status, start_date, target_completion_date, created_at)
  ON public.projects FROM PUBLIC, anon, authenticated;
GRANT SELECT (id, name, location, status, start_date, target_completion_date, created_at)
  ON public.projects TO authenticated;
