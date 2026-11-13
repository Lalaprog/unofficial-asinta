-- EXPERIMENTAL DRAFT ONLY. Not a final project cost or release migration.
-- A Founder records an immutable, explicitly incomplete review of one bounded
-- snapshot. No expense, payment, allocation, Bale or accounting ledger is
-- changed. Missing legacy/external pay, unlinked correction cases, correction
-- allocations, duplicates and unrecorded items remain outside the snapshot;
-- a match is not completeness.
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
DO $preflight$
BEGIN
 IF to_regclass('public.projects') IS NULL OR to_regclass('public.users') IS NULL OR to_regprocedure('public.project_cost_reconciliation_preview(uuid)') IS NULL OR to_regprocedure('public.is_founder()') IS NULL OR to_regprocedure('public.session_assurance_satisfied()') IS NULL OR to_regprocedure('auth.uid()') IS NULL THEN RAISE EXCEPTION 'Project review prerequisites missing'; END IF;
 IF to_regclass('public.project_cost_reviews') IS NOT NULL OR to_regprocedure('public.record_project_cost_review(uuid,uuid,integer,jsonb,jsonb,text)') IS NOT NULL OR to_regprocedure('public.project_cost_review(uuid,integer)') IS NOT NULL OR to_regprocedure('public.guard_project_cost_review_immutable()') IS NOT NULL THEN RAISE EXCEPTION 'Project review objects already exist'; END IF;
END;
$preflight$;
CREATE TABLE public.project_cost_reviews (
 request_id uuid PRIMARY KEY,
 project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE RESTRICT,
 revision integer NOT NULL CHECK(revision>0),
 expected_revision integer NOT NULL CHECK(expected_revision>=0 AND revision=expected_revision+1),
 actor_id uuid NOT NULL,
 snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object' AND octet_length(snapshot::text)<=1048576),
 choices jsonb NOT NULL CHECK(jsonb_typeof(choices)='object'),
 note text NOT NULL CHECK(length(note) BETWEEN 1 AND 500 AND note=btrim(note)),
 included_expenses numeric(16,2) NOT NULL CHECK(included_expenses>=0),
 excluded_expenses numeric(16,2) NOT NULL CHECK(excluded_expenses>=0),
 paid_gross numeric(16,2) NOT NULL CHECK(paid_gross>=0),
 incomplete_total numeric(16,2) NOT NULL CHECK(incomplete_total=included_expenses+paid_gross),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(project_id,revision)
);
ALTER TABLE public.project_cost_reviews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.project_cost_reviews FROM PUBLIC,anon,authenticated,service_role;
DO $table_acl$
BEGIN
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r(role_name) WHERE has_table_privilege(r.role_name,'public.project_cost_reviews','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid='public.project_cost_reviews'::regclass AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege(r.role_name,a.attrelid,a.attname,'SELECT,INSERT,UPDATE'))) THEN RAISE EXCEPTION 'Unexpected project-review table privilege'; END IF;
END;
$table_acl$;
CREATE FUNCTION public.guard_project_cost_review_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$ BEGIN RAISE EXCEPTION 'Project reviews are immutable; record a new review' USING ERRCODE='23514'; END $$;
REVOKE ALL ON FUNCTION public.guard_project_cost_review_immutable() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER guard_project_cost_review_immutable BEFORE UPDATE OR DELETE ON public.project_cost_reviews FOR EACH ROW EXECUTE FUNCTION public.guard_project_cost_review_immutable();

-- Transaction is a record of a reviewed snapshot, not a lock on source data.
-- The snapshot can become stale immediately; read status always rechecks it.
-- Request and project locks serialize exact retries and revision increments.
CREATE FUNCTION public.record_project_cost_review(p_request uuid,p_project uuid,p_expected_revision integer,p_snapshot jsonb,p_choices jsonb,p_note text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid:=auth.uid();v_existing public.project_cost_reviews%ROWTYPE;v_latest integer;v_now jsonb;v_note text;v_exp numeric;v_excluded numeric;v_paid numeric;v_invalid boolean;
BEGIN
 IF v_actor IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Project review requires read committed' USING ERRCODE='P1002'; END IF;
 IF p_request IS NULL OR p_project IS NULL OR p_expected_revision IS NULL OR p_expected_revision<0 OR p_expected_revision>=2147483647 OR p_snapshot IS NULL OR jsonb_typeof(p_snapshot)<>'object' OR octet_length(p_snapshot::text)>1048576 OR p_choices IS NULL OR jsonb_typeof(p_choices)<>'object' OR octet_length(p_choices::text)>100000 OR p_note IS NULL OR length(btrim(p_note)) NOT BETWEEN 1 AND 500 OR btrim(p_note) ~ '[[:cntrl:]]' THEN RAISE EXCEPTION 'Invalid project review' USING ERRCODE='22023'; END IF;
 v_note:=btrim(p_note);
 PERFORM 1 FROM public.users WHERE id=v_actor AND role='founder' FOR SHARE;
 IF NOT FOUND OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('project-cost-review-request:'||p_request::text,0));
 SELECT * INTO v_existing FROM public.project_cost_reviews WHERE request_id=p_request;
 IF FOUND THEN
  IF (v_existing.project_id,v_existing.actor_id,v_existing.expected_revision,v_existing.snapshot-'captured_at',v_existing.choices,v_existing.note) IS DISTINCT FROM (p_project,v_actor,p_expected_revision,p_snapshot-'captured_at',p_choices,v_note) THEN RAISE EXCEPTION 'Review request ID already used for different details' USING ERRCODE='22023'; END IF;
  RETURN jsonb_build_object('request_id',p_request,'project_id',p_project,'revision',v_existing.revision,'replayed',true);
 END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('project-cost-review-project:'||p_project::text,0));
 PERFORM 1 FROM public.projects WHERE id=p_project FOR KEY SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Project unavailable' USING ERRCODE='42501'; END IF;
 SELECT coalesce(max(revision),0) INTO v_latest FROM public.project_cost_reviews WHERE project_id=p_project;
 IF v_latest<>p_expected_revision THEN RAISE EXCEPTION 'Project review changed; reload before saving' USING ERRCODE='40001'; END IF;
 v_now:=public.project_cost_reconciliation_preview(p_project);
 IF v_now-'captured_at' IS DISTINCT FROM p_snapshot-'captured_at' THEN RAISE EXCEPTION 'Project evidence changed; reload and review again' USING ERRCODE='40001'; END IF;
 -- Require exactly one explicit decision per expense and a reason for each
 -- exclusion. Do not infer duplicate status from an AI flag or a name.
 IF (SELECT count(*) FROM jsonb_object_keys(p_choices))<>jsonb_array_length(v_now->'expenses') THEN RAISE EXCEPTION 'Review every expense exactly once' USING ERRCODE='22023'; END IF;
 SELECT EXISTS(SELECT 1 FROM jsonb_array_elements(v_now->'expenses') e WHERE NOT (p_choices ? (e->>'id'))) OR EXISTS(
  SELECT 1 FROM jsonb_each(p_choices) c WHERE jsonb_typeof(c.value)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(CASE WHEN jsonb_typeof(c.value)='object' THEN c.value ELSE '{}'::jsonb END))<>2 OR NOT (c.value ? 'decision' AND c.value ? 'reason') OR coalesce(c.value->>'decision','') NOT IN ('include','exclude')
   OR (c.value->>'decision'='include' AND c.value->'reason'<>'null'::jsonb)
   OR (c.value->>'decision'='exclude' AND (jsonb_typeof(c.value->'reason') IS DISTINCT FROM 'string' OR length(btrim(c.value->>'reason')) NOT BETWEEN 1 AND 300 OR btrim(c.value->>'reason')<>(c.value->>'reason') OR (c.value->>'reason') ~ '[[:cntrl:]]'))
 ) INTO v_invalid;
 IF v_invalid THEN RAISE EXCEPTION 'Invalid expense decisions or exclusion reasons' USING ERRCODE='22023'; END IF;
 SELECT coalesce(sum((e->>'amount')::numeric) FILTER (WHERE p_choices->(e->>'id')->>'decision'='include'),0),coalesce(sum((e->>'amount')::numeric) FILTER (WHERE p_choices->(e->>'id')->>'decision'='exclude'),0) INTO v_exp,v_excluded FROM jsonb_array_elements(v_now->'expenses') e;
 SELECT coalesce(sum((a->>'gross')::numeric),0) INTO v_paid FROM jsonb_array_elements(v_now->'paid_allocations') a;
 IF v_exp<0 OR v_excluded<0 OR v_paid<0 OR v_exp<>round(v_exp,2) OR v_excluded<>round(v_excluded,2) OR v_paid<>round(v_paid,2) OR v_exp+v_paid>=100000000000000 THEN RAISE EXCEPTION 'Invalid reviewed totals' USING ERRCODE='22023'; END IF;
 INSERT INTO public.project_cost_reviews(request_id,project_id,revision,expected_revision,actor_id,snapshot,choices,note,included_expenses,excluded_expenses,paid_gross,incomplete_total)
 VALUES(p_request,p_project,v_latest+1,v_latest,v_actor,v_now,p_choices,v_note,v_exp,v_excluded,v_paid,v_exp+v_paid);
 RETURN jsonb_build_object('request_id',p_request,'project_id',p_project,'revision',v_latest+1,'replayed',false);
END;
$$;
REVOKE ALL ON FUNCTION public.record_project_cost_review(uuid,uuid,integer,jsonb,jsonb,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.record_project_cost_review(uuid,uuid,integer,jsonb,jsonb,text) TO authenticated;

-- A matching snapshot means only the included sources match at this read; it
-- does not establish completeness, accounting correctness or proof of payment.
CREATE FUNCTION public.project_cost_review(p_project uuid,p_revision integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_row public.project_cost_reviews%ROWTYPE;v_latest integer;v_now jsonb;v_freshness text:='unavailable';
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 IF p_project IS NULL OR (p_revision IS NOT NULL AND p_revision<1) OR NOT EXISTS(SELECT 1 FROM public.projects WHERE id=p_project) THEN RAISE EXCEPTION 'Project review unavailable' USING ERRCODE='22023'; END IF;
 SELECT coalesce(max(revision),0) INTO v_latest FROM public.project_cost_reviews WHERE project_id=p_project;
 IF v_latest=0 AND p_revision IS NULL THEN RETURN jsonb_build_object('project_id',p_project,'found',false,'latest_revision',0); END IF;
 SELECT * INTO v_row FROM public.project_cost_reviews WHERE project_id=p_project AND revision=coalesce(p_revision,v_latest);
 IF NOT FOUND THEN RAISE EXCEPTION 'Project review unavailable' USING ERRCODE='P0002'; END IF;
 BEGIN
  v_now:=public.project_cost_reconciliation_preview(p_project);
  v_freshness:=CASE WHEN v_now-'captured_at'=v_row.snapshot-'captured_at' THEN 'matches' ELSE 'changed' END;
 EXCEPTION WHEN others THEN v_freshness:='unavailable'; END;
 RETURN jsonb_build_object('project_id',p_project,'found',true,'latest_revision',v_latest,'revision',v_row.revision,'request_id',v_row.request_id,'actor_id',v_row.actor_id,'recorded_at',v_row.recorded_at,'snapshot',v_row.snapshot,'choices',v_row.choices,'note',v_row.note,'included_expenses',v_row.included_expenses::text,'excluded_expenses',v_row.excluded_expenses::text,'paid_gross',v_row.paid_gross::text,'incomplete_total',v_row.incomplete_total::text,'freshness',v_freshness);
END;
$$;
REVOKE ALL ON FUNCTION public.project_cost_review(uuid,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.project_cost_review(uuid,integer) TO authenticated;
DO $function_acl$
BEGIN
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['anon','service_role']) r(role_name) WHERE has_function_privilege(r.role_name,'public.record_project_cost_review(uuid,uuid,integer,jsonb,jsonb,text)','EXECUTE') OR has_function_privilege(r.role_name,'public.project_cost_review(uuid,integer)','EXECUTE') OR has_function_privilege(r.role_name,'public.guard_project_cost_review_immutable()','EXECUTE')) OR has_function_privilege('authenticated','public.guard_project_cost_review_immutable()','EXECUTE') OR NOT has_function_privilege('authenticated','public.record_project_cost_review(uuid,uuid,integer,jsonb,jsonb,text)','EXECUTE') OR NOT has_function_privilege('authenticated','public.project_cost_review(uuid,integer)','EXECUTE') THEN RAISE EXCEPTION 'Unexpected project-review function privilege'; END IF;
END;
$function_acl$;
