-- Candidate: retain the craft observed when a new attendance row or voucher is
-- inserted. This does NOT assert that the craft was correct on the work date,
-- especially for backfills, or invent observations for pre-existing rows.
-- Requires reviewed category/attendance/payroll cutovers. One transaction only.
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
LOCK TABLE public.workers, public.attendance, public.payroll IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN
 IF to_regclass('public.attendance_craft_observations') IS NOT NULL OR to_regclass('public.payroll_craft_observations') IS NOT NULL OR to_regprocedure('public.capture_recorded_craft()') IS NOT NULL OR to_regprocedure('public.guard_recorded_craft_immutable()') IS NOT NULL THEN RAISE EXCEPTION 'Craft observation objects already exist'; END IF;
 IF NOT coalesce((SELECT relrowsecurity FROM pg_class WHERE oid='public.attendance'::regclass),false) OR NOT coalesce((SELECT relrowsecurity FROM pg_class WHERE oid='public.payroll'::regclass),false) OR NOT has_table_privilege('authenticated','public.attendance','SELECT') OR NOT has_table_privilege('authenticated','public.payroll','SELECT') THEN RAISE EXCEPTION 'Reviewed source permissions required'; END IF;
END $$;
-- Separate FKs deliberately preserve observations with their source records.
CREATE TABLE public.attendance_craft_observations (
 attendance_id uuid PRIMARY KEY REFERENCES public.attendance(id) ON DELETE RESTRICT,
 worker_id uuid NOT NULL REFERENCES public.workers(id) ON DELETE RESTRICT,
 craft text NOT NULL CHECK (length(craft) BETWEEN 1 AND 80),
 captured_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE public.payroll_craft_observations (
 payroll_id uuid PRIMARY KEY REFERENCES public.payroll(id) ON DELETE RESTRICT,
 worker_id uuid NOT NULL REFERENCES public.workers(id) ON DELETE RESTRICT,
 craft text NOT NULL CHECK (length(craft) BETWEEN 1 AND 80),
 captured_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.attendance_craft_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_craft_observations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.attendance_craft_observations,public.payroll_craft_observations FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.attendance_craft_observations,public.payroll_craft_observations TO authenticated;
-- Reading an observation requires visibility of the same current source row.
-- If a Founder changes its worker ID, the old observation cannot be mistaken
-- for the newly identified worker's craft and is not exposed through this path.
CREATE POLICY attendance_craft_visible ON public.attendance_craft_observations FOR SELECT TO authenticated USING (
 EXISTS(SELECT 1 FROM public.attendance a WHERE a.id=attendance_craft_observations.attendance_id AND a.worker_id=attendance_craft_observations.worker_id)
);
CREATE POLICY payroll_craft_visible ON public.payroll_craft_observations FOR SELECT TO authenticated USING (
 EXISTS(SELECT 1 FROM public.payroll p WHERE p.id=payroll_craft_observations.payroll_id AND p.worker_id=payroll_craft_observations.worker_id)
);
CREATE FUNCTION public.guard_recorded_craft_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN RAISE EXCEPTION 'Recorded craft observation is immutable' USING ERRCODE='23514'; END $$;
REVOKE ALL ON FUNCTION public.guard_recorded_craft_immutable() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER guard_attendance_craft_immutable BEFORE UPDATE OR DELETE ON public.attendance_craft_observations FOR EACH ROW EXECUTE FUNCTION public.guard_recorded_craft_immutable();
CREATE TRIGGER guard_payroll_craft_immutable BEFORE UPDATE OR DELETE ON public.payroll_craft_observations FOR EACH ROW EXECUTE FUNCTION public.guard_recorded_craft_immutable();
CREATE FUNCTION public.capture_recorded_craft() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_craft text;
BEGIN
 SELECT position INTO v_craft FROM public.workers WHERE id=NEW.worker_id FOR SHARE;
 IF NOT FOUND OR v_craft IS NULL OR length(v_craft) NOT BETWEEN 1 AND 80 THEN RAISE EXCEPTION 'Worker craft unavailable for record' USING ERRCODE='22023'; END IF;
 IF TG_TABLE_SCHEMA='public' AND TG_TABLE_NAME='attendance' THEN
  INSERT INTO public.attendance_craft_observations(attendance_id,worker_id,craft) VALUES(NEW.id,NEW.worker_id,v_craft);
 ELSIF TG_TABLE_SCHEMA='public' AND TG_TABLE_NAME='payroll' THEN
  INSERT INTO public.payroll_craft_observations(payroll_id,worker_id,craft) VALUES(NEW.id,NEW.worker_id,v_craft);
 ELSE RAISE EXCEPTION 'Unexpected craft observation source'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.capture_recorded_craft() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER capture_attendance_craft AFTER INSERT ON public.attendance FOR EACH ROW EXECUTE FUNCTION public.capture_recorded_craft();
CREATE TRIGGER capture_payroll_craft AFTER INSERT ON public.payroll FOR EACH ROW EXECUTE FUNCTION public.capture_recorded_craft();

-- Add metadata to the existing JSON responses without changing their signatures,
-- cursor behavior, RLS model or the current worker_position field. Old records
-- report null; no attempt is made to reconstruct an unknown historical craft.
DO $patch$
DECLARE v_def text;v_old text;v_new text;
BEGIN
 SELECT pg_get_functiondef('public.attendance_history_matching(uuid,text,date,text)'::regprocedure) INTO v_def;
 v_old:=$old$or strpos(lower(coalesce(w.position, '')), lower(btrim(p_search))) > 0$old$;
 v_new:=$new$or strpos(lower(coalesce(w.position, '')), lower(btrim(p_search))) > 0
      or exists (select 1 from public.attendance_craft_observations o where o.attendance_id=a.id and o.worker_id=a.worker_id and strpos(lower(o.craft), lower(btrim(p_search))) > 0)$new$;
 IF position(v_old IN v_def)=0 OR length(v_def)-length(replace(v_def,v_old,''))<>length(v_old) THEN RAISE EXCEPTION 'Attendance search function differs; review required';END IF;
 EXECUTE replace(v_def,v_old,v_new);
 SELECT pg_get_functiondef('public.attendance_history_page(text,uuid,text,date,text,date,uuid,uuid,integer)'::regprocedure) INTO v_def;
 v_old:=$old$'items', coalesce((select jsonb_agg(to_jsonb(v) order by v.id asc) from visible v), '[]'::jsonb)) into result;$old$;
 v_new:=$new$'items', coalesce((select jsonb_agg(to_jsonb(v) || jsonb_build_object('entry_craft',o.craft,'entry_craft_at',o.captured_at) order by v.id asc) from visible v left join public.attendance_craft_observations o on o.attendance_id=v.id and o.worker_id=v.worker_id), '[]'::jsonb)) into result;$new$;
 IF position(v_old IN v_def)=0 OR length(v_def)-length(replace(v_def,v_old,''))<>length(v_old) THEN RAISE EXCEPTION 'Attendance history function differs; review required';END IF;
 EXECUTE replace(v_def,v_old,v_new);
 SELECT pg_get_functiondef('public.payslip_batch_snapshot(date,date)'::regprocedure) INTO v_def;
 v_old:=$old$SELECT p.*, w.name AS worker_name, w.position AS worker_position
    FROM public.payroll p JOIN public.workers w ON w.id=p.worker_id$old$;
 v_new:=$new$SELECT p.*, w.name AS worker_name, w.position AS worker_position, o.craft AS entry_craft, o.captured_at AS entry_craft_at
    FROM public.payroll p JOIN public.workers w ON w.id=p.worker_id LEFT JOIN public.payroll_craft_observations o ON o.payroll_id=p.id AND o.worker_id=p.worker_id$new$;
 IF position(v_old IN v_def)=0 OR length(v_def)-length(replace(v_def,v_old,''))<>length(v_old) THEN RAISE EXCEPTION 'Payslip function differs; review required';END IF;
 v_def:=replace(v_def,v_old,v_new);
 v_old:=$old$'id', p.id, 'worker_id', p.worker_id, 'worker_name', p.worker_name, 'worker_position', p.worker_position,$old$;
 v_new:=$new$'id', p.id, 'worker_id', p.worker_id, 'worker_name', p.worker_name, 'worker_position', p.worker_position, 'entry_craft', p.entry_craft, 'entry_craft_at', p.entry_craft_at,$new$;
 IF position(v_old IN v_def)=0 OR length(v_def)-length(replace(v_def,v_old,''))<>length(v_old) THEN RAISE EXCEPTION 'Payslip payload differs; review required';END IF;
 EXECUTE replace(v_def,v_old,v_new);
END $patch$;
DO $$ DECLARE r text;t text;BEGIN
 FOREACH t IN ARRAY ARRAY['public.attendance_craft_observations','public.payroll_craft_observations'] LOOP
  FOREACH r IN ARRAY ARRAY['anon','service_role'] LOOP
   IF has_table_privilege(r,t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=t::regclass AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege(r,t,a.attname,'SELECT,INSERT,UPDATE,REFERENCES')) THEN RAISE EXCEPTION 'Unexpected observation access for %',r;END IF;
  END LOOP;
  IF has_table_privilege('authenticated',t,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR NOT has_table_privilege('authenticated',t,'SELECT') OR EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=t::regclass AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege('authenticated',t,a.attname,'INSERT,UPDATE,REFERENCES')) THEN RAISE EXCEPTION 'Unexpected observation writer privilege';END IF;
 END LOOP;
 FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF has_function_privilege(r,'public.capture_recorded_craft()','EXECUTE') OR has_function_privilege(r,'public.guard_recorded_craft_immutable()','EXECUTE') THEN RAISE EXCEPTION 'Unexpected trigger function privilege'; END IF;
 END LOOP;
END $$;
