-- EXPERIMENTAL, UNINSTALLED, NOT A RELEASE MIGRATION. Requires the separately
-- reviewed assignment-history draft and existing guarded assignment writer.
-- A move is one transaction with two history events, not an effective-dated
-- schedule or a reconstruction of earlier site history. Do not apply alone.
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
DO $preflight$
BEGIN
 IF to_regclass('public.project_assignment_history') IS NULL OR to_regclass('public.project_worker_assignments') IS NULL OR to_regclass('public.workers') IS NULL OR to_regclass('public.users') IS NULL OR to_regclass('public.projects') IS NULL OR to_regprocedure('public.record_project_assignment_history()') IS NULL OR to_regprocedure('public.set_project_worker_guarded(uuid,uuid,uuid,boolean)') IS NULL OR to_regprocedure('public.is_founder()') IS NULL OR to_regprocedure('public.session_assurance_satisfied()') IS NULL OR to_regprocedure('auth.uid()') IS NULL THEN RAISE EXCEPTION 'Atomic move prerequisites missing'; END IF;
 IF to_regclass('public.worker_move_requests') IS NOT NULL OR to_regprocedure('public.move_worker_project(uuid,uuid,uuid,uuid)') IS NOT NULL THEN RAISE EXCEPTION 'Atomic move objects already exist'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid='public.project_worker_assignments'::regclass AND tgname='record_project_assignment_history' AND tgfoid='public.record_project_assignment_history()'::regprocedure AND tgtype=29 AND tgenabled IN ('O','A') AND NOT tgisinternal) THEN RAISE EXCEPTION 'Assignment history trigger unavailable'; END IF;
END;
$preflight$;
CREATE TABLE public.worker_move_requests (
 request_id uuid PRIMARY KEY,
 actor_id uuid NOT NULL,
 worker_id uuid NOT NULL REFERENCES public.workers(id) ON DELETE RESTRICT,
 from_project uuid NOT NULL REFERENCES public.projects(id) ON DELETE RESTRICT,
 to_project uuid NOT NULL REFERENCES public.projects(id) ON DELETE RESTRICT,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(from_project<>to_project)
);
ALTER TABLE public.worker_move_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.worker_move_requests FROM PUBLIC,anon,authenticated,service_role;
DO $acl$
BEGIN
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r(role_name) WHERE has_table_privilege(r.role_name,'public.worker_move_requests','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid='public.worker_move_requests'::regclass AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege(r.role_name,a.attrelid,a.attname,'SELECT,INSERT,UPDATE'))) THEN RAISE EXCEPTION 'Unexpected inherited move-table access'; END IF;
END;
$acl$;
CREATE FUNCTION public.move_worker_project(p_request uuid,p_worker uuid,p_from uuid,p_to uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid:=auth.uid(); v_previous public.worker_move_requests%ROWTYPE; v_active boolean;v_count integer;
BEGIN
 IF v_actor IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access required' USING ERRCODE='42501'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Worker moves require read committed' USING ERRCODE='P1002'; END IF;
 IF p_request IS NULL OR p_worker IS NULL OR p_from IS NULL OR p_to IS NULL OR p_from=p_to THEN RAISE EXCEPTION 'Invalid worker move' USING ERRCODE='22023'; END IF;
 -- Actor pin, request serialization, deterministic project ordering, worker.
 PERFORM 1 FROM public.users WHERE id=v_actor AND role='founder' FOR SHARE;
 IF NOT FOUND OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access required' USING ERRCODE='42501'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('worker-move:'||p_request::text,0));
 SELECT * INTO v_previous FROM public.worker_move_requests WHERE request_id=p_request;
 IF FOUND THEN
  IF (v_previous.actor_id,v_previous.worker_id,v_previous.from_project,v_previous.to_project) IS DISTINCT FROM (v_actor,p_worker,p_from,p_to) THEN RAISE EXCEPTION 'Request ID already used for another move' USING ERRCODE='22023'; END IF;
  RETURN jsonb_build_object('request_id',p_request,'worker_id',p_worker,'from_project',p_from,'to_project',p_to,'replayed',true);
 END IF;
 -- Block trigger disabling while this move checks and writes its history.
 LOCK TABLE public.project_worker_assignments IN ROW SHARE MODE;
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid='public.project_worker_assignments'::regclass AND tgname='record_project_assignment_history' AND tgfoid='public.record_project_assignment_history()'::regprocedure AND tgtype=29 AND tgenabled IN ('O','A') AND NOT tgisinternal) THEN RAISE EXCEPTION 'Assignment history trigger unavailable' USING ERRCODE='P1002'; END IF;
 PERFORM 1 FROM public.projects WHERE id IN (p_from,p_to) ORDER BY id FOR KEY SHARE;
 GET DIAGNOSTICS v_count=ROW_COUNT;
 IF v_count<>2 THEN RAISE EXCEPTION 'Project unavailable' USING ERRCODE='22023'; END IF;
 SELECT active INTO v_active FROM public.workers WHERE id=p_worker FOR UPDATE;
 IF NOT FOUND OR v_active IS NOT TRUE OR EXISTS(SELECT 1 FROM public.users WHERE id=p_worker AND role='supervisor') THEN RAISE EXCEPTION 'Regular active worker required' USING ERRCODE='22023'; END IF;
 IF (SELECT count(*) FROM public.project_worker_assignments WHERE worker_id=p_worker AND active)<>1 OR NOT EXISTS(SELECT 1 FROM public.project_worker_assignments WHERE worker_id=p_worker AND project_id=p_from AND active) THEN
  RAISE EXCEPTION 'Worker assignment changed; refresh and review' USING ERRCODE='40001'; END IF;
 PERFORM public.set_project_worker_guarded(v_actor,p_from,p_worker,false);
 PERFORM public.set_project_worker_guarded(v_actor,p_to,p_worker,true);
 INSERT INTO public.worker_move_requests(request_id,actor_id,worker_id,from_project,to_project) VALUES(p_request,v_actor,p_worker,p_from,p_to);
 RETURN jsonb_build_object('request_id',p_request,'worker_id',p_worker,'from_project',p_from,'to_project',p_to,'replayed',false);
END;
$$;
REVOKE ALL ON FUNCTION public.move_worker_project(uuid,uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.move_worker_project(uuid,uuid,uuid,uuid) TO authenticated;
DO $function_acl$
BEGIN
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['anon','service_role']) r(role_name) WHERE has_function_privilege(r.role_name,'public.move_worker_project(uuid,uuid,uuid,uuid)','EXECUTE')) OR NOT has_function_privilege('authenticated','public.move_worker_project(uuid,uuid,uuid,uuid)','EXECUTE') THEN RAISE EXCEPTION 'Unexpected atomic-move function access'; END IF;
END;
$function_acl$;
