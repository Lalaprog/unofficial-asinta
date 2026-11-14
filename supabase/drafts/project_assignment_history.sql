-- UNINSTALLED DRAFT ONLY: apply as a single reviewed transaction, not alone.
-- Existing assignment rows reveal only their CURRENT state, not prior intervals.
-- Installation records a baseline observation, never fabricates past start/end.
-- Exact live catalog, privileged clients, removal guard, recovery and project
-- deletion behavior must be reviewed before any deployment.
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
DO $$ BEGIN
 IF to_regclass('public.project_worker_assignments') IS NULL OR to_regclass('public.workers') IS NULL OR to_regclass('public.projects') IS NULL OR to_regprocedure('public.set_workers_removed_guarded(uuid,uuid[],boolean)') IS NULL OR to_regprocedure('public.is_founder()') IS NULL OR to_regprocedure('public.session_assurance_satisfied()') IS NULL OR to_regprocedure('auth.uid()') IS NULL THEN RAISE EXCEPTION 'Assignment history prerequisites missing'; END IF;
 IF to_regclass('public.project_assignment_history') IS NOT NULL OR to_regprocedure('public.record_project_assignment_history()') IS NOT NULL OR to_regprocedure('public.guard_assignment_history_immutable()') IS NOT NULL OR to_regprocedure('public.founder_assignment_history(uuid,timestamp with time zone,uuid,integer)') IS NOT NULL THEN RAISE EXCEPTION 'Assignment history objects already exist'; END IF;
 -- Match existing worker-removal and assignment lock order. This also ensures
 -- no assignment transition occurs between the baseline and trigger creation.
 LOCK TABLE public.workers IN SHARE ROW EXCLUSIVE MODE;
 LOCK TABLE public.project_worker_assignments IN SHARE ROW EXCLUSIVE MODE;
 IF EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid IN ('public.workers'::regclass,'public.project_worker_assignments'::regclass) AND NOT tgisinternal AND tgenabled<>'D') THEN RAISE EXCEPTION 'Existing worker/assignment triggers require review'; END IF;
END $$;
CREATE TABLE public.project_assignment_history (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE RESTRICT,
 worker_id uuid NOT NULL REFERENCES public.workers(id) ON DELETE RESTRICT,
 event_type text NOT NULL CHECK(event_type IN ('baseline_active','baseline_inactive','assigned','unassigned')),
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 actor_id uuid,
 CHECK((event_type LIKE 'baseline_%' AND actor_id IS NULL) OR event_type IN ('assigned','unassigned'))
);
CREATE INDEX project_assignment_history_worker_order_idx ON public.project_assignment_history(worker_id,occurred_at DESC,id DESC);
ALTER TABLE public.project_assignment_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.project_assignment_history FROM PUBLIC,anon,authenticated,service_role;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r(role_name) WHERE has_table_privilege(r.role_name,'public.project_assignment_history','SELECT,INSERT,UPDATE,DELETE,TRUNCATE') OR EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid='public.project_assignment_history'::regclass AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege(r.role_name,a.attrelid,a.attname,'SELECT,INSERT,UPDATE'))) THEN RAISE EXCEPTION 'Unexpected inherited assignment history privilege'; END IF;
END $$;
-- All baseline rows share an observation instant; created_at/updated_at on the
-- old row do not prove a complete interval or even who originally assigned it.
INSERT INTO public.project_assignment_history(project_id,worker_id,event_type,occurred_at)
 SELECT project_id,worker_id,CASE WHEN active THEN 'baseline_active' ELSE 'baseline_inactive' END,statement_timestamp() FROM public.project_worker_assignments;
CREATE FUNCTION public.guard_assignment_history_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$ BEGIN RAISE EXCEPTION 'Assignment history is immutable' USING ERRCODE='23514'; END $$;
REVOKE ALL ON FUNCTION public.guard_assignment_history_immutable() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER guard_assignment_history_immutable BEFORE UPDATE OR DELETE ON public.project_assignment_history FOR EACH ROW EXECUTE FUNCTION public.guard_assignment_history_immutable();
CREATE FUNCTION public.record_project_assignment_history() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Assignment rows must not be deleted; preserve history' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' AND (NEW.worker_id,NEW.project_id) IS DISTINCT FROM (OLD.worker_id,OLD.project_id) THEN RAISE EXCEPTION 'Assignment identities are immutable' USING ERRCODE='23514'; END IF;
 IF NEW.active IS NULL THEN RAISE EXCEPTION 'Assignment state required' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' OR NEW.active IS DISTINCT FROM OLD.active THEN
  INSERT INTO public.project_assignment_history(project_id,worker_id,event_type,actor_id) VALUES(NEW.project_id,NEW.worker_id,CASE WHEN NEW.active THEN 'assigned' ELSE 'unassigned' END,NEW.updated_by);
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.record_project_assignment_history() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER record_project_assignment_history AFTER INSERT OR UPDATE OR DELETE ON public.project_worker_assignments FOR EACH ROW EXECUTE FUNCTION public.record_project_assignment_history();

-- The installed archive routine deliberately rejects any active worker or
-- assignment trigger. Permit ONLY the exact history trigger, while preserving
-- the check against all other triggers. Refuse unfamiliar function bodies.
DO $patch$
DECLARE v_def text;v_old text:=$old$  IF EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid IN ('public.workers'::regclass,'public.project_worker_assignments'::regclass) AND NOT t.tgisinternal AND t.tgenabled <> 'D') THEN
    RAISE EXCEPTION 'WORKER_REMOVAL_SCHEMA_REVIEW_REQUIRED' USING ERRCODE = 'P1002';
  END IF;$old$;
 v_new text:=$new$  IF NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid='public.project_worker_assignments'::regclass AND t.tgname='record_project_assignment_history' AND t.tgfoid='public.record_project_assignment_history()'::regprocedure AND t.tgtype=29 AND t.tgenabled IN ('O','A') AND NOT t.tgisinternal)
    OR EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid IN ('public.workers'::regclass,'public.project_worker_assignments'::regclass) AND NOT t.tgisinternal AND t.tgenabled <> 'D' AND NOT (t.tgrelid='public.project_worker_assignments'::regclass AND t.tgname='record_project_assignment_history' AND t.tgfoid='public.record_project_assignment_history()'::regprocedure AND t.tgtype=29)) THEN
    RAISE EXCEPTION 'WORKER_REMOVAL_SCHEMA_REVIEW_REQUIRED' USING ERRCODE = 'P1002';
  END IF;$new$;
BEGIN
 SELECT pg_get_functiondef('public.set_workers_removed_guarded(uuid,uuid[],boolean)'::regprocedure) INTO v_def;
 IF position(v_old IN v_def)=0 OR length(v_def)-length(replace(v_def,v_old,''))<>length(v_old) THEN RAISE EXCEPTION 'Removal guard differs; manual review required'; END IF;
 EXECUTE replace(v_def,v_old,v_new);
END $patch$;

-- Founder-only paging across one worker. Supervisors are not given a worker's
-- cross-site history. Baseline values are observations, not inferred start dates.
CREATE FUNCTION public.founder_assignment_history(p_worker uuid,p_cursor_at timestamptz DEFAULT NULL,p_cursor_id uuid DEFAULT NULL,p_limit integer DEFAULT 25)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_result jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access required' USING ERRCODE='42501'; END IF;
 IF p_worker IS NULL OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 OR (p_cursor_at IS NULL)<>(p_cursor_id IS NULL) OR (p_cursor_at IS NOT NULL AND NOT isfinite(p_cursor_at)) THEN RAISE EXCEPTION 'Invalid history cursor' USING ERRCODE='22023'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.workers WHERE id=p_worker) THEN RAISE EXCEPTION 'Worker unavailable' USING ERRCODE='42501'; END IF;
 WITH rows AS MATERIALIZED (SELECT h.*,p.name project_name FROM public.project_assignment_history h JOIN public.projects p ON p.id=h.project_id WHERE h.worker_id=p_worker AND (p_cursor_at IS NULL OR (h.occurred_at,h.id)<(p_cursor_at,p_cursor_id)) ORDER BY h.occurred_at DESC,h.id DESC LIMIT p_limit+1),
 page AS (SELECT * FROM rows ORDER BY occurred_at DESC,id DESC LIMIT p_limit)
 SELECT jsonb_build_object('worker_id',p_worker,'has_more',(SELECT count(*)>p_limit FROM rows),'items',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'project_id',project_id,'project_name',project_name,'event_type',event_type,'occurred_at',occurred_at,'actor_id',actor_id) ORDER BY occurred_at DESC,id DESC) FROM page),'[]'::jsonb)) INTO v_result;
 IF octet_length(v_result::text)>1048576 THEN RAISE EXCEPTION 'Assignment history too large' USING ERRCODE='54000'; END IF;RETURN v_result;
END $$;
REVOKE ALL ON FUNCTION public.founder_assignment_history(uuid,timestamptz,uuid,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.founder_assignment_history(uuid,timestamptz,uuid,integer) TO authenticated;
DO $$ BEGIN IF has_function_privilege('anon','public.founder_assignment_history(uuid,timestamptz,uuid,integer)','EXECUTE') OR has_function_privilege('service_role','public.founder_assignment_history(uuid,timestamptz,uuid,integer)','EXECUTE') THEN RAISE EXCEPTION 'Unexpected inherited history function privileges'; END IF; END $$;
