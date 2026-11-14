-- Coordinated category/workforce candidate. Run only after worker_category_catalog.
-- Adds stable category identity to regular workers and keeps legacy position text
-- usable by older reads. This is not an account-role or permission mechanism.
-- Existing data is mapped, never deleted. Pay/attendance snapshots are untouched.
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
DO $$ BEGIN
 IF to_regclass('public.worker_categories') IS NULL OR to_regclass('public.worker_category_events') IS NULL OR to_regclass('public.workers') IS NULL OR to_regclass('public.users') IS NULL OR to_regprocedure('public.change_worker_category(uuid,uuid,text,text,integer)') IS NULL THEN RAISE EXCEPTION 'Category prerequisites missing'; END IF;
 IF EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.workers'::regclass AND attname='category_id' AND NOT attisdropped) OR to_regprocedure('public.active_worker_categories()') IS NOT NULL THEN RAISE EXCEPTION 'Category integration already exists'; END IF;
END $$;
LOCK TABLE public.users,public.workers,public.worker_categories,public.worker_category_events IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN
 IF (SELECT count(*) FROM public.users WHERE role='founder')<>1 THEN RAISE EXCEPTION 'Review Founder attribution before category baseline'; END IF;
 IF EXISTS(SELECT 1 FROM public.workers w WHERE NOT EXISTS(SELECT 1 FROM public.users u WHERE u.id=w.id AND u.role='supervisor') AND (w.position IS NULL OR length(btrim(w.position)) NOT BETWEEN 1 AND 80 OR btrim(w.position) ~ '[[:cntrl:]]' OR strpos(lower(w.position),'supervisor')>0)) THEN RAISE EXCEPTION 'Legacy worker positions require manual review'; END IF;
 IF EXISTS(SELECT 1 FROM public.worker_categories c WHERE strpos(lower(c.label),'supervisor')>0) THEN RAISE EXCEPTION 'Category names resembling Supervisor identities need review'; END IF;
END $$;
-- Initial options are existing product defaults, not invented worker records.
-- Legacy labels are imported as a baseline, using deterministic casing per name.
INSERT INTO public.worker_categories(id,label,created_by)
SELECT gen_random_uuid(),x.label,(SELECT id FROM public.users WHERE role='founder')
FROM (SELECT DISTINCT ON (lower(label)) label FROM (
 SELECT unnest(ARRAY['Foreman','Mason','Carpenter','Steelman','Electrician','Plumber','Welder','Painter','Laborer']) AS label
 UNION ALL SELECT btrim(w.position) FROM public.workers w WHERE NOT EXISTS(SELECT 1 FROM public.users u WHERE u.id=w.id AND u.role='supervisor')
) source ORDER BY lower(label),label) x
WHERE NOT EXISTS(SELECT 1 FROM public.worker_categories c WHERE lower(c.label)=lower(x.label));
ALTER TABLE public.workers ADD COLUMN category_id uuid REFERENCES public.worker_categories(id) ON DELETE RESTRICT;
UPDATE public.workers w SET category_id=c.id FROM public.worker_categories c
 WHERE lower(btrim(w.position))=lower(c.label) AND NOT EXISTS(SELECT 1 FROM public.users u WHERE u.id=w.id AND u.role='supervisor');
DO $$ BEGIN
 IF (SELECT count(*) FROM public.worker_categories)>500 THEN RAISE EXCEPTION 'Category baseline exceeds supported limit'; END IF;
 IF EXISTS(SELECT 1 FROM public.workers w WHERE w.category_id IS NULL AND NOT EXISTS(SELECT 1 FROM public.users u WHERE u.id=w.id AND u.role='supervisor')) THEN RAISE EXCEPTION 'Incomplete category baseline'; END IF;
END $$;

-- Exact table and column ACLs must be denied even through inherited roles.
REVOKE ALL ON public.worker_categories,public.worker_category_events FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.worker_category_catalog(),public.change_worker_category(uuid,uuid,text,text,integer),public.worker_category_history(uuid,timestamptz,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.worker_category_catalog(),public.change_worker_category(uuid,uuid,text,text,integer),public.worker_category_history(uuid,timestamptz,uuid) TO authenticated;
CREATE FUNCTION public.guard_worker_category_event() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$ BEGIN RAISE EXCEPTION 'Category evidence is immutable' USING ERRCODE='22023'; END $$;
REVOKE ALL ON FUNCTION public.guard_worker_category_event() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER guard_worker_category_event BEFORE UPDATE OR DELETE ON public.worker_category_events FOR EACH ROW EXECUTE FUNCTION public.guard_worker_category_event();

CREATE FUNCTION public.guard_worker_category_name() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF strpos(lower(NEW.label),'supervisor')>0 THEN RAISE EXCEPTION 'A worker category cannot be a Supervisor account designation' USING ERRCODE='22023'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_worker_category_name() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER guard_worker_category_name BEFORE INSERT OR UPDATE OF label ON public.worker_categories FOR EACH ROW EXECUTE FUNCTION public.guard_worker_category_name();

CREATE FUNCTION public.bind_worker_category() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_category public.worker_categories%ROWTYPE;v_role text;
BEGIN
 SELECT role INTO v_role FROM public.users WHERE id=NEW.id FOR SHARE;
 IF v_role='supervisor' THEN
  IF NEW.position<>'Site Supervisor' THEN RAISE EXCEPTION 'Supervisor account roster designation requires review' USING ERRCODE='22023'; END IF;
  NEW.category_id:=NULL; RETURN NEW;
 END IF;
 IF TG_OP='UPDATE' AND NEW.position IS NOT DISTINCT FROM OLD.position AND NEW.category_id IS NOT DISTINCT FROM OLD.category_id THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND NEW.position IS NOT DISTINCT FROM OLD.position AND NEW.category_id IS DISTINCT FROM OLD.category_id THEN RAISE EXCEPTION 'Choose a category by its current name' USING ERRCODE='22023'; END IF;
 SELECT * INTO v_category FROM public.worker_categories WHERE lower(label)=lower(btrim(NEW.position)) AND NOT archived FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Choose an active Founder-managed worker category' USING ERRCODE='22023'; END IF;
 NEW.category_id:=v_category.id; NEW.position:=v_category.label; RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.bind_worker_category() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER bind_worker_category BEFORE INSERT OR UPDATE OF position,category_id ON public.workers FOR EACH ROW EXECUTE FUNCTION public.bind_worker_category();

-- Keep existing consumers' current position text synchronized on rename; the
-- stable category ID and immutable category events preserve the relationship.
-- This can make source-bound unpaid payroll stale; review/refresh, never rewrite paid vouchers.
CREATE FUNCTION public.sync_worker_category_name() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NEW.label IS DISTINCT FROM OLD.label THEN UPDATE public.workers SET position=NEW.label WHERE category_id=NEW.id; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.sync_worker_category_name() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER sync_worker_category_name AFTER UPDATE OF label ON public.worker_categories FOR EACH ROW EXECUTE FUNCTION public.sync_worker_category_name();

CREATE FUNCTION public.active_worker_categories() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_data jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.session_assurance_satisfied(),false) OR NOT EXISTS(SELECT 1 FROM public.users WHERE id=auth.uid() AND role IN ('founder','supervisor')) THEN RAISE EXCEPTION 'Authorized assured account required' USING ERRCODE='42501'; END IF;
 IF (SELECT count(*) FROM public.worker_categories WHERE NOT archived)>500 THEN RAISE EXCEPTION 'Category list exceeds limit' USING ERRCODE='54000'; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'label',label,'archived',archived,'revision',revision) ORDER BY lower(label),id),'[]'::jsonb) INTO v_data FROM public.worker_categories WHERE NOT archived;
 RETURN v_data;
END $$;
REVOKE ALL ON FUNCTION public.active_worker_categories() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.active_worker_categories() TO authenticated;
DO $$ DECLARE r text;f text;BEGIN
 FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF EXISTS(SELECT 1 FROM unnest(ARRAY['public.worker_categories','public.worker_category_events']) t(name) WHERE has_table_privilege(r,t.name,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=t.name::regclass AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege(r,a.attrelid,a.attname,'SELECT,INSERT,UPDATE,REFERENCES'))) THEN RAISE EXCEPTION 'Category tables exposed to %',r; END IF;
  IF has_function_privilege(r,'public.bind_worker_category()','EXECUTE') OR has_function_privilege(r,'public.sync_worker_category_name()','EXECUTE') OR has_function_privilege(r,'public.guard_worker_category_event()','EXECUTE') OR has_function_privilege(r,'public.guard_worker_category_name()','EXECUTE') THEN RAISE EXCEPTION 'Category internal function exposed'; END IF;
 END LOOP;
 FOREACH f IN ARRAY ARRAY['public.active_worker_categories()','public.worker_category_catalog()','public.change_worker_category(uuid,uuid,text,text,integer)','public.worker_category_history(uuid,timestamptz,uuid)'] LOOP
  IF has_function_privilege('anon',f,'EXECUTE') OR has_function_privilege('service_role',f,'EXECUTE') OR NOT has_function_privilege('authenticated',f,'EXECUTE') THEN RAISE EXCEPTION 'Unexpected category RPC privileges'; END IF;
 END LOOP;
END $$;
