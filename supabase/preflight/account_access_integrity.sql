-- READ ONLY: aggregate identity/access linkage for the connected deployment.
-- Run only where auth.users, public.users, public.projects and
-- public.project_supervisors exist. Returns counts, never credentials or IDs.
-- A clean result does not prove authentication, MFA, RLS, authorization, or
-- suitability of a cleanup. Never modify Auth tables to perform a reset.
SELECT jsonb_build_object(
  'auth_users', (SELECT count(*) FROM auth.users),
  'app_profiles', (SELECT count(*) FROM public.users),
  'auth_without_profile', (SELECT count(*) FROM auth.users a LEFT JOIN public.users p ON p.id = a.id WHERE p.id IS NULL),
  'profiles_without_auth', (SELECT count(*) FROM public.users p LEFT JOIN auth.users a ON a.id = p.id WHERE a.id IS NULL),
  'profile_roles', (SELECT coalesce(jsonb_object_agg(role, n), '{}'::jsonb) FROM (SELECT role, count(*) AS n FROM public.users GROUP BY role) r),
  'supervisor_project_links', (SELECT count(*) FROM public.project_supervisors),
  'supervisor_links_with_missing_project', (SELECT count(*) FROM public.project_supervisors s LEFT JOIN public.projects p ON p.id = s.project_id WHERE p.id IS NULL),
  'supervisor_links_with_missing_profile', (SELECT count(*) FROM public.project_supervisors s LEFT JOIN public.users u ON u.id = s.supervisor_id WHERE u.id IS NULL),
  'supervisor_links_with_non_supervisor_profile', (SELECT count(*) FROM public.project_supervisors s JOIN public.users u ON u.id = s.supervisor_id WHERE u.role IS DISTINCT FROM 'supervisor')
) AS account_integrity_summary;
