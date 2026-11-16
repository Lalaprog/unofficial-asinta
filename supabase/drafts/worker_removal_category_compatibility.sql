-- Repair the guarded archive routine after the category workforce cutover.
-- No worker or financial records are changed by this migration.
-- Run transactionally only after the exact assignment-history and category triggers exist.
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
LOCK TABLE public.workers, public.project_worker_assignments IN SHARE ROW EXCLUSIVE MODE;
DO $patch$
DECLARE
 v_def text;
 v_old text:=$old$  IF NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid='public.project_worker_assignments'::regclass AND t.tgname='record_project_assignment_history' AND t.tgfoid='public.record_project_assignment_history()'::regprocedure AND t.tgtype=29 AND t.tgenabled IN ('O','A') AND NOT t.tgisinternal)
    OR EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid IN ('public.workers'::regclass,'public.project_worker_assignments'::regclass) AND NOT t.tgisinternal AND t.tgenabled <> 'D' AND NOT (t.tgrelid='public.project_worker_assignments'::regclass AND t.tgname='record_project_assignment_history' AND t.tgfoid='public.record_project_assignment_history()'::regprocedure AND t.tgtype=29)) THEN
    RAISE EXCEPTION 'WORKER_REMOVAL_SCHEMA_REVIEW_REQUIRED' USING ERRCODE = 'P1002';
  END IF;$old$;
 v_new text:=$new$  -- Pin the trigger catalog until the archive transaction finishes. DDL that
  -- disables/replaces a trigger must wait, rather than racing the guard check.
  LOCK TABLE public.workers, public.project_worker_assignments IN ROW EXCLUSIVE MODE;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid='public.project_worker_assignments'::regclass AND t.tgname='record_project_assignment_history' AND t.tgfoid='public.record_project_assignment_history()'::regprocedure AND t.tgtype=29 AND t.tgenabled IN ('O','A') AND NOT t.tgisinternal AND t.tgqual IS NULL AND t.tgnargs=0 AND t.tgattr::text='')
    OR NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid='public.workers'::regclass AND t.tgname='bind_worker_category' AND t.tgfoid='public.bind_worker_category()'::regprocedure AND t.tgtype=23 AND t.tgenabled IN ('O','A') AND NOT t.tgisinternal AND t.tgqual IS NULL AND t.tgnargs=0 AND t.tgattr::text=(SELECT p.attnum::text || ' ' || c.attnum::text FROM pg_attribute p CROSS JOIN pg_attribute c WHERE p.attrelid=t.tgrelid AND p.attname='position' AND NOT p.attisdropped AND c.attrelid=t.tgrelid AND c.attname='category_id' AND NOT c.attisdropped))
    OR EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid IN ('public.workers'::regclass,'public.project_worker_assignments'::regclass) AND NOT t.tgisinternal AND t.tgenabled <> 'D' AND NOT ((t.tgrelid='public.project_worker_assignments'::regclass AND t.tgname='record_project_assignment_history' AND t.tgfoid='public.record_project_assignment_history()'::regprocedure AND t.tgtype=29) OR (t.tgrelid='public.workers'::regclass AND t.tgname='bind_worker_category' AND t.tgfoid='public.bind_worker_category()'::regprocedure AND t.tgtype=23))) THEN
    RAISE EXCEPTION 'WORKER_REMOVAL_SCHEMA_REVIEW_REQUIRED' USING ERRCODE = 'P1002';
  END IF;$new$;
BEGIN
 IF to_regprocedure('public.set_workers_removed_guarded(uuid,uuid[],boolean)') IS NULL OR to_regprocedure('public.record_project_assignment_history()') IS NULL OR to_regprocedure('public.bind_worker_category()') IS NULL THEN RAISE EXCEPTION 'Required archive/category/history functions missing'; END IF;
 SELECT pg_get_functiondef('public.set_workers_removed_guarded(uuid,uuid[],boolean)'::regprocedure) INTO v_def;
 IF position(v_old IN v_def)=0 OR length(v_def)-length(replace(v_def,v_old,''))<>length(v_old) THEN RAISE EXCEPTION 'Archive guard differs; review required'; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid='public.workers'::regclass AND t.tgname='bind_worker_category' AND t.tgfoid='public.bind_worker_category()'::regprocedure AND t.tgtype=23 AND t.tgenabled IN ('O','A') AND NOT t.tgisinternal AND t.tgqual IS NULL AND t.tgnargs=0 AND t.tgattr::text=(SELECT p.attnum::text || ' ' || c.attnum::text FROM pg_attribute p CROSS JOIN pg_attribute c WHERE p.attrelid=t.tgrelid AND p.attname='position' AND NOT p.attisdropped AND c.attrelid=t.tgrelid AND c.attname='category_id' AND NOT c.attisdropped)) THEN RAISE EXCEPTION 'Category trigger differs; review required'; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid='public.project_worker_assignments'::regclass AND t.tgname='record_project_assignment_history' AND t.tgfoid='public.record_project_assignment_history()'::regprocedure AND t.tgtype=29 AND t.tgenabled IN ('O','A') AND NOT t.tgisinternal AND t.tgqual IS NULL AND t.tgnargs=0 AND t.tgattr::text='') THEN RAISE EXCEPTION 'Assignment history trigger differs; review required'; END IF;
 IF EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid IN ('public.workers'::regclass,'public.project_worker_assignments'::regclass) AND NOT t.tgisinternal AND t.tgenabled <> 'D' AND t.tgname NOT IN ('bind_worker_category','record_project_assignment_history')) THEN RAISE EXCEPTION 'Additional triggers require review'; END IF;
 EXECUTE replace(v_def,v_old,v_new);
END $patch$;
