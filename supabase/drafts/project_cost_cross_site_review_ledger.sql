-- UNINSTALLED. Separate durable revisions for incomplete cross-site project
-- reviews. Never alters earlier reviews, payroll, expenses, or payments. A
-- matching read is point-in-time evidence, not completeness or a source lock.
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
DO $preflight$ BEGIN
 IF to_regclass('public.projects') IS NULL OR to_regclass('public.users') IS NULL OR to_regprocedure('public.project_cost_correction_inventory(uuid)') IS NULL OR to_regprocedure('public.project_cost_cross_site_corrected_preview(uuid,jsonb,jsonb,jsonb,boolean)') IS NULL OR to_regprocedure('public.is_founder()') IS NULL OR to_regprocedure('public.session_assurance_satisfied()') IS NULL OR to_regprocedure('auth.uid()') IS NULL THEN RAISE EXCEPTION 'Cross-site review ledger prerequisites missing'; END IF;
 IF to_regclass('public.project_cost_cross_site_reviews') IS NOT NULL OR to_regprocedure('public.record_project_cost_cross_site_review(uuid,uuid,integer,jsonb,jsonb,jsonb,text,boolean)') IS NOT NULL OR to_regprocedure('public.project_cost_cross_site_review(uuid,integer)') IS NOT NULL OR to_regprocedure('app_private.guard_project_cost_cross_site_review_immutable()') IS NOT NULL THEN RAISE EXCEPTION 'Cross-site review ledger name collision'; END IF;
END $preflight$;
CREATE TABLE public.project_cost_cross_site_reviews (
 request_id uuid PRIMARY KEY,project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE RESTRICT,
 revision integer NOT NULL CHECK(revision>0),expected_revision integer NOT NULL CHECK(expected_revision>=0 AND revision=expected_revision+1),
 actor_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object' AND octet_length(snapshot::text)<=2097152),
 choices jsonb NOT NULL CHECK(jsonb_typeof(choices)='object' AND octet_length(choices::text)<=500000),
 cross_sites jsonb NOT NULL CHECK(jsonb_typeof(cross_sites)='object' AND octet_length(cross_sites::text)<=500000),
 result jsonb NOT NULL CHECK(jsonb_typeof(result)='object' AND result @> '{"incomplete":true}'::jsonb),
 note text NOT NULL CHECK(length(note) BETWEEN 1 AND 500 AND note=btrim(note)),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(project_id,revision)
);
ALTER TABLE public.project_cost_cross_site_reviews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.project_cost_cross_site_reviews FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION app_private.guard_project_cost_cross_site_review_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$BEGIN RAISE EXCEPTION 'Cross-site review history is immutable' USING ERRCODE='23514';END$$;
REVOKE ALL ON FUNCTION app_private.guard_project_cost_cross_site_review_immutable() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER guard_project_cost_cross_site_review_immutable BEFORE UPDATE OR DELETE ON public.project_cost_cross_site_reviews FOR EACH ROW EXECUTE FUNCTION app_private.guard_project_cost_cross_site_review_immutable();
CREATE FUNCTION public.record_project_cost_cross_site_review(p_request uuid,p_project uuid,p_expected_revision integer,p_snapshot jsonb,p_choices jsonb,p_cross_sites jsonb,p_note text,p_ack boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid:=auth.uid();v_existing public.project_cost_cross_site_reviews%ROWTYPE;v_latest integer;v_now jsonb;v_result jsonb;v_note text;
BEGIN
 IF v_actor IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance required' USING ERRCODE='42501'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Cross-site review requires read committed' USING ERRCODE='P1002'; END IF;
 IF p_request IS NULL OR p_project IS NULL OR p_expected_revision IS NULL OR p_expected_revision<0 OR p_expected_revision>=2147483647 OR jsonb_typeof(p_snapshot) IS DISTINCT FROM 'object' OR octet_length(p_snapshot::text)>2097152 OR jsonb_typeof(p_choices) IS DISTINCT FROM 'object' OR octet_length(p_choices::text)>500000 OR jsonb_typeof(p_cross_sites) IS DISTINCT FROM 'object' OR octet_length(p_cross_sites::text)>500000 OR p_note IS NULL OR length(btrim(p_note)) NOT BETWEEN 1 AND 500 OR btrim(p_note) ~ '[[:cntrl:]]' OR p_ack IS DISTINCT FROM true THEN RAISE EXCEPTION 'Invalid cross-site review' USING ERRCODE='22023'; END IF;
 v_note:=btrim(p_note);
 PERFORM 1 FROM public.users WHERE id=v_actor AND role='founder' FOR SHARE;
 IF NOT FOUND OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance required' USING ERRCODE='42501'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('cross-site-cost-review-request:'||p_request::text,0));
 SELECT * INTO v_existing FROM public.project_cost_cross_site_reviews WHERE request_id=p_request;
 IF FOUND THEN
  IF (v_existing.project_id,v_existing.actor_id,v_existing.expected_revision,v_existing.snapshot #- '{historical_review,base,captured_at}',v_existing.choices,v_existing.cross_sites,v_existing.note) IS DISTINCT FROM (p_project,v_actor,p_expected_revision,p_snapshot #- '{historical_review,base,captured_at}',p_choices,p_cross_sites,v_note) THEN RAISE EXCEPTION 'Cross-site review request already used for different details' USING ERRCODE='22023'; END IF;
  RETURN jsonb_build_object('request_id',p_request,'project_id',p_project,'revision',v_existing.revision,'replayed',true);
 END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('cross-site-cost-review-project:'||p_project::text,0));
 PERFORM 1 FROM public.projects WHERE id=p_project FOR KEY SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Project unavailable' USING ERRCODE='42501'; END IF;
 SELECT coalesce(max(revision),0) INTO v_latest FROM public.project_cost_cross_site_reviews WHERE project_id=p_project;
 IF v_latest<>p_expected_revision THEN RAISE EXCEPTION 'Cross-site review changed; reload and review' USING ERRCODE='40001'; END IF;
 v_now:=public.project_cost_correction_inventory(p_project);
 IF v_now #- '{historical_review,base,captured_at}' IS DISTINCT FROM p_snapshot #- '{historical_review,base,captured_at}' THEN RAISE EXCEPTION 'Project evidence changed; reload and review' USING ERRCODE='40001'; END IF;
 -- This checks every source decision in the same statement snapshot. Source
 -- writers are not locked, and a review may become stale before commit.
 v_result:=public.project_cost_cross_site_corrected_preview(p_project,v_now,p_choices,p_cross_sites,true);
 INSERT INTO public.project_cost_cross_site_reviews(request_id,project_id,revision,expected_revision,actor_id,snapshot,choices,cross_sites,result,note)
 VALUES(p_request,p_project,v_latest+1,v_latest,v_actor,v_now,p_choices,p_cross_sites,v_result,v_note);
 RETURN jsonb_build_object('request_id',p_request,'project_id',p_project,'revision',v_latest+1,'replayed',false);
END $$;
CREATE FUNCTION public.project_cost_cross_site_review(p_project uuid,p_revision integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_row public.project_cost_cross_site_reviews%ROWTYPE;v_latest integer;v_now jsonb;v_result jsonb;v_status text:='unavailable';
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance required' USING ERRCODE='42501'; END IF;
 IF p_project IS NULL OR (p_revision IS NOT NULL AND p_revision<1) OR NOT EXISTS(SELECT 1 FROM public.projects WHERE id=p_project) THEN RAISE EXCEPTION 'Cross-site review unavailable' USING ERRCODE='22023'; END IF;
 SELECT coalesce(max(revision),0) INTO v_latest FROM public.project_cost_cross_site_reviews WHERE project_id=p_project;
 IF v_latest=0 AND p_revision IS NULL THEN RETURN jsonb_build_object('project_id',p_project,'found',false,'latest_revision',0); END IF;
 SELECT * INTO v_row FROM public.project_cost_cross_site_reviews WHERE project_id=p_project AND revision=coalesce(p_revision,v_latest);
 IF NOT FOUND THEN RAISE EXCEPTION 'Cross-site review unavailable' USING ERRCODE='P0002'; END IF;
 BEGIN
  v_now:=public.project_cost_correction_inventory(p_project);
  IF v_now #- '{historical_review,base,captured_at}' IS DISTINCT FROM v_row.snapshot #- '{historical_review,base,captured_at}' THEN v_status:='changed';
  ELSE
   v_result:=public.project_cost_cross_site_corrected_preview(p_project,v_now,v_row.choices,v_row.cross_sites,true);
   v_status:=CASE WHEN v_result=v_row.result THEN 'matches' ELSE 'changed' END;
  END IF;
 EXCEPTION WHEN serialization_failure THEN v_status:='changed'; WHEN others THEN v_status:='unavailable'; END;
 RETURN jsonb_build_object('project_id',p_project,'found',true,'latest_revision',v_latest,'revision',v_row.revision,'request_id',v_row.request_id,'actor_id',v_row.actor_id,'recorded_at',v_row.recorded_at,'snapshot',v_row.snapshot,'choices',v_row.choices,'cross_sites',v_row.cross_sites,'result',v_row.result,'note',v_row.note,'freshness',v_status);
END $$;
REVOKE ALL ON FUNCTION public.record_project_cost_cross_site_review(uuid,uuid,integer,jsonb,jsonb,jsonb,text,boolean),public.project_cost_cross_site_review(uuid,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.record_project_cost_cross_site_review(uuid,uuid,integer,jsonb,jsonb,jsonb,text,boolean),public.project_cost_cross_site_review(uuid,integer) TO authenticated;
DO $postflight$ DECLARE r text; BEGIN
 FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF has_table_privilege(r,'public.project_cost_cross_site_reviews','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid='public.project_cost_cross_site_reviews'::regclass AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege(r,a.attrelid,a.attname,'SELECT,INSERT,UPDATE,REFERENCES')) OR has_function_privilege(r,'app_private.guard_project_cost_cross_site_review_immutable()','EXECUTE') THEN RAISE EXCEPTION 'Unexpected cross-site review direct access'; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['anon','service_role']) roles(r) WHERE has_function_privilege(roles.r,'public.record_project_cost_cross_site_review(uuid,uuid,integer,jsonb,jsonb,jsonb,text,boolean)','EXECUTE') OR has_function_privilege(roles.r,'public.project_cost_cross_site_review(uuid,integer)','EXECUTE')) OR NOT has_function_privilege('authenticated','public.record_project_cost_cross_site_review(uuid,uuid,integer,jsonb,jsonb,jsonb,text,boolean)','EXECUTE') OR NOT has_function_privilege('authenticated','public.project_cost_cross_site_review(uuid,integer)','EXECUTE') THEN RAISE EXCEPTION 'Unexpected cross-site review RPC access'; END IF;
END $postflight$;
