-- UNINSTALLED EXPERIMENTAL DRAFT. NOT a standalone deployment or migration.
-- Prevent Supervisor Roll Call writes for workers outside their current site.
-- Founder backfill for regular workers is unchanged. Linked Supervisor site
-- attendance is read-only: new daily attendance uses the general-day workflow.
-- Existing historical records are retained, not converted or deleted.
-- Current assignments are not historical intervals. After a worker moves,
-- historical edits by the former Supervisor require Founder review/backfill.
-- Auth-less/service/owner attendance writes are blocked by this trigger and
-- need a separate reviewed maintenance design; do not apply to a shared host.
-- The lock order and legacy/upsert clients need full cutover/load review.
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
DO $preflight$
BEGIN
 IF pg_catalog.to_regclass('public.attendance') IS NULL OR pg_catalog.to_regclass('public.users') IS NULL
 OR pg_catalog.to_regclass('public.projects') IS NULL OR pg_catalog.to_regclass('public.workers') IS NULL
 OR pg_catalog.to_regclass('public.project_supervisors') IS NULL OR pg_catalog.to_regclass('public.project_worker_assignments') IS NULL
 OR pg_catalog.to_regprocedure('auth.uid()') IS NULL OR pg_catalog.to_regprocedure('public.session_assurance_satisfied()') IS NULL
 OR pg_catalog.to_regprocedure('public.is_founder()') IS NULL OR pg_catalog.to_regprocedure('public.is_supervisor_assigned(uuid)') IS NULL THEN
  RAISE EXCEPTION 'Attendance guard prerequisites missing'; END IF;
 IF pg_catalog.to_regprocedure('public.guard_attendance_assignment()') IS NOT NULL OR EXISTS
  (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid='public.attendance'::regclass AND tgname='guard_attendance_assignment' AND NOT tgisinternal) THEN
  RAISE EXCEPTION 'Attendance guard objects already exist'; END IF;
 IF NOT (SELECT relrowsecurity AND relkind='r' FROM pg_catalog.pg_class WHERE oid='public.attendance'::regclass) THEN
  RAISE EXCEPTION 'Attendance table must have RLS'; END IF;
END;
$preflight$;
CREATE FUNCTION public.guard_attendance_assignment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid:=auth.uid();v_role text;v_target_role text;v_old_role text;v_active boolean;
BEGIN
 IF v_actor IS NULL OR NOT coalesce(public.session_assurance_satisfied(),false) THEN
  RAISE EXCEPTION 'Attendance access required' USING ERRCODE='42501'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION 'Attendance writes require read committed isolation' USING ERRCODE='P1002'; END IF;
 -- Match guarded assignment lock order: actor, project, authorization, worker.
 SELECT role INTO v_role FROM public.users WHERE id=v_actor FOR SHARE;
 -- Pin a linked target account while checking its role, including Founder writes.
 -- Preserve old site rows as evidence, but do not create or alter them once
 -- the general daily-attendance cutover is active.
 SELECT role INTO v_target_role FROM public.users WHERE id=NEW.worker_id FOR SHARE;
 IF TG_OP='UPDATE' AND OLD.worker_id IS DISTINCT FROM NEW.worker_id THEN
  SELECT role INTO v_old_role FROM public.users WHERE id=OLD.worker_id FOR SHARE;
 END IF;
 IF v_target_role='supervisor' OR v_old_role='supervisor' THEN
  RAISE EXCEPTION 'Supervisor site attendance is read-only; use general daily attendance' USING ERRCODE='22023'; END IF;
 IF v_role='founder' AND coalesce(public.is_founder(),false) AND coalesce(public.session_assurance_satisfied(),false) THEN RETURN NEW; END IF;
 IF v_role IS DISTINCT FROM 'supervisor' OR NOT coalesce(public.session_assurance_satisfied(),false) THEN
  RAISE EXCEPTION 'Attendance access required' USING ERRCODE='42501'; END IF;
 IF TG_OP='UPDATE' AND (NEW.worker_id,NEW.project_id,NEW.date) IS DISTINCT FROM (OLD.worker_id,OLD.project_id,OLD.date) THEN
  RAISE EXCEPTION 'Attendance identity cannot be changed by a Supervisor' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM public.projects WHERE id=NEW.project_id FOR KEY SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Attendance access required' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM public.project_supervisors WHERE project_id=NEW.project_id AND supervisor_id=v_actor FOR KEY SHARE;
 IF NOT FOUND OR NOT coalesce(public.is_supervisor_assigned(NEW.project_id),false) THEN
  RAISE EXCEPTION 'Attendance access required' USING ERRCODE='42501'; END IF;
 SELECT active INTO v_active FROM public.workers WHERE id=NEW.worker_id FOR UPDATE;
 IF NOT FOUND OR v_active IS NOT TRUE THEN RAISE EXCEPTION 'Worker unavailable' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM public.users WHERE id=NEW.worker_id AND role='supervisor')
 OR NOT EXISTS(SELECT 1 FROM public.project_worker_assignments WHERE worker_id=NEW.worker_id AND project_id=NEW.project_id AND active=true)
 OR EXISTS(SELECT 1 FROM public.project_worker_assignments WHERE worker_id=NEW.worker_id AND project_id<>NEW.project_id AND active=true) THEN
  RAISE EXCEPTION 'Worker must have one active assignment at the selected site' USING ERRCODE='22023'; END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_attendance_assignment() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER guard_attendance_assignment BEFORE INSERT OR UPDATE ON public.attendance
 FOR EACH ROW EXECUTE FUNCTION public.guard_attendance_assignment();
DO $postflight$
BEGIN
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r(role_name)
  WHERE pg_catalog.has_function_privilege(r.role_name,'public.guard_attendance_assignment()','EXECUTE')) THEN
  RAISE EXCEPTION 'Attendance guard function exposed through inherited privileges'; END IF;
END;
$postflight$;
