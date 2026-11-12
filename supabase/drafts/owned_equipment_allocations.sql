-- UNINSTALLED DRAFT. Execute only as a reviewed single transaction, after
-- compatibility, permissions, legacy clients, history and recovery checks.
-- Opt-in adoption requires explicit physical confirmation by a Founder.
-- A NULL legacy project may mean unassigned, not necessarily depot stock.
-- Site adoption preserves the entire recorded stock at the original site.
-- No existing records are converted or updated by installation.
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
DO $preflight$
DECLARE v_missing text; n text;
BEGIN
 IF to_regclass('public.tools') IS NULL OR to_regclass('public.projects') IS NULL OR to_regclass('public.users') IS NULL OR to_regprocedure('auth.uid()') IS NULL OR to_regprocedure('public.is_founder()') IS NULL OR to_regprocedure('public.is_supervisor_assigned(uuid)') IS NULL OR to_regprocedure('public.session_assurance_satisfied()') IS NULL THEN RAISE EXCEPTION 'Equipment prerequisites missing'; END IF;
 LOCK TABLE public.tools IN SHARE MODE;
 SELECT string_agg(r.rel||'.'||r.col,', ' ORDER BY r.rel,r.col) INTO v_missing FROM
 (VALUES ('tools','id','uuid'),('tools','name','text'),('tools','quantity','integer'),('tools','condition','text'),('tools','project_id','uuid'),('projects','id','uuid'),('projects','name','text'),('users','id','uuid'),('users','role','text')) r(rel,col,typ)
 LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=to_regclass('public.'||r.rel) AND a.attname=r.col AND a.attnum>0 AND NOT a.attisdropped
 WHERE a.attname IS NULL OR pg_catalog.format_type(a.atttypid,a.atttypmod) IS DISTINCT FROM r.typ;
 IF v_missing IS NOT NULL THEN RAISE EXCEPTION 'Equipment prerequisite columns missing or different: %',v_missing; END IF;
 FOREACH n IN ARRAY ARRAY['public.managed_owned_equipment','public.owned_equipment_allocations','public.owned_equipment_events'] LOOP
  IF to_regclass(n) IS NOT NULL THEN RAISE EXCEPTION 'Equipment relation already exists: %',n; END IF;
 END LOOP;
 FOREACH n IN ARRAY ARRAY['public.guard_managed_equipment()','public.change_owned_equipment(uuid,uuid,text,uuid,integer,integer,integer)','public.owned_equipment_snapshot()','public.owned_equipment_operation_status(uuid)','public.project_equipment_snapshot(uuid)'] LOOP
  IF to_regprocedure(n) IS NOT NULL THEN RAISE EXCEPTION 'Equipment function already exists: %',n; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.tools'::regclass AND NOT tgisinternal) THEN RAISE EXCEPTION 'Existing equipment triggers require separate review'; END IF;
END;
$preflight$;

CREATE TABLE public.managed_owned_equipment (
 tool_id uuid PRIMARY KEY REFERENCES public.tools(id) ON DELETE RESTRICT,
 adopted_by uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 adopted_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE public.owned_equipment_allocations (
 tool_id uuid NOT NULL REFERENCES public.managed_owned_equipment(tool_id) ON DELETE RESTRICT,
 project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE RESTRICT,
 quantity integer NOT NULL CHECK(quantity>0),
 PRIMARY KEY(tool_id,project_id)
);
CREATE TABLE public.owned_equipment_events (
 id uuid PRIMARY KEY,
 actor_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 tool_id uuid NOT NULL REFERENCES public.managed_owned_equipment(tool_id) ON DELETE RESTRICT,
 action text NOT NULL CHECK(action IN ('adopt','adopt_site','allocate')),
 project_id uuid REFERENCES public.projects(id) ON DELETE RESTRICT,
 quantity integer,
 expected_stock integer NOT NULL,
 expected_site integer,
 result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((action='adopt' AND project_id IS NULL AND quantity IS NULL AND expected_site IS NULL) OR (action='adopt_site' AND project_id IS NOT NULL AND quantity IS NOT NULL AND quantity>0 AND quantity=expected_stock AND expected_site IS NULL) OR (action='allocate' AND project_id IS NOT NULL AND quantity IS NOT NULL AND quantity>=0 AND expected_site IS NOT NULL AND expected_site>=0))
);
ALTER TABLE public.managed_owned_equipment ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.owned_equipment_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.owned_equipment_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.managed_owned_equipment,public.owned_equipment_allocations,public.owned_equipment_events FROM PUBLIC,anon,authenticated;

-- Old clients may still edit total stock. Row locking in UPDATE serializes them
-- with allocations; they cannot reduce it below allocated stock or assign a
-- single legacy project once the item is managed. FK prevents deletion.
CREATE FUNCTION public.guard_managed_equipment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_allocated bigint;
BEGIN
 IF EXISTS(SELECT 1 FROM public.managed_owned_equipment WHERE tool_id=OLD.id) THEN
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Managed equipment updates require read committed isolation' USING ERRCODE='P1002'; END IF;
  SELECT coalesce(sum(quantity),0) INTO v_allocated FROM public.owned_equipment_allocations WHERE tool_id=OLD.id;
  IF NEW.project_id IS NOT NULL THEN RAISE EXCEPTION 'Managed equipment uses project allocations, not the legacy single-site field' USING ERRCODE='23514'; END IF;
  IF NEW.quantity IS NULL OR NEW.quantity<v_allocated THEN RAISE EXCEPTION 'Stock cannot be lower than allocated equipment' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_managed_equipment() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER guard_managed_equipment BEFORE UPDATE OF quantity,project_id ON public.tools FOR EACH ROW EXECUTE FUNCTION public.guard_managed_equipment();

-- Callers choose an idempotency ID. Each change compares the stock and target
-- allocation seen by the Founder. The tool row serializes old/new writers.
CREATE FUNCTION public.change_owned_equipment(p_id uuid,p_tool uuid,p_action text,p_project uuid,p_quantity integer,p_expected_stock integer,p_expected_site integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_prev public.owned_equipment_events%ROWTYPE; v_tool public.tools%ROWTYPE; v_site integer; v_allocated bigint; v_result jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access required' USING ERRCODE='42501'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Equipment changes require read committed isolation' USING ERRCODE='P1002'; END IF;
 IF p_id IS NULL OR p_tool IS NULL OR p_action IS NULL OR p_expected_stock IS NULL OR p_expected_stock<0 OR
  NOT ((p_action='adopt' AND p_project IS NULL AND p_quantity IS NULL AND p_expected_site IS NULL) OR (p_action='adopt_site' AND p_project IS NOT NULL AND p_quantity IS NOT NULL AND p_quantity>0 AND p_quantity=p_expected_stock AND p_expected_site IS NULL) OR (p_action='allocate' AND p_project IS NOT NULL AND p_quantity IS NOT NULL AND p_quantity>=0 AND p_expected_site IS NOT NULL AND p_expected_site>=0)) THEN RAISE EXCEPTION 'Invalid equipment operation' USING ERRCODE='22023'; END IF;
 PERFORM 1 FROM public.users WHERE id=auth.uid() AND role='founder' FOR SHARE;
 IF NOT FOUND OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access required' USING ERRCODE='42501'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('equipment-operation:'||p_id::text,0));
 SELECT * INTO v_prev FROM public.owned_equipment_events WHERE id=p_id;
 IF FOUND THEN
  IF (v_prev.actor_id,v_prev.tool_id,v_prev.action,v_prev.project_id,v_prev.quantity,v_prev.expected_stock,v_prev.expected_site) IS DISTINCT FROM (auth.uid(),p_tool,p_action,p_project,p_quantity,p_expected_stock,p_expected_site) THEN RAISE EXCEPTION 'Operation ID already used for a different request' USING ERRCODE='22023'; END IF;
  RETURN v_prev.result||jsonb_build_object('replayed',true);
 END IF;
 SELECT * INTO v_tool FROM public.tools WHERE id=p_tool FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Equipment unavailable' USING ERRCODE='P0002'; END IF;
 IF v_tool.quantity IS DISTINCT FROM p_expected_stock THEN RAISE EXCEPTION 'Stock changed; refresh inventory' USING ERRCODE='40001'; END IF;
 IF p_action='adopt' THEN
  IF v_tool.project_id IS NOT NULL THEN RAISE EXCEPTION 'Legacy site-assigned equipment requires separate reconciliation' USING ERRCODE='22023'; END IF;
  IF EXISTS(SELECT 1 FROM public.managed_owned_equipment WHERE tool_id=p_tool) THEN RAISE EXCEPTION 'Equipment already managed; refresh' USING ERRCODE='40001'; END IF;
  -- Force a new row version so a legacy repeatable-read transaction whose
  -- snapshot predates adoption cannot update the tool using stale visibility.
  UPDATE public.tools SET quantity=quantity WHERE id=p_tool;
  INSERT INTO public.managed_owned_equipment(tool_id,adopted_by) VALUES(p_tool,auth.uid());
  v_site:=0;v_allocated:=0;
 ELSIF p_action='adopt_site' THEN
  IF EXISTS(SELECT 1 FROM public.managed_owned_equipment WHERE tool_id=p_tool) THEN RAISE EXCEPTION 'Equipment already managed; refresh' USING ERRCODE='40001'; END IF;
  IF v_tool.project_id IS DISTINCT FROM p_project THEN RAISE EXCEPTION 'Legacy site changed; refresh inventory' USING ERRCODE='40001'; END IF;
  PERFORM 1 FROM public.projects WHERE id=p_project FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Project unavailable' USING ERRCODE='P0002'; END IF;
  -- Update the parent first, while it is not yet managed. One transaction
  -- atomically replaces the old site pointer with an equal allocation.
  UPDATE public.tools SET project_id=NULL WHERE id=p_tool;
  INSERT INTO public.managed_owned_equipment(tool_id,adopted_by) VALUES(p_tool,auth.uid());
  IF p_quantity>0 THEN INSERT INTO public.owned_equipment_allocations(tool_id,project_id,quantity) VALUES(p_tool,p_project,p_quantity); END IF;
  v_site:=p_quantity;v_allocated:=p_quantity;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM public.managed_owned_equipment WHERE tool_id=p_tool) OR v_tool.project_id IS NOT NULL THEN RAISE EXCEPTION 'Equipment is not ready for allocations' USING ERRCODE='22023'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.projects WHERE id=p_project) THEN RAISE EXCEPTION 'Project unavailable' USING ERRCODE='P0002'; END IF;
  SELECT coalesce((SELECT quantity FROM public.owned_equipment_allocations WHERE tool_id=p_tool AND project_id=p_project),0) INTO v_site;
  IF v_site<>p_expected_site THEN RAISE EXCEPTION 'Site allocation changed; refresh inventory' USING ERRCODE='40001'; END IF;
  SELECT coalesce(sum(quantity),0) INTO v_allocated FROM public.owned_equipment_allocations WHERE tool_id=p_tool;
  IF v_allocated-v_site+p_quantity>v_tool.quantity THEN RAISE EXCEPTION 'Allocation exceeds owned stock' USING ERRCODE='23514'; END IF;
  -- As at adoption, a new parent-row version makes concurrent stale-snapshot
  -- legacy updates fail rather than seeing an obsolete allocation total.
  UPDATE public.tools SET quantity=quantity WHERE id=p_tool;
  IF p_quantity=0 THEN DELETE FROM public.owned_equipment_allocations WHERE tool_id=p_tool AND project_id=p_project;
  ELSE INSERT INTO public.owned_equipment_allocations(tool_id,project_id,quantity) VALUES(p_tool,p_project,p_quantity) ON CONFLICT(tool_id,project_id) DO UPDATE SET quantity=EXCLUDED.quantity; END IF;
  v_allocated:=v_allocated-v_site+p_quantity;v_site:=p_quantity;
 END IF;
 v_result:=jsonb_build_object('id',p_id,'tool_id',p_tool,'stock',v_tool.quantity,'allocated',v_allocated,'depot',v_tool.quantity-v_allocated,'site_quantity',v_site,'replayed',false);
 INSERT INTO public.owned_equipment_events(id,actor_id,tool_id,action,project_id,quantity,expected_stock,expected_site,result) VALUES(p_id,auth.uid(),p_tool,p_action,p_project,p_quantity,p_expected_stock,p_expected_site,v_result);
 RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.change_owned_equipment(uuid,uuid,text,uuid,integer,integer,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.change_owned_equipment(uuid,uuid,text,uuid,integer,integer,integer) TO authenticated;

CREATE FUNCTION public.owned_equipment_snapshot() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_items jsonb; v_projects jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access required' USING ERRCODE='42501'; END IF;
 IF (SELECT count(*) FROM public.tools)>2000 OR (SELECT count(*) FROM public.projects)>2000 OR (SELECT count(*) FROM public.owned_equipment_allocations)>10000 THEN RAISE EXCEPTION 'Equipment snapshot exceeds limit' USING ERRCODE='54000'; END IF;
 IF EXISTS(SELECT 1 FROM public.managed_owned_equipment m JOIN public.tools t ON t.id=m.tool_id WHERE t.project_id IS NOT NULL OR t.quantity<(SELECT coalesce(sum(a.quantity),0) FROM public.owned_equipment_allocations a WHERE a.tool_id=t.id)) THEN RAISE EXCEPTION 'Equipment stock requires reconciliation' USING ERRCODE='23514'; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',t.id,'name',t.name,'stock',t.quantity,'condition',t.condition,'legacy_project_id',t.project_id,'managed',m.tool_id IS NOT NULL,
 'sites',coalesce((SELECT jsonb_agg(jsonb_build_object('project_id',a.project_id,'name',p.name,'quantity',a.quantity) ORDER BY p.name,p.id) FROM public.owned_equipment_allocations a JOIN public.projects p ON p.id=a.project_id WHERE a.tool_id=t.id),'[]'::jsonb)) ORDER BY t.name,t.id),'[]'::jsonb) INTO v_items
 FROM public.tools t LEFT JOIN public.managed_owned_equipment m ON m.tool_id=t.id;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name) ORDER BY name,id),'[]'::jsonb) INTO v_projects FROM public.projects;
 RETURN jsonb_build_object('items',v_items,'projects',v_projects);
END;
$$;
REVOKE ALL ON FUNCTION public.owned_equipment_snapshot() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.owned_equipment_snapshot() TO authenticated;

-- Lookup is restricted to the original actor. A missing event does not establish
-- that an in-flight request has failed; retrying the same ID remains safest.
CREATE FUNCTION public.owned_equipment_operation_status(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_event public.owned_equipment_events%ROWTYPE;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access required' USING ERRCODE='42501'; END IF;
 IF p_id IS NULL THEN RAISE EXCEPTION 'Operation ID required' USING ERRCODE='22023'; END IF;
 SELECT * INTO v_event FROM public.owned_equipment_events WHERE id=p_id AND actor_id=auth.uid();
 IF NOT FOUND THEN RETURN jsonb_build_object('found',false); END IF;
 RETURN jsonb_build_object('found',true,'attempt',jsonb_build_object('id',v_event.id,'tool',v_event.tool_id,'action',v_event.action,'project',v_event.project_id,'quantity',v_event.quantity,'expectedStock',v_event.expected_stock,'expectedSite',v_event.expected_site),'result',v_event.result);
END;
$$;
REVOKE ALL ON FUNCTION public.owned_equipment_operation_status(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.owned_equipment_operation_status(uuid) TO authenticated;
-- Only the requested authorized site is visible. Legacy single-site records
-- and managed allocations are separate; neither proves current physical stock.
CREATE FUNCTION public.project_equipment_snapshot(p_project uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_items jsonb; v_total bigint;
BEGIN
 IF auth.uid() IS NULL OR p_project IS NULL OR NOT coalesce(public.session_assurance_satisfied(),false) OR NOT (
  coalesce(public.is_founder(),false) OR (EXISTS(SELECT 1 FROM public.users WHERE id=auth.uid() AND role='supervisor') AND coalesce(public.is_supervisor_assigned(p_project),false))
 ) THEN RAISE EXCEPTION 'Project equipment access required' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.projects WHERE id=p_project) THEN RAISE EXCEPTION 'Project unavailable' USING ERRCODE='P0002'; END IF;
 IF EXISTS(SELECT 1 FROM public.tools t JOIN public.managed_owned_equipment m ON m.tool_id=t.id WHERE t.project_id=p_project) THEN RAISE EXCEPTION 'Equipment location requires reconciliation' USING ERRCODE='23514'; END IF;
 SELECT count(*) INTO v_total FROM (
  SELECT t.id FROM public.tools t WHERE t.project_id=p_project AND NOT EXISTS(SELECT 1 FROM public.managed_owned_equipment m WHERE m.tool_id=t.id)
  UNION ALL SELECT a.tool_id FROM public.owned_equipment_allocations a WHERE a.project_id=p_project
 ) q;
 IF v_total>2000 THEN RAISE EXCEPTION 'Project equipment exceeds snapshot limit' USING ERRCODE='54000'; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',q.id,'name',q.name,'condition',q.condition,'quantity',q.quantity,'source',q.source) ORDER BY q.name,q.id),'[]'::jsonb) INTO v_items FROM (
  SELECT t.id,t.name,t.condition,t.quantity,'legacy'::text AS source FROM public.tools t WHERE t.project_id=p_project AND NOT EXISTS(SELECT 1 FROM public.managed_owned_equipment m WHERE m.tool_id=t.id)
  UNION ALL SELECT t.id,t.name,t.condition,a.quantity,'allocated'::text AS source FROM public.owned_equipment_allocations a JOIN public.tools t ON t.id=a.tool_id WHERE a.project_id=p_project
 ) q;
 RETURN jsonb_build_object('project_id',p_project,'items',v_items);
END;
$$;
REVOKE ALL ON FUNCTION public.project_equipment_snapshot(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.project_equipment_snapshot(uuid) TO authenticated;

DO $postflight$
DECLARE n text;
BEGIN
 FOREACH n IN ARRAY ARRAY['public.managed_owned_equipment','public.owned_equipment_allocations','public.owned_equipment_events'] LOOP
  IF has_table_privilege('anon',n,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_table_privilege('authenticated',n,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN RAISE EXCEPTION 'Unexpected equipment table privileges'; END IF;
 END LOOP;
 FOREACH n IN ARRAY ARRAY['public.change_owned_equipment(uuid,uuid,text,uuid,integer,integer,integer)','public.owned_equipment_snapshot()','public.owned_equipment_operation_status(uuid)','public.project_equipment_snapshot(uuid)'] LOOP
  IF has_function_privilege('anon',n,'EXECUTE') OR NOT has_function_privilege('authenticated',n,'EXECUTE') THEN RAISE EXCEPTION 'Unexpected equipment function privileges'; END IF;
 END LOOP;
END;
$postflight$;
