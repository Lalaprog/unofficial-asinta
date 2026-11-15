-- HELD, read-only candidate for the simple recorded-cost overview.
-- The two existing bounded readers run in one PostgreSQL statement snapshot.
-- This does not classify an expense, post a cost, settle a correction or
-- establish that business records are complete. Install only after checking
-- the target's existing functions and permissions; never replay older bundles.
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
DO $preflight$ BEGIN
 IF to_regprocedure('public.project_cost_recorded_coverage(uuid)') IS NULL OR to_regprocedure('public.project_cost_correction_inventory(uuid)') IS NULL OR to_regprocedure('public.project_recorded_cost_snapshot(uuid)') IS NOT NULL THEN RAISE EXCEPTION 'Recorded cost snapshot prerequisites missing or name collision'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.project_cost_recorded_coverage(uuid)'::regprocedure AND md5(prosrc)='95fa4a3a6f8d212b319e0fbde7be4df9' AND prosecdef AND provolatile='s') OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.project_cost_correction_inventory(uuid)'::regprocedure AND md5(prosrc)='77d2de8f891678789ec4ffc1fdf34079' AND prosecdef AND provolatile='s') THEN RAISE EXCEPTION 'Recorded cost snapshot prerequisites differ from reviewed definitions'; END IF;
END $preflight$;
CREATE FUNCTION public.project_recorded_cost_snapshot(p_project uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path='' AS $$
 SELECT jsonb_build_object('project_id',p_project,'coverage',public.project_cost_recorded_coverage(p_project),'inventory',public.project_cost_correction_inventory(p_project))
$$;
REVOKE ALL ON FUNCTION public.project_recorded_cost_snapshot(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.project_recorded_cost_snapshot(uuid) TO authenticated;
DO $postflight$ BEGIN
 IF has_function_privilege('anon','public.project_recorded_cost_snapshot(uuid)','EXECUTE') OR has_function_privilege('service_role','public.project_recorded_cost_snapshot(uuid)','EXECUTE') OR NOT has_function_privilege('authenticated','public.project_recorded_cost_snapshot(uuid)','EXECUTE') OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.project_recorded_cost_snapshot(uuid)'::regprocedure AND NOT prosecdef AND provolatile='s' AND proconfig @> ARRAY['search_path=""']) THEN RAISE EXCEPTION 'Unexpected recorded cost snapshot privileges'; END IF;
END $postflight$;
