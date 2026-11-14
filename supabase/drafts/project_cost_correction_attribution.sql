-- DRAFT ONLY. Founder assertions about gross project-cost effects of resolved
-- worker paid-period cases. A net pay difference is NOT automatically a gross
-- cost change; the Founder must review source documents and enter an explicit
-- signed gross split. This writes evidence only: no expense, voucher, payment,
-- allocation, saved project-cost review or transfer is created or changed.
-- Existing reviews deliberately continue to exclude these assertions. It is
-- not a complete accounting report and requires a coordinated review before use.
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
DO $preflight$ BEGIN
 IF to_regclass('public.projects') IS NULL OR to_regclass('public.users') IS NULL OR to_regclass('public.workers') IS NULL OR to_regclass('public.payroll') IS NULL OR to_regclass('public.historical_external_worker_payroll') IS NULL OR to_regclass('public.supervisor_period_payroll') IS NULL OR to_regclass('public.paid_period_assertion_case_events') IS NULL OR to_regclass('public.paid_payroll_adjustment_cases') IS NULL OR to_regclass('public.paid_period_assertion_cases') IS NULL OR to_regprocedure('app_private.paid_adjustment_voucher_snapshot(public.payroll)') IS NULL OR to_regprocedure('public.paid_period_assertion_snapshot(text,uuid)') IS NULL OR to_regprocedure('public.is_founder()') IS NULL OR to_regprocedure('public.session_assurance_satisfied()') IS NULL OR to_regprocedure('auth.uid()') IS NULL THEN RAISE EXCEPTION 'Correction attribution prerequisites missing'; END IF;
 IF to_regclass('public.project_cost_correction_attributions') IS NOT NULL OR to_regclass('public.project_cost_correction_sites') IS NOT NULL OR to_regprocedure('public.project_cost_correction_attribution(text,uuid,integer)') IS NOT NULL OR to_regprocedure('public.record_project_cost_correction_attribution(uuid,text,uuid,integer,jsonb,numeric,jsonb,text,boolean)') IS NOT NULL OR to_regprocedure('public.project_cost_correction_attribution_sites(uuid)') IS NOT NULL OR to_regprocedure('app_private.project_cost_correction_case(text,uuid)') IS NOT NULL OR to_regprocedure('app_private.guard_project_cost_correction_immutable()') IS NOT NULL THEN RAISE EXCEPTION 'Correction attribution name collision'; END IF;
END $preflight$;
CREATE TABLE public.project_cost_correction_attributions (
 request_id uuid PRIMARY KEY,
 source_kind text NOT NULL CHECK(source_kind IN ('voucher','external_worker')),
 voucher_case_id uuid REFERENCES public.paid_payroll_adjustment_cases(id) ON DELETE RESTRICT,
 external_case_id uuid REFERENCES public.paid_period_assertion_cases(id) ON DELETE RESTRICT,
 revision integer NOT NULL CHECK(revision>0),
 expected_case jsonb NOT NULL CHECK(jsonb_typeof(expected_case)='object' AND octet_length(expected_case::text)<=65536),
 gross_change numeric(12,2) NOT NULL,
 split jsonb NOT NULL CHECK(jsonb_typeof(split)='array' AND jsonb_array_length(split)<=50),
 note text NOT NULL CHECK(length(note) BETWEEN 1 AND 500 AND note=btrim(note)),
 recorded_by uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((source_kind='voucher' AND voucher_case_id IS NOT NULL AND external_case_id IS NULL) OR (source_kind='external_worker' AND external_case_id IS NOT NULL AND voucher_case_id IS NULL))
);
CREATE UNIQUE INDEX project_cost_correction_voucher_revision ON public.project_cost_correction_attributions(voucher_case_id,revision) WHERE voucher_case_id IS NOT NULL;
CREATE UNIQUE INDEX project_cost_correction_external_revision ON public.project_cost_correction_attributions(external_case_id,revision) WHERE external_case_id IS NOT NULL;
CREATE TABLE public.project_cost_correction_sites (
 request_id uuid NOT NULL REFERENCES public.project_cost_correction_attributions(request_id) ON DELETE RESTRICT,
 project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE RESTRICT,
 gross_change numeric(12,2) NOT NULL CHECK(gross_change<>0),
 PRIMARY KEY(request_id,project_id)
);
CREATE INDEX project_cost_correction_sites_project_idx ON public.project_cost_correction_sites(project_id,request_id);
ALTER TABLE public.project_cost_correction_attributions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_cost_correction_sites ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.project_cost_correction_attributions,public.project_cost_correction_sites FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION app_private.guard_project_cost_correction_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$ BEGIN RAISE EXCEPTION 'Correction attribution history is immutable' USING ERRCODE='23514'; END $$;
REVOKE ALL ON FUNCTION app_private.guard_project_cost_correction_immutable() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER guard_project_cost_correction_immutable BEFORE UPDATE OR DELETE ON public.project_cost_correction_attributions FOR EACH ROW EXECUTE FUNCTION app_private.guard_project_cost_correction_immutable();
CREATE TRIGGER guard_project_cost_correction_sites_immutable BEFORE UPDATE OR DELETE ON public.project_cost_correction_sites FOR EACH ROW EXECUTE FUNCTION app_private.guard_project_cost_correction_immutable();

-- Internal exact evidence. Refuse a changed original source rather than silently
-- binding an attribution to a different voucher or assertion.
CREATE FUNCTION app_private.project_cost_correction_case(p_kind text,p_case uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v jsonb;v_original jsonb;v_current jsonb;v_source uuid;v_related jsonb;v_count bigint;
BEGIN
 IF p_kind='voucher' THEN
  SELECT to_jsonb(c)||jsonb_build_object('difference',c.difference::text),c.original_voucher,app_private.paid_adjustment_voucher_snapshot(p),c.payroll_id INTO v,v_original,v_current,v_source
  FROM public.paid_payroll_adjustment_cases c JOIN public.payroll p ON p.id=c.payroll_id AND p.worker_id=c.worker_id AND p.status='paid' WHERE c.id=p_case;
 ELSIF p_kind='external_worker' THEN
  SELECT to_jsonb(c)||jsonb_build_object('difference',c.difference::text),c.original_snapshot,public.paid_period_assertion_snapshot('external_worker',c.external_worker_id),c.external_worker_id INTO v,v_original,v_current,v_source
  FROM public.paid_period_assertion_cases c WHERE c.id=p_case AND c.source_kind='external_worker';
 ELSE RAISE EXCEPTION 'Invalid worker correction kind' USING ERRCODE='22023'; END IF;
 IF v IS NULL OR v_original IS DISTINCT FROM v_current THEN RAISE EXCEPTION 'Original paid-period evidence unavailable or changed' USING ERRCODE='40001'; END IF;
 -- Bind the decision to every known case on the same original period, not only
 -- this case. An added or resolved case invalidates an earlier review. A hash
 -- binds each sibling's original source without repeating large snapshots.
 IF p_kind='voucher' THEN
  SELECT count(*),coalesce(jsonb_agg((to_jsonb(c)-'original_voucher')||jsonb_build_object('difference',c.difference::text,'original_fingerprint',encode(sha256(convert_to(c.original_voucher::text,'UTF8')),'hex')) ORDER BY c.id),'[]'::jsonb) INTO v_count,v_related FROM public.paid_payroll_adjustment_cases c WHERE c.payroll_id=v_source;
 ELSE
  SELECT count(*),coalesce(jsonb_agg((to_jsonb(c)-'original_snapshot')||jsonb_build_object('difference',c.difference::text,'original_fingerprint',encode(sha256(convert_to(c.original_snapshot::text,'UTF8')),'hex')) ORDER BY c.id),'[]'::jsonb) INTO v_count,v_related FROM public.paid_period_assertion_cases c WHERE c.source_kind='external_worker' AND c.external_worker_id=v_source;
 END IF;
 IF v_count>100 THEN RAISE EXCEPTION 'More than 100 related cases; separate reconciliation required' USING ERRCODE='54000'; END IF;
 v:=v||jsonb_build_object('related_cases',v_related);
 IF octet_length(v::text)>65536 THEN RAISE EXCEPTION 'Correction case evidence too large' USING ERRCODE='54000'; END IF;
 RETURN v;
END $$;
REVOKE ALL ON FUNCTION app_private.project_cost_correction_case(text,uuid) FROM PUBLIC,anon,authenticated,service_role;

-- Return current case and latest or chosen immutable evidence revision. Neither
-- an absent review nor a saved human assertion is proof of payment or cost.
-- Each revision replaces the full split, never adds to its predecessor.
CREATE FUNCTION public.project_cost_correction_attribution(p_kind text,p_case uuid,p_revision integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_case jsonb;v_last integer;v_row public.project_cost_correction_attributions%ROWTYPE;v_split jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance required' USING ERRCODE='42501'; END IF;
 IF p_case IS NULL OR p_kind IS NULL OR p_kind NOT IN ('voucher','external_worker') OR (p_revision IS NOT NULL AND p_revision<1) THEN RAISE EXCEPTION 'Invalid correction attribution request' USING ERRCODE='22023'; END IF;
 v_case:=app_private.project_cost_correction_case(p_kind,p_case);
 SELECT coalesce(max(revision),0) INTO v_last FROM public.project_cost_correction_attributions WHERE source_kind=p_kind AND coalesce(voucher_case_id,external_case_id)=p_case;
 SELECT * INTO v_row FROM public.project_cost_correction_attributions WHERE source_kind=p_kind AND coalesce(voucher_case_id,external_case_id)=p_case AND revision=coalesce(p_revision,v_last);
 IF NOT FOUND THEN
  IF p_revision IS NOT NULL THEN RAISE EXCEPTION 'Correction attribution revision unavailable' USING ERRCODE='P0002'; END IF;
  RETURN jsonb_build_object('source_kind',p_kind,'case_id',p_case,'case',v_case,'latest_revision',0,'attribution',NULL);
 END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('project_id',project_id,'gross_change',gross_change::text) ORDER BY project_id),'[]'::jsonb) INTO v_split FROM public.project_cost_correction_sites WHERE request_id=v_row.request_id;
 IF v_split IS DISTINCT FROM v_row.split OR (SELECT coalesce(sum(gross_change),0) FROM public.project_cost_correction_sites WHERE request_id=v_row.request_id)<>v_row.gross_change THEN RAISE EXCEPTION 'Correction split evidence differs; investigate' USING ERRCODE='22023'; END IF;
 RETURN jsonb_build_object('source_kind',p_kind,'case_id',p_case,'case',v_case,'latest_revision',v_last,'attribution',jsonb_build_object('request_id',v_row.request_id,'revision',v_row.revision,'case_snapshot',v_row.expected_case,'case_changed',v_row.expected_case IS DISTINCT FROM v_case,'gross_change',v_row.gross_change::text,'split',v_row.split,'note',v_row.note,'recorded_by',v_row.recorded_by,'recorded_at',v_row.recorded_at));
END $$;

CREATE FUNCTION public.record_project_cost_correction_attribution(p_request uuid,p_kind text,p_case uuid,p_expected_revision integer,p_expected_case jsonb,p_gross_change numeric,p_split jsonb,p_note text,p_ack boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid:=auth.uid();v_case jsonb;v_old public.project_cost_correction_attributions%ROWTYPE;v_worker uuid;v_payroll uuid;v_latest integer;v_item jsonb;v_project uuid;v_amount numeric;v_sum numeric:=0;v_ids uuid[]:='{}';v_split jsonb:='[]'::jsonb;v_note text;
BEGIN
 IF v_actor IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance required' USING ERRCODE='42501'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Correction attribution requires read committed' USING ERRCODE='P1002'; END IF;
 IF p_request IS NULL OR p_case IS NULL OR p_kind IS NULL OR p_kind NOT IN ('voucher','external_worker') OR p_expected_revision IS NULL OR p_expected_revision NOT BETWEEN 0 AND 2147483646 OR p_expected_case IS NULL OR jsonb_typeof(p_expected_case)<>'object' OR octet_length(p_expected_case::text)>65536 OR p_gross_change IS NULL OR p_gross_change='NaN'::numeric OR abs(p_gross_change)>=10000000000 OR p_gross_change<>round(p_gross_change,2) OR p_split IS NULL OR jsonb_typeof(p_split)<>'array' OR jsonb_array_length(p_split)>50 OR octet_length(p_split::text)>16384 OR p_note IS NULL OR length(btrim(p_note)) NOT BETWEEN 1 AND 500 OR btrim(p_note) ~ '[[:cntrl:]]' OR p_ack IS DISTINCT FROM true THEN RAISE EXCEPTION 'Invalid correction attribution' USING ERRCODE='22023'; END IF;
 v_note:=btrim(p_note);
 FOR v_item IN SELECT value FROM jsonb_array_elements(p_split) LOOP
  IF jsonb_typeof(v_item)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(CASE WHEN jsonb_typeof(v_item)='object' THEN v_item ELSE '{}'::jsonb END))<>2 OR NOT (v_item ? 'project_id' AND v_item ? 'gross_change') OR jsonb_typeof(v_item->'project_id') IS DISTINCT FROM 'string' OR (v_item->>'project_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR jsonb_typeof(v_item->'gross_change') IS DISTINCT FROM 'string' OR (v_item->>'gross_change') !~ '^-?(0|[1-9][0-9]{0,9})\.[0-9]{2}$' THEN RAISE EXCEPTION 'Invalid correction project or gross change' USING ERRCODE='22023'; END IF;
  v_project:=(v_item->>'project_id')::uuid;v_amount:=(v_item->>'gross_change')::numeric;
  IF v_amount=0 OR abs(v_amount)>=10000000000 OR v_project=ANY(v_ids) THEN RAISE EXCEPTION 'Duplicate project or invalid zero/large site amount' USING ERRCODE='22023'; END IF;
  v_ids:=array_append(v_ids,v_project);v_sum:=v_sum+v_amount;v_split:=v_split||jsonb_build_array(jsonb_build_object('project_id',v_project,'gross_change',v_amount::numeric(12,2)::text));
 END LOOP;
 IF v_sum<>p_gross_change THEN RAISE EXCEPTION 'Site changes must equal the reviewed gross change' USING ERRCODE='22023'; END IF;
 SELECT coalesce(jsonb_agg(value ORDER BY (value->>'project_id')::uuid),'[]'::jsonb) INTO v_split FROM jsonb_array_elements(v_split);
 -- The external case writers use this global order. Acquire the same locks
 -- before row/advisory locks, so a sibling case cannot change between the
 -- evidence check and commit. Voucher writers already serialize on the worker
 -- and payroll rows acquired below.
 IF p_kind='external_worker' THEN
  LOCK TABLE public.users,public.workers,public.supervisor_period_payroll,public.historical_external_worker_payroll,public.paid_period_assertion_cases,public.paid_period_assertion_case_events IN SHARE ROW EXCLUSIVE MODE;
 END IF;
 -- Same request and case locks in stable order; rows remain immutable.
 PERFORM 1 FROM public.users WHERE id=v_actor AND role='founder' FOR SHARE;
 IF NOT FOUND OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance required' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('cost-correction-request:'||p_request::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('cost-correction-case:'||p_kind||':'||p_case::text,0));
 IF p_kind='voucher' THEN
  SELECT worker_id,payroll_id INTO v_worker,v_payroll FROM public.paid_payroll_adjustment_cases WHERE id=p_case;
  IF NOT FOUND THEN RAISE EXCEPTION 'Correction case unavailable' USING ERRCODE='P0002'; END IF;
  PERFORM 1 FROM public.workers WHERE id=v_worker FOR UPDATE;
  PERFORM 1 FROM public.payroll WHERE id=v_payroll AND worker_id=v_worker FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Original voucher unavailable' USING ERRCODE='40001'; END IF;
  PERFORM 1 FROM public.paid_payroll_adjustment_cases WHERE id=p_case AND payroll_id=v_payroll AND worker_id=v_worker FOR SHARE;
 ELSE
  PERFORM 1 FROM public.paid_period_assertion_cases WHERE id=p_case AND source_kind='external_worker' FOR SHARE;
 END IF;
 IF NOT FOUND THEN RAISE EXCEPTION 'Correction case unavailable' USING ERRCODE='P0002'; END IF;
 v_case:=app_private.project_cost_correction_case(p_kind,p_case);
 SELECT * INTO v_old FROM public.project_cost_correction_attributions WHERE request_id=p_request;
 IF FOUND THEN
  IF (v_old.source_kind,coalesce(v_old.voucher_case_id,v_old.external_case_id),v_old.revision,v_old.expected_case,v_old.gross_change,v_old.split,v_old.note,v_old.recorded_by) IS DISTINCT FROM (p_kind,p_case,p_expected_revision+1,p_expected_case,p_gross_change,v_split,v_note,v_actor) THEN RAISE EXCEPTION 'Correction request already used for different details' USING ERRCODE='22023'; END IF;
  IF v_case IS DISTINCT FROM v_old.expected_case THEN RAISE EXCEPTION 'Correction case changed; investigate before retry' USING ERRCODE='40001'; END IF;
  IF (SELECT coalesce(jsonb_agg(jsonb_build_object('project_id',project_id,'gross_change',gross_change::text) ORDER BY project_id),'[]'::jsonb) FROM public.project_cost_correction_sites WHERE request_id=p_request) IS DISTINCT FROM v_old.split THEN RAISE EXCEPTION 'Correction split evidence differs; investigate' USING ERRCODE='22023'; END IF;
  RETURN jsonb_build_object('request_id',p_request,'source_kind',p_kind,'case_id',p_case,'revision',v_old.revision,'replayed',true);
 END IF;
 IF v_case IS DISTINCT FROM p_expected_case THEN RAISE EXCEPTION 'Correction case changed; reload and review' USING ERRCODE='40001'; END IF;
 IF v_case->>'status' NOT IN ('settled_external','no_transfer') THEN RAISE EXCEPTION 'Resolve the original-period case before attributing project cost' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_case->'related_cases') c WHERE c->>'status'='pending') THEN RAISE EXCEPTION 'Resolve all pending cases for the original period before attributing project cost' USING ERRCODE='22023'; END IF;
 SELECT coalesce(max(revision),0) INTO v_latest FROM public.project_cost_correction_attributions WHERE source_kind=p_kind AND coalesce(voucher_case_id,external_case_id)=p_case;
 IF v_latest<>p_expected_revision THEN RAISE EXCEPTION 'Correction attribution changed; reload and review' USING ERRCODE='40001'; END IF;
 IF (SELECT count(*) FROM public.projects WHERE id=ANY(v_ids))<>cardinality(v_ids) THEN RAISE EXCEPTION 'Correction project unavailable' USING ERRCODE='22023'; END IF;
 INSERT INTO public.project_cost_correction_attributions(request_id,source_kind,voucher_case_id,external_case_id,revision,expected_case,gross_change,split,note,recorded_by)
 VALUES(p_request,p_kind,CASE WHEN p_kind='voucher' THEN p_case END,CASE WHEN p_kind='external_worker' THEN p_case END,v_latest+1,v_case,p_gross_change,v_split,v_note,v_actor);
 INSERT INTO public.project_cost_correction_sites(request_id,project_id,gross_change) SELECT p_request,(x->>'project_id')::uuid,(x->>'gross_change')::numeric FROM jsonb_array_elements(v_split) x;
 RETURN jsonb_build_object('request_id',p_request,'source_kind',p_kind,'case_id',p_case,'revision',v_latest+1,'replayed',false);
END $$;
-- Current site evidence only: choose each case's latest FULL replacement first,
-- then select its site. A later revision which removes a site must not resurrect
-- its earlier site amount. This is separate from all existing cost totals.
CREATE FUNCTION public.project_cost_correction_attribution_sites(p_project uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_count bigint;v_bad boolean;v_items jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance required' USING ERRCODE='42501'; END IF;
 IF p_project IS NULL OR NOT EXISTS(SELECT 1 FROM public.projects WHERE id=p_project) THEN RAISE EXCEPTION 'Project unavailable' USING ERRCODE='42501'; END IF;
 SELECT count(*) INTO v_count FROM public.project_cost_correction_sites s JOIN public.project_cost_correction_attributions a ON a.request_id=s.request_id
 WHERE s.project_id=p_project AND a.revision=(SELECT max(b.revision) FROM public.project_cost_correction_attributions b WHERE b.source_kind=a.source_kind AND coalesce(b.voucher_case_id,b.external_case_id)=coalesce(a.voucher_case_id,a.external_case_id));
 IF v_count>500 THEN RAISE EXCEPTION 'More than 500 correction attributions; separate reconciliation required' USING ERRCODE='54000'; END IF;
 SELECT EXISTS(SELECT 1 FROM public.project_cost_correction_sites s JOIN public.project_cost_correction_attributions a ON a.request_id=s.request_id
 WHERE s.project_id=p_project AND a.revision=(SELECT max(b.revision) FROM public.project_cost_correction_attributions b WHERE b.source_kind=a.source_kind AND coalesce(b.voucher_case_id,b.external_case_id)=coalesce(a.voucher_case_id,a.external_case_id)) AND (
  (SELECT coalesce(jsonb_agg(jsonb_build_object('project_id',x.project_id,'gross_change',x.gross_change::text) ORDER BY x.project_id),'[]'::jsonb) FROM public.project_cost_correction_sites x WHERE x.request_id=a.request_id) IS DISTINCT FROM a.split OR
  (SELECT coalesce(sum(x.gross_change),0) FROM public.project_cost_correction_sites x WHERE x.request_id=a.request_id)<>a.gross_change)) INTO v_bad;
 IF v_bad THEN RAISE EXCEPTION 'Correction split evidence differs; investigate' USING ERRCODE='22023'; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('request_id',a.request_id,'source_kind',a.source_kind,'case_id',coalesce(a.voucher_case_id,a.external_case_id),'revision',a.revision,'site_gross_change',s.gross_change::text,'total_gross_change',a.gross_change::text,'case',a.expected_case,'case_changed',a.expected_case IS DISTINCT FROM app_private.project_cost_correction_case(a.source_kind,coalesce(a.voucher_case_id,a.external_case_id)),'split',a.split,'note',a.note,'recorded_by',a.recorded_by,'recorded_at',a.recorded_at) ORDER BY a.recorded_at DESC,a.request_id DESC),'[]'::jsonb) INTO v_items
 FROM public.project_cost_correction_sites s JOIN public.project_cost_correction_attributions a ON a.request_id=s.request_id
 WHERE s.project_id=p_project AND a.revision=(SELECT max(b.revision) FROM public.project_cost_correction_attributions b WHERE b.source_kind=a.source_kind AND coalesce(b.voucher_case_id,b.external_case_id)=coalesce(a.voucher_case_id,a.external_case_id));
 IF octet_length(v_items::text)>1048576 THEN RAISE EXCEPTION 'Correction attribution list too large' USING ERRCODE='54000'; END IF;
 RETURN jsonb_build_object('project_id',p_project,'items',v_items);
END $$;
REVOKE ALL ON FUNCTION public.project_cost_correction_attribution(text,uuid,integer),public.record_project_cost_correction_attribution(uuid,text,uuid,integer,jsonb,numeric,jsonb,text,boolean),public.project_cost_correction_attribution_sites(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.project_cost_correction_attribution(text,uuid,integer),public.record_project_cost_correction_attribution(uuid,text,uuid,integer,jsonb,numeric,jsonb,text,boolean),public.project_cost_correction_attribution_sites(uuid) TO authenticated;
DO $postflight$ DECLARE r text;f text;t text;BEGIN
 FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  FOREACH t IN ARRAY ARRAY['public.project_cost_correction_attributions','public.project_cost_correction_sites'] LOOP
   IF has_table_privilege(r,t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=t::regclass AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege(r,a.attrelid,a.attname,'SELECT,INSERT,UPDATE,REFERENCES')) THEN RAISE EXCEPTION 'Unexpected correction evidence access'; END IF;
  END LOOP;
  IF has_function_privilege(r,'app_private.project_cost_correction_case(text,uuid)','EXECUTE') OR has_function_privilege(r,'app_private.guard_project_cost_correction_immutable()','EXECUTE') THEN RAISE EXCEPTION 'Unexpected correction helper access'; END IF;
 END LOOP;
 FOREACH f IN ARRAY ARRAY['public.project_cost_correction_attribution(text,uuid,integer)','public.record_project_cost_correction_attribution(uuid,text,uuid,integer,jsonb,numeric,jsonb,text,boolean)','public.project_cost_correction_attribution_sites(uuid)'] LOOP
  IF has_function_privilege('anon',f,'EXECUTE') OR has_function_privilege('service_role',f,'EXECUTE') OR NOT has_function_privilege('authenticated',f,'EXECUTE') THEN RAISE EXCEPTION 'Unexpected correction RPC access'; END IF;
 END LOOP;
END $postflight$;
