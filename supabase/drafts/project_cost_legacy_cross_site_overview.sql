-- HELD until the entire legacy attribution and review cutover is coordinated.
-- Combine legacy coverage and ordinary cross-site evidence in one snapshot so
-- an older split added between browser requests cannot be silently omitted.
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
DO $preflight$ BEGIN
 IF to_regprocedure('public.project_cost_legacy_cross_site_overview(uuid)') IS NOT NULL OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.project_cost_legacy_recorded_coverage(uuid)') AND md5(prosrc)='2bfdf3d979feebbdd4fd77a5d09e84c9' AND prosecdef AND provolatile='s') OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.project_cost_cross_site_overview(uuid)') AND md5(prosrc)='400f4c80ce4a6e5208df64fa3740a46d' AND NOT prosecdef AND provolatile='s') THEN RAISE EXCEPTION 'Legacy cross-site overview prerequisites differ or name collision'; END IF;
END $preflight$;
CREATE FUNCTION public.project_cost_legacy_cross_site_overview(p_project uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path='' AS $$
 SELECT jsonb_build_object('project_id',p_project,'legacy',public.project_cost_legacy_recorded_coverage(p_project),'ordinary',public.project_cost_cross_site_overview(p_project))
$$;
REVOKE ALL ON FUNCTION public.project_cost_legacy_cross_site_overview(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.project_cost_legacy_cross_site_overview(uuid) TO authenticated;
DO $postflight$ BEGIN
 IF has_function_privilege('anon','public.project_cost_legacy_cross_site_overview(uuid)','EXECUTE') OR has_function_privilege('service_role','public.project_cost_legacy_cross_site_overview(uuid)','EXECUTE') OR NOT has_function_privilege('authenticated','public.project_cost_legacy_cross_site_overview(uuid)','EXECUTE') OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.project_cost_legacy_cross_site_overview(uuid)'::regprocedure AND NOT prosecdef AND provolatile='s' AND proconfig @> ARRAY['search_path=""']) THEN RAISE EXCEPTION 'Unexpected legacy cross-site overview privileges'; END IF;
END $postflight$;
