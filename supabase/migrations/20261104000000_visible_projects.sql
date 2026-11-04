-- Phase 1: additive. Deploy this read function before the matching app.
-- It does not by itself restrict existing direct table access.
CREATE OR REPLACE FUNCTION public.visible_projects()
RETURNS TABLE (
  id uuid, name text, client_id uuid, location text, budget_estimate numeric,
  status text, start_date date, target_completion_date date, created_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT p.id, p.name,
         CASE WHEN public.is_founder() THEN p.client_id ELSE NULL END,
         p.location,
         CASE WHEN public.is_founder() THEN p.budget_estimate ELSE NULL END,
         p.status, p.start_date, p.target_completion_date, p.created_at
  FROM public.projects AS p
  WHERE auth.uid() IS NOT NULL
    AND (public.is_founder() OR public.is_supervisor_assigned(p.id));
$$;
REVOKE ALL ON FUNCTION public.visible_projects() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.visible_projects() TO authenticated;
