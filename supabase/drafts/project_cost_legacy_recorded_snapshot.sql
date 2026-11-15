-- HELD: one point-in-time snapshot for simple recorded costs when the
-- older-voucher feature is also enabled. The client must withhold the simple
-- amount if an older split or incoming legacy correction affects this site.
-- No financial records are changed. Install only as part of a coordinated
-- legacy cutover after verifying the exact target functions and permissions.
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
DO $preflight$ BEGIN
 IF to_regprocedure('public.project_cost_legacy_recorded_snapshot(uuid)') IS NOT NULL
 OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.project_cost_legacy_recorded_coverage(uuid)') AND md5(prosrc)='2bfdf3d979feebbdd4fd77a5d09e84c9' AND prosecdef AND provolatile='s')
 OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.project_recorded_cost_snapshot(uuid)') AND md5(prosrc)='a470f6a602c2327dd80ed477551dea7a' AND NOT prosecdef AND provolatile='s') THEN RAISE EXCEPTION 'Legacy recorded snapshot prerequisites differ or name collision'; END IF;
END $preflight$;
CREATE FUNCTION public.project_cost_legacy_recorded_snapshot(p_project uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path='' AS $$
 SELECT jsonb_build_object('project_id',p_project,'legacy',public.project_cost_legacy_recorded_coverage(p_project),'ordinary',public.project_recorded_cost_snapshot(p_project))
$$;
REVOKE ALL ON FUNCTION public.project_cost_legacy_recorded_snapshot(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.project_cost_legacy_recorded_snapshot(uuid) TO authenticated;
DO $postflight$ BEGIN
 IF has_function_privilege('anon','public.project_cost_legacy_recorded_snapshot(uuid)','EXECUTE') OR has_function_privilege('service_role','public.project_cost_legacy_recorded_snapshot(uuid)','EXECUTE') OR NOT has_function_privilege('authenticated','public.project_cost_legacy_recorded_snapshot(uuid)','EXECUTE') OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.project_cost_legacy_recorded_snapshot(uuid)'::regprocedure AND NOT prosecdef AND provolatile='s' AND proconfig @> ARRAY['search_path=""']) THEN RAISE EXCEPTION 'Unexpected legacy recorded snapshot privileges'; END IF;
END $postflight$;
