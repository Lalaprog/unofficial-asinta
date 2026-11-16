-- UNINSTALLED EXPERIMENT. Founder-reviewed attribution evidence for ONE
-- already-recorded external worker-week assertion. This is not a voucher,
-- payment, transfer, expense, automatic project-cost posting or proof. Never
-- infer a historical site from current assignments. The Founder must review
-- original records, other costs, possible duplicates and ALL original-period
-- cases. Each assertion can be attributed once, in a complete explicit split;
-- changes/corrections require a separately reviewed future design. Do not
-- install alone, enable on a shared database or use as a final ledger.
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
DO $preflight$
BEGIN
 IF to_regclass('public.historical_external_worker_payroll') IS NULL OR to_regclass('public.paid_period_assertion_cases') IS NULL OR to_regclass('public.projects') IS NULL OR to_regclass('public.users') IS NULL OR to_regprocedure('public.historical_external_worker_lookup(uuid)') IS NULL OR to_regprocedure('auth.uid()') IS NULL OR to_regprocedure('public.is_founder()') IS NULL OR to_regprocedure('public.session_assurance_satisfied()') IS NULL THEN RAISE EXCEPTION 'Historical attribution prerequisites missing'; END IF;
 IF to_regclass('public.historical_worker_attributions') IS NOT NULL OR to_regclass('public.historical_worker_attribution_sites') IS NOT NULL OR to_regprocedure('public.record_historical_worker_attribution(uuid,uuid,jsonb,jsonb,text,boolean)') IS NOT NULL OR to_regprocedure('public.historical_worker_attribution(uuid)') IS NOT NULL OR to_regprocedure('public.historical_worker_attribution_projects()') IS NOT NULL OR to_regprocedure('public.project_historical_worker_attributions(uuid)') IS NOT NULL OR to_regprocedure('public.guard_historical_worker_attribution_immutable()') IS NOT NULL THEN RAISE EXCEPTION 'Historical attribution objects already exist'; END IF;
END;
$preflight$;
CREATE TABLE public.historical_worker_attributions (
 request_id uuid PRIMARY KEY,
 source_id uuid NOT NULL UNIQUE REFERENCES public.historical_external_worker_payroll(request_id) ON DELETE RESTRICT,
 source_snapshot jsonb NOT NULL CHECK(jsonb_typeof(source_snapshot)='object' AND octet_length(source_snapshot::text)<=65536),
 split jsonb NOT NULL CHECK(jsonb_typeof(split)='array' AND jsonb_array_length(split) BETWEEN 1 AND 50),
 note text NOT NULL CHECK(length(note) BETWEEN 1 AND 500 AND note=btrim(note)),
 actor_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE public.historical_worker_attribution_sites (
 attribution_id uuid NOT NULL REFERENCES public.historical_worker_attributions(request_id) ON DELETE RESTRICT,
 project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE RESTRICT,
 gross numeric(10,2) NOT NULL CHECK(gross>0),
 PRIMARY KEY(attribution_id,project_id)
);
CREATE INDEX historical_worker_attribution_project_idx ON public.historical_worker_attribution_sites(project_id,attribution_id);
ALTER TABLE public.historical_worker_attributions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.historical_worker_attribution_sites ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.historical_worker_attributions,public.historical_worker_attribution_sites FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.guard_historical_worker_attribution_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$ BEGIN RAISE EXCEPTION 'Historical attribution is immutable; separate review required' USING ERRCODE='23514'; END $$;
REVOKE ALL ON FUNCTION public.guard_historical_worker_attribution_immutable() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER historical_worker_attribution_immutable BEFORE UPDATE OR DELETE ON public.historical_worker_attributions FOR EACH ROW EXECUTE FUNCTION public.guard_historical_worker_attribution_immutable();
CREATE TRIGGER historical_worker_attribution_sites_immutable BEFORE UPDATE OR DELETE ON public.historical_worker_attribution_sites FOR EACH ROW EXECUTE FUNCTION public.guard_historical_worker_attribution_immutable();

-- All projects, including completed/archived ones, are candidates for a
-- historical split. This list does not prove work occurred at any of them.
CREATE FUNCTION public.historical_worker_attribution_projects() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_items jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 IF (SELECT count(*) FROM public.projects)>2000 THEN RAISE EXCEPTION 'Project catalog exceeds attribution limit' USING ERRCODE='54000'; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name) ORDER BY name,id),'[]'::jsonb) INTO v_items FROM public.projects;
 IF octet_length(v_items::text)>1048576 THEN RAISE EXCEPTION 'Project catalog too large' USING ERRCODE='54000'; END IF;
 RETURN jsonb_build_object('projects',v_items);
END;
$$;

CREATE FUNCTION public.record_historical_worker_attribution(p_request uuid,p_source uuid,p_expected jsonb,p_split jsonb,p_note text,p_ack boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid:=auth.uid();v_old public.historical_worker_attributions%ROWTYPE;v_source public.historical_external_worker_payroll%ROWTYPE;v_split jsonb;v_note text;v_amount numeric;v_item jsonb;v_project uuid;v_sum numeric:=0;v_projects uuid[]:='{}';
BEGIN
 IF v_actor IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Historical attribution requires read committed isolation' USING ERRCODE='P1002'; END IF;
 IF p_request IS NULL OR p_source IS NULL OR p_expected IS NULL OR jsonb_typeof(p_expected)<>'object' OR octet_length(p_expected::text)>65536 OR p_split IS NULL OR jsonb_typeof(p_split)<>'array' OR octet_length(p_split::text)>16384 OR jsonb_array_length(p_split) NOT BETWEEN 1 AND 50 OR p_note IS NULL OR length(btrim(p_note)) NOT BETWEEN 1 AND 500 OR btrim(p_note) ~ '[[:cntrl:]]' OR p_ack IS DISTINCT FROM true THEN RAISE EXCEPTION 'Invalid attribution request' USING ERRCODE='22023'; END IF;
 v_note:=btrim(p_note);v_split:='[]'::jsonb;
 FOR v_item IN SELECT value FROM jsonb_array_elements(p_split) LOOP
  IF jsonb_typeof(v_item)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(CASE WHEN jsonb_typeof(v_item)='object' THEN v_item ELSE '{}'::jsonb END))<>2 OR NOT (v_item ? 'project_id' AND v_item ? 'gross') OR jsonb_typeof(v_item->'project_id') IS DISTINCT FROM 'string' OR (v_item->>'project_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR jsonb_typeof(v_item->'gross') IS DISTINCT FROM 'string' OR (v_item->>'gross') !~ '^(0|[1-9][0-9]{0,7})\.[0-9]{2}$' THEN RAISE EXCEPTION 'Invalid attribution site or gross' USING ERRCODE='22023'; END IF;
  v_project:=(v_item->>'project_id')::uuid;v_amount:=(v_item->>'gross')::numeric;
  IF v_amount<=0 OR v_project=ANY(v_projects) THEN RAISE EXCEPTION 'Duplicate project or non-positive attribution' USING ERRCODE='22023'; END IF;
  v_projects:=array_append(v_projects,v_project);v_sum:=v_sum+v_amount;
  v_split:=v_split||jsonb_build_array(jsonb_build_object('project_id',v_project,'gross',v_amount::numeric(10,2)::text));
 END LOOP;
 -- Canonical project order makes retries and evidence comparisons stable.
 SELECT jsonb_agg(value ORDER BY (value->>'project_id')::uuid) INTO v_split FROM jsonb_array_elements(v_split);
 PERFORM 1 FROM public.users WHERE id=v_actor AND role='founder' FOR SHARE;
 IF NOT FOUND OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('historical-attribution-request:'||p_request::text,0));
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('historical-attribution-source:'||p_source::text,0));
 SELECT * INTO v_old FROM public.historical_worker_attributions WHERE request_id=p_request;
 IF FOUND THEN
  IF (v_old.source_id,v_old.source_snapshot,v_old.split,v_old.note,v_old.actor_id) IS DISTINCT FROM (p_source,p_expected,v_split,v_note,v_actor) THEN RAISE EXCEPTION 'Attribution request ID used for different details' USING ERRCODE='22023'; END IF;
  IF public.historical_external_worker_lookup(p_source) IS DISTINCT FROM v_old.source_snapshot OR
   (SELECT coalesce(jsonb_agg(jsonb_build_object('project_id',x.project_id,'gross',x.gross::text) ORDER BY x.project_id),'[]'::jsonb) FROM public.historical_worker_attribution_sites x WHERE x.attribution_id=v_old.request_id) IS DISTINCT FROM v_old.split THEN
   RAISE EXCEPTION 'Historical attribution evidence differs; investigate before retry' USING ERRCODE='22023'; END IF;
  RETURN jsonb_build_object('request_id',p_request,'source_id',p_source,'replayed',true);
 END IF;
 SELECT * INTO v_source FROM public.historical_external_worker_payroll WHERE request_id=p_source FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Historical assertion unavailable' USING ERRCODE='P0002'; END IF;
 IF public.historical_external_worker_lookup(p_source) IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'Historical assertion changed; reload and review' USING ERRCODE='40001'; END IF;
 IF v_source.gross<=0 OR v_sum<>v_source.gross THEN RAISE EXCEPTION 'Site amounts must equal the full positive original gross' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM public.historical_worker_attributions WHERE source_id=p_source) THEN RAISE EXCEPTION 'Historical assertion already attributed; separate review required' USING ERRCODE='23505'; END IF;
 IF (SELECT count(*) FROM public.projects WHERE id=ANY(v_projects))<>cardinality(v_projects) THEN RAISE EXCEPTION 'Attribution project unavailable' USING ERRCODE='22023'; END IF;
 INSERT INTO public.historical_worker_attributions(request_id,source_id,source_snapshot,split,note,actor_id) VALUES(p_request,p_source,p_expected,v_split,v_note,v_actor);
 INSERT INTO public.historical_worker_attribution_sites(attribution_id,project_id,gross) SELECT p_request,(v->>'project_id')::uuid,(v->>'gross')::numeric FROM jsonb_array_elements(v_split) v;
 RETURN jsonb_build_object('request_id',p_request,'source_id',p_source,'replayed',false);
END;
$$;

-- Complete original plus split; a missing result is not proof an in-flight
-- request failed. A changed privileged source is returned as changed, never
-- silently re-attributed. The case count is a signal, not a site allocation.
CREATE FUNCTION public.historical_worker_attribution(p_source uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_row public.historical_worker_attributions%ROWTYPE;v_current jsonb;v_cases bigint;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 IF p_source IS NULL THEN RAISE EXCEPTION 'Historical assertion required' USING ERRCODE='22023'; END IF;
 SELECT * INTO v_row FROM public.historical_worker_attributions WHERE source_id=p_source;
 IF NOT FOUND THEN RETURN jsonb_build_object('found',false); END IF;
 v_current:=public.historical_external_worker_lookup(p_source);
 IF (SELECT coalesce(jsonb_agg(jsonb_build_object('project_id',x.project_id,'gross',x.gross::text) ORDER BY x.project_id),'[]'::jsonb) FROM public.historical_worker_attribution_sites x WHERE x.attribution_id=v_row.request_id) IS DISTINCT FROM v_row.split THEN
  RAISE EXCEPTION 'Historical attribution split differs; investigate' USING ERRCODE='22023'; END IF;
 SELECT count(*) INTO v_cases FROM public.paid_period_assertion_cases WHERE external_worker_id=p_source;
 RETURN jsonb_build_object('found',true,'request_id',v_row.request_id,'source_id',p_source,'source',v_row.source_snapshot,'source_changed',v_current IS DISTINCT FROM v_row.source_snapshot,'split',v_row.split,'note',v_row.note,'actor_id',v_row.actor_id,'recorded_at',v_row.recorded_at,'case_count',v_cases);
END;
$$;

CREATE FUNCTION public.project_historical_worker_attributions(p_project uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_count bigint;v_items jsonb;v_bad boolean;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 IF p_project IS NULL OR NOT EXISTS(SELECT 1 FROM public.projects WHERE id=p_project) THEN RAISE EXCEPTION 'Project unavailable' USING ERRCODE='42501'; END IF;
 SELECT count(*) INTO v_count FROM public.historical_worker_attribution_sites WHERE project_id=p_project;
 IF v_count>200 THEN RAISE EXCEPTION 'More than 200 historical attributions; separate reconciliation required' USING ERRCODE='54000'; END IF;
 -- Fail closed if privileged writes ever alter a stored split or site total.
 SELECT EXISTS(SELECT 1 FROM public.historical_worker_attribution_sites s JOIN public.historical_worker_attributions a ON a.request_id=s.attribution_id JOIN public.historical_external_worker_payroll h ON h.request_id=a.source_id WHERE s.project_id=p_project AND (
  a.source_snapshot IS DISTINCT FROM public.historical_external_worker_lookup(a.source_id) OR
  (SELECT coalesce(sum(x.gross),0) FROM public.historical_worker_attribution_sites x WHERE x.attribution_id=a.request_id)<>h.gross OR
  (SELECT coalesce(jsonb_agg(jsonb_build_object('project_id',x.project_id,'gross',x.gross::text) ORDER BY x.project_id),'[]'::jsonb) FROM public.historical_worker_attribution_sites x WHERE x.attribution_id=a.request_id) IS DISTINCT FROM a.split)) INTO v_bad;
 IF v_bad THEN RAISE EXCEPTION 'Historical attribution evidence differs; investigate' USING ERRCODE='22023'; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('request_id',a.request_id,'source_id',a.source_id,'worker_id',h.worker_id,'worker_name',h.worker_snapshot->>'name','period_start',h.period_start,'period_end',h.period_end,'paid_on',h.paid_on,'original_gross',h.gross::text,'site_gross',s.gross::text,'note',a.note,'recorded_by',a.actor_id,'recorded_at',a.recorded_at,'case_count',(SELECT count(*) FROM public.paid_period_assertion_cases c WHERE c.external_worker_id=h.request_id)) ORDER BY h.period_start DESC,a.request_id DESC),'[]'::jsonb) INTO v_items
 FROM public.historical_worker_attribution_sites s JOIN public.historical_worker_attributions a ON a.request_id=s.attribution_id JOIN public.historical_external_worker_payroll h ON h.request_id=a.source_id WHERE s.project_id=p_project;
 IF octet_length(v_items::text)>1048576 THEN RAISE EXCEPTION 'Historical attribution list too large' USING ERRCODE='54000'; END IF;
 RETURN jsonb_build_object('project_id',p_project,'items',v_items);
END;
$$;
REVOKE ALL ON FUNCTION public.record_historical_worker_attribution(uuid,uuid,jsonb,jsonb,text,boolean),public.historical_worker_attribution(uuid),public.project_historical_worker_attributions(uuid),public.historical_worker_attribution_projects() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.record_historical_worker_attribution(uuid,uuid,jsonb,jsonb,text,boolean),public.historical_worker_attribution(uuid),public.project_historical_worker_attributions(uuid),public.historical_worker_attribution_projects() TO authenticated;
DO $postflight$
DECLARE n text; r text; t regclass;
BEGIN
 FOREACH n IN ARRAY ARRAY['public.historical_worker_attributions','public.historical_worker_attribution_sites'] LOOP
  t:=pg_catalog.to_regclass(n);
  FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
   IF pg_catalog.has_table_privilege(r,t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid=t AND a.attnum>0 AND NOT a.attisdropped AND pg_catalog.has_column_privilege(r,t,a.attname,'SELECT,INSERT,UPDATE,REFERENCES')) THEN RAISE EXCEPTION 'Unexpected historical attribution table privilege'; END IF;
  END LOOP;
 END LOOP;
 FOREACH n IN ARRAY ARRAY['public.record_historical_worker_attribution(uuid,uuid,jsonb,jsonb,text,boolean)','public.historical_worker_attribution(uuid)','public.project_historical_worker_attributions(uuid)','public.historical_worker_attribution_projects()'] LOOP
  IF pg_catalog.has_function_privilege('anon',n,'EXECUTE') OR pg_catalog.has_function_privilege('service_role',n,'EXECUTE') OR NOT pg_catalog.has_function_privilege('authenticated',n,'EXECUTE') THEN RAISE EXCEPTION 'Unexpected historical attribution RPC privilege'; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) AS roles(role_name) WHERE pg_catalog.has_function_privilege(roles.role_name,'public.guard_historical_worker_attribution_immutable()','EXECUTE')) THEN RAISE EXCEPTION 'Unexpected historical attribution guard privilege'; END IF;
END;
$postflight$;
