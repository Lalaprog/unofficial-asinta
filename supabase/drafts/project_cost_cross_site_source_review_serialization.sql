-- HELD CANDIDATE, not installed. Adds a narrow corrected-source-review lock
-- to the existing cross-site writer. Does NOT lock expense, attribution, case,
-- payroll, owner/DDL or other writers; an already-saved review may be stale.
-- Requires a quiet coordinated window; in-flight old function executions must
-- be drained before applying. Never run the installed cross-site bundle again.
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
DO $hold$ BEGIN IF current_setting('app.cross_site_source_lock_reviewed',true) IS DISTINCT FROM 'yes' THEN RAISE EXCEPTION 'Cross-site source review lock is held pending review and rehearsal'; END IF; END $hold$;
-- Prevent concurrent inserts while checking and replacing the function, not a
-- guarantee that already executing old function calls have drained.
LOCK TABLE public.project_cost_cross_site_reviews,public.project_cost_corrected_reviews IN SHARE ROW EXCLUSIVE MODE;
DO $preflight$
DECLARE r record; f oid; t oid; api_role text;
BEGIN
 FOR r IN SELECT * FROM (VALUES
  ('public.record_project_cost_cross_site_review(uuid,uuid,integer,jsonb,jsonb,jsonb,text,boolean)','e053007527ae9eebad4188d9f3ff119bd9210155eb7948798d5ec978e27915b5'),
  ('public.record_project_cost_corrected_review(uuid,uuid,integer,jsonb,jsonb,text,boolean)','61fd78c7e4b02206b119f706fc4105410de11980082dd3b5b190f9f71ce75ce0')
 ) AS expected(signature,digest) LOOP
  f:=to_regprocedure(r.signature);
  IF f IS NULL OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid=f AND p.prokind='f' AND p.prosecdef AND p.provolatile='v' AND p.proconfig @> ARRAY['search_path=""'] AND pg_catalog.pg_get_userbyid(p.proowner)='postgres' AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p.prosrc,'UTF8')),'hex')=r.digest) OR NOT pg_catalog.has_function_privilege('authenticated',f,'EXECUTE') OR pg_catalog.has_function_privilege('anon',f,'EXECUTE') OR pg_catalog.has_function_privilege('service_role',f,'EXECUTE') THEN RAISE EXCEPTION 'Cross-site source lock dependency changed: %',r.signature; END IF;
 END LOOP;
 FOR r IN SELECT * FROM (VALUES
  ('public.project_cost_corrected_reviews','guard_project_cost_corrected_review_immutable'),
  ('public.project_cost_cross_site_reviews','guard_project_cost_cross_site_review_immutable')
 ) AS expected(name,trigger_name) LOOP
  t:=pg_catalog.to_regclass(r.name);
  IF t IS NULL OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid=t AND c.relrowsecurity AND pg_catalog.pg_get_userbyid(c.relowner)='postgres') OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger g WHERE g.tgrelid=t AND g.tgname=r.trigger_name AND g.tgenabled IN ('O','A') AND NOT g.tgisinternal) THEN RAISE EXCEPTION 'Review table or immutable trigger changed: %',r.name; END IF;
  FOREACH api_role IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
   IF pg_catalog.has_table_privilege(api_role,t,'INSERT,UPDATE,DELETE,TRUNCATE') OR EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid=t AND a.attnum>0 AND NOT a.attisdropped AND pg_catalog.has_column_privilege(api_role,t,a.attname,'INSERT,UPDATE')) THEN RAISE EXCEPTION 'Review table direct write access changed: % %',r.name,api_role; END IF;
  END LOOP;
 END LOOP;
END $preflight$;
CREATE OR REPLACE FUNCTION public.record_project_cost_cross_site_review(p_request uuid,p_project uuid,p_expected_revision integer,p_snapshot jsonb,p_choices jsonb,p_cross_sites jsonb,p_note text,p_ack boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid:=auth.uid();v_existing public.project_cost_cross_site_reviews%ROWTYPE;v_latest integer;v_now jsonb;v_result jsonb;v_note text;v_source_project uuid;
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
 -- Serialize against the exact project lock already used by the corrected
 -- source-review writer. Sort all distinct source projects to avoid cycles
 -- between independent destination reviews. Input remains untrusted; the
 -- preview below still validates every context and current source review.
 IF EXISTS(SELECT 1 FROM pg_catalog.jsonb_each(p_cross_sites) x WHERE pg_catalog.jsonb_typeof(x.value) IS DISTINCT FROM 'object' OR pg_catalog.jsonb_typeof(x.value->'original_site_reviews') IS DISTINCT FROM 'array' OR pg_catalog.jsonb_array_length(CASE WHEN pg_catalog.jsonb_typeof(x.value->'original_site_reviews')='array' THEN x.value->'original_site_reviews' ELSE '[]'::jsonb END)>50) THEN RAISE EXCEPTION 'Invalid original-site review references' USING ERRCODE='22023'; END IF;
 IF (SELECT count(*) FROM pg_catalog.jsonb_each(p_cross_sites) x CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(x.value->'original_site_reviews') s)>100 OR EXISTS(SELECT 1 FROM pg_catalog.jsonb_each(p_cross_sites) x CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(x.value->'original_site_reviews') s WHERE pg_catalog.jsonb_typeof(s.value) IS DISTINCT FROM 'object' OR coalesce(s.value->>'project_id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN RAISE EXCEPTION 'Invalid original-site review references' USING ERRCODE='22023'; END IF;
 FOR v_source_project IN SELECT DISTINCT (s.value->>'project_id')::uuid FROM pg_catalog.jsonb_each(p_cross_sites) x CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(x.value->'original_site_reviews') s ORDER BY 1 LOOP
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('corrected-cost-review-project:'||v_source_project::text,0));
 END LOOP;
 SELECT coalesce(max(revision),0) INTO v_latest FROM public.project_cost_cross_site_reviews WHERE project_id=p_project;
 IF v_latest<>p_expected_revision THEN RAISE EXCEPTION 'Cross-site review changed; reload and review' USING ERRCODE='40001'; END IF;
 v_now:=public.project_cost_correction_inventory(p_project);
 IF v_now #- '{historical_review,base,captured_at}' IS DISTINCT FROM p_snapshot #- '{historical_review,base,captured_at}' THEN RAISE EXCEPTION 'Project evidence changed; reload and review' USING ERRCODE='40001'; END IF;
 -- Source review revisions cannot commit concurrently through the paired
 -- writer. Other evidence writers remain unlocked and may still race.
 v_result:=public.project_cost_cross_site_corrected_preview(p_project,v_now,p_choices,p_cross_sites,true);
 INSERT INTO public.project_cost_cross_site_reviews(request_id,project_id,revision,expected_revision,actor_id,snapshot,choices,cross_sites,result,note)
 VALUES(p_request,p_project,v_latest+1,v_latest,v_actor,v_now,p_choices,p_cross_sites,v_result,v_note);
 RETURN jsonb_build_object('request_id',p_request,'project_id',p_project,'revision',v_latest+1,'replayed',false);
END $$;
DO $postflight$ DECLARE f oid:=to_regprocedure('public.record_project_cost_cross_site_review(uuid,uuid,integer,jsonb,jsonb,jsonb,text,boolean)'); BEGIN
 IF f IS NULL OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid=f AND p.prokind='f' AND p.prosecdef AND p.provolatile='v' AND p.proconfig @> ARRAY['search_path=""'] AND pg_catalog.pg_get_userbyid(p.proowner)='postgres' AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p.prosrc,'UTF8')),'hex')='3e394e097b54c9cc092cc47cca61d7047480a0764b53d63eaf52e11b155bebe6') OR NOT pg_catalog.has_function_privilege('authenticated',f,'EXECUTE') OR pg_catalog.has_function_privilege('anon',f,'EXECUTE') OR pg_catalog.has_function_privilege('service_role',f,'EXECUTE') THEN RAISE EXCEPTION 'Cross-site source lock postflight failed'; END IF;
END $postflight$;
