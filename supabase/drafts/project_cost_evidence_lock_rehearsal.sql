-- HELD experimental snapshot capture locks, synthetic databases only.
-- Whole-table SHARE locks may block unrelated work. A deadlock or 3-second
-- lock timeout aborts one transaction; callers must reload before retrying.
-- This must not be deployed without full writer, function, role and target audit.
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
DO $hold$ BEGIN IF current_setting('app.cost_evidence_lock_candidate',true) IS DISTINCT FROM 'synthetic-only' THEN RAISE EXCEPTION 'Evidence lock candidate held for synthetic rehearsal'; END IF; END $hold$;
LOCK TABLE public.project_cost_corrected_reviews,public.project_cost_cross_site_reviews IN SHARE ROW EXCLUSIVE MODE;
DO $preflight$ DECLARE r record; f oid; BEGIN
 FOR r IN SELECT * FROM (VALUES
 ('public.record_project_cost_corrected_review(uuid,uuid,integer,jsonb,jsonb,text,boolean)','61fd78c7e4b02206b119f706fc4105410de11980082dd3b5b190f9f71ce75ce0'),
 ('public.record_project_cost_cross_site_review(uuid,uuid,integer,jsonb,jsonb,jsonb,text,boolean)','be890d31b8751f11ff18745fa7ad8d3010d6ae06e46980b3818f2c47743695dc')
 ) AS x(signature,digest) LOOP
  f:=to_regprocedure(r.signature);
  IF f IS NULL OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid=f AND p.prosecdef AND p.provolatile='v' AND p.proconfig @> ARRAY['search_path=""'] AND pg_catalog.pg_get_userbyid(p.proowner)='postgres' AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=r.digest) OR NOT has_function_privilege('authenticated',f,'EXECUTE') OR has_function_privilege('anon',f,'EXECUTE') OR has_function_privilege('service_role',f,'EXECUTE') THEN RAISE EXCEPTION 'Evidence writer dependency changed: %',r.signature; END IF;
 END LOOP;
END $preflight$;
CREATE OR REPLACE FUNCTION public.record_project_cost_corrected_review(p_request uuid,p_project uuid,p_expected_revision integer,p_snapshot jsonb,p_choices jsonb,p_note text,p_ack boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid:=auth.uid();v_existing public.project_cost_corrected_reviews%ROWTYPE;v_latest integer;v_now jsonb;v_result jsonb;v_note text;
BEGIN
 IF v_actor IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance required' USING ERRCODE='42501'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Corrected review requires read committed' USING ERRCODE='P1002'; END IF;
 IF p_request IS NULL OR p_project IS NULL OR p_expected_revision IS NULL OR p_expected_revision<0 OR p_expected_revision>=2147483647 OR jsonb_typeof(p_snapshot) IS DISTINCT FROM 'object' OR octet_length(p_snapshot::text)>2097152 OR jsonb_typeof(p_choices) IS DISTINCT FROM 'object' OR octet_length(p_choices::text)>500000 OR p_note IS NULL OR length(btrim(p_note)) NOT BETWEEN 1 AND 500 OR btrim(p_note) ~ '[[:cntrl:]]' OR p_ack IS DISTINCT FROM true THEN RAISE EXCEPTION 'Invalid corrected review' USING ERRCODE='22023'; END IF;
 v_note:=btrim(p_note);
 PERFORM pg_catalog.set_config('lock_timeout','3s',true);
 PERFORM 1 FROM public.users WHERE id=v_actor AND role='founder' FOR SHARE;
 IF NOT FOUND OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance required' USING ERRCODE='42501'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('corrected-cost-review-request:'||p_request::text,0));
 SELECT * INTO v_existing FROM public.project_cost_corrected_reviews WHERE request_id=p_request;
 IF FOUND THEN
  IF (v_existing.project_id,v_existing.actor_id,v_existing.expected_revision,v_existing.snapshot #- '{historical_review,base,captured_at}',v_existing.choices,v_existing.note) IS DISTINCT FROM (p_project,v_actor,p_expected_revision,p_snapshot #- '{historical_review,base,captured_at}',p_choices,v_note) THEN RAISE EXCEPTION 'Corrected review request already used for different details' USING ERRCODE='22023'; END IF;
  RETURN jsonb_build_object('request_id',p_request,'project_id',p_project,'revision',v_existing.revision,'replayed',true);
 END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('corrected-cost-review-project:'||p_project::text,0));
 PERFORM 1 FROM public.projects WHERE id=p_project FOR KEY SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Project unavailable' USING ERRCODE='42501'; END IF;
 -- Relation SHARE locks protect this capture against concurrent inserts, updates
 -- and deletes, including evidence not yet present in the submitted snapshot.
 -- These are global and short-lived. Contention or a lock cycle aborts the
 -- transaction; no partial review is committed. They do not cover DDL/owners.
 PERFORM pg_catalog.set_config('lock_timeout','3s',true);
 LOCK TABLE public.users,public.workers,public.projects,public.supervisor_period_payroll,public.historical_external_worker_payroll,public.paid_period_assertion_cases,public.paid_payroll_adjustment_cases,public.expenses,public.confirmed_rental_expenses,public.payroll,public.weekly_worker_draft_sources,public.weekly_worker_paid_allocations,public.payroll_payment_dates,public.historical_worker_attributions,public.historical_worker_attribution_sites,public.project_cost_correction_attributions,public.project_cost_correction_sites IN SHARE MODE;
 SELECT coalesce(max(revision),0) INTO v_latest FROM public.project_cost_corrected_reviews WHERE project_id=p_project;
 IF v_latest<>p_expected_revision THEN RAISE EXCEPTION 'Corrected review changed; reload and review' USING ERRCODE='40001'; END IF;
 -- Store server-captured evidence, not a caller-supplied capture time. Check
 -- both the submitted review and calculation against it. This does not lock
 -- every source writer; it can become stale before or after commit.
 v_now:=public.project_cost_correction_inventory(p_project);
 IF v_now #- '{historical_review,base,captured_at}' IS DISTINCT FROM p_snapshot #- '{historical_review,base,captured_at}' THEN RAISE EXCEPTION 'Project evidence changed; reload and review' USING ERRCODE='40001'; END IF;
 v_result:=public.project_cost_corrected_preview(p_project,v_now,p_choices,true);
 INSERT INTO public.project_cost_corrected_reviews(request_id,project_id,revision,expected_revision,actor_id,snapshot,choices,result,note)
 VALUES(p_request,p_project,v_latest+1,v_latest,v_actor,v_now,p_choices,v_result,v_note);
 RETURN jsonb_build_object('request_id',p_request,'project_id',p_project,'revision',v_latest+1,'replayed',false);
END $$;
CREATE OR REPLACE FUNCTION public.record_project_cost_cross_site_review(p_request uuid,p_project uuid,p_expected_revision integer,p_snapshot jsonb,p_choices jsonb,p_cross_sites jsonb,p_note text,p_ack boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid:=auth.uid();v_existing public.project_cost_cross_site_reviews%ROWTYPE;v_latest integer;v_now jsonb;v_result jsonb;v_note text;v_source_project uuid;
BEGIN
 IF v_actor IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance required' USING ERRCODE='42501'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Cross-site review requires read committed' USING ERRCODE='P1002'; END IF;
 IF p_request IS NULL OR p_project IS NULL OR p_expected_revision IS NULL OR p_expected_revision<0 OR p_expected_revision>=2147483647 OR jsonb_typeof(p_snapshot) IS DISTINCT FROM 'object' OR octet_length(p_snapshot::text)>2097152 OR jsonb_typeof(p_choices) IS DISTINCT FROM 'object' OR octet_length(p_choices::text)>500000 OR jsonb_typeof(p_cross_sites) IS DISTINCT FROM 'object' OR octet_length(p_cross_sites::text)>500000 OR p_note IS NULL OR length(btrim(p_note)) NOT BETWEEN 1 AND 500 OR btrim(p_note) ~ '[[:cntrl:]]' OR p_ack IS DISTINCT FROM true THEN RAISE EXCEPTION 'Invalid cross-site review' USING ERRCODE='22023'; END IF;
 v_note:=btrim(p_note);
 PERFORM pg_catalog.set_config('lock_timeout','3s',true);
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
 -- Validate the bounded inventory, then block attribution INSERT/UPDATE/DELETE
 -- for all cases, including external and cases absent from this snapshot. Take
 -- the locks before recapturing the inventory. These are relation locks, not
 -- predicate locks; they serialize the whole attribution workload.
 IF pg_catalog.jsonb_typeof(p_snapshot->'corrections') IS DISTINCT FROM 'array' OR pg_catalog.jsonb_array_length(CASE WHEN pg_catalog.jsonb_typeof(p_snapshot->'corrections')='array' THEN p_snapshot->'corrections' ELSE '[]'::jsonb END)>500 THEN RAISE EXCEPTION 'Invalid correction case references' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM pg_catalog.jsonb_array_elements(p_snapshot->'corrections') c WHERE pg_catalog.jsonb_typeof(c.value) IS DISTINCT FROM 'object' OR coalesce(c.value->>'kind','') NOT IN ('voucher','external_worker') OR coalesce(c.value->>'case_id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN RAISE EXCEPTION 'Invalid correction case references' USING ERRCODE='22023'; END IF;
 -- Case relations precede attribution relations: the external attribution
 -- writer locks its case tables before inserting attribution rows. Never wait
 -- for its case lock while holding an attribution lock it needs.
 -- Relation SHARE locks protect this capture against concurrent inserts, updates
 -- and deletes, including evidence not yet present in the submitted snapshot.
 -- These are global and short-lived. Contention or a lock cycle aborts the
 -- transaction; no partial review is committed. They do not cover DDL/owners.
 PERFORM pg_catalog.set_config('lock_timeout','3s',true);
 LOCK TABLE public.users,public.workers,public.projects,public.supervisor_period_payroll,public.historical_external_worker_payroll,public.paid_period_assertion_cases,public.paid_payroll_adjustment_cases,public.expenses,public.confirmed_rental_expenses,public.payroll,public.weekly_worker_draft_sources,public.weekly_worker_paid_allocations,public.payroll_payment_dates,public.historical_worker_attributions,public.historical_worker_attribution_sites,public.project_cost_correction_attributions,public.project_cost_correction_sites IN SHARE MODE;
 SELECT coalesce(max(revision),0) INTO v_latest FROM public.project_cost_cross_site_reviews WHERE project_id=p_project;
 IF v_latest<>p_expected_revision THEN RAISE EXCEPTION 'Cross-site review changed; reload and review' USING ERRCODE='40001'; END IF;
 v_now:=public.project_cost_correction_inventory(p_project);
 IF v_now #- '{historical_review,base,captured_at}' IS DISTINCT FROM p_snapshot #- '{historical_review,base,captured_at}' THEN RAISE EXCEPTION 'Project evidence changed; reload and review' USING ERRCODE='40001'; END IF;
 -- Attribution writes and selected source-review saves cannot commit here.
 -- Other evidence writers remain unlocked; freshness may still change.
 v_result:=public.project_cost_cross_site_corrected_preview(p_project,v_now,p_choices,p_cross_sites,true);
 INSERT INTO public.project_cost_cross_site_reviews(request_id,project_id,revision,expected_revision,actor_id,snapshot,choices,cross_sites,result,note)
 VALUES(p_request,p_project,v_latest+1,v_latest,v_actor,v_now,p_choices,p_cross_sites,v_result,v_note);
 RETURN jsonb_build_object('request_id',p_request,'project_id',p_project,'revision',v_latest+1,'replayed',false);
END $$;
