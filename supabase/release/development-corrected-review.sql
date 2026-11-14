-- NOT APPROVED FOR EXECUTION. Development preparation only. One managed transaction required.
-- Pinned files:
-- supabase/release/development-correction-attribution.sql 9c77f30cc857a3d66cbb4e81851b76c8738c394543a1d31e79a7f643204c9ff1
-- supabase/drafts/project_cost_correction_inventory.sql 8363739c53e3a5f60f208e58f779429fbd3a76907fb1e4552415092815fed1a9
-- supabase/drafts/project_cost_corrected_preview.sql 775af2bd36dcda536db802c2291294750442ee862ac43e464391af4226df5493
-- supabase/drafts/project_cost_corrected_review_ledger.sql a339e5c9d14cb98d0981e0ffd526b8756487cdf2971fff6cb300c21ba27b1c4d
-- supabase/preflight/development-corrected-writer-audit.sql aa19030da7bd968b49627327401dcbc81c07717205539e22f9293e3caf6ac738
DO $manual_hold$ BEGIN IF current_setting('app.corrected_development_reviewed',true) IS DISTINCT FROM 'yes' THEN RAISE EXCEPTION 'Corrected review preparation is held pending target verification and rehearsal'; END IF; END $manual_hold$;
-- PREPARATION ONLY: NOT YET APPROVED FOR EXECUTION. Known empty DEVELOPMENT
-- target only; the operator must independently verify the project reference.
-- A rollback rehearsal, writer/privilege audit and release review are required.
-- Execute only in a single managed transaction. Source SHA256 4ba9dfb76ac350f62994b923c590cff79b3bc55f31ba1540cf56a23accce8e16.
-- No historical review or financial row is changed.
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
LOCK TABLE public.users,public.workers,public.supervisor_period_payroll,public.historical_external_worker_payroll,public.paid_period_assertion_cases,public.paid_period_assertion_case_events,public.payroll,public.paid_payroll_adjustment_cases,public.projects,public.project_cost_reviews IN SHARE ROW EXCLUSIVE MODE;
DO $development_preflight$
DECLARE v_hash text; v_count integer; r record;
BEGIN
 IF current_database()<>'postgres' THEN RAISE EXCEPTION 'Unexpected database'; END IF;
 IF (SELECT count(*) FROM auth.users)<>2 OR (SELECT count(*) FROM public.users)<>2 OR (SELECT count(*) FROM public.users WHERE role='founder')<>1 OR (SELECT count(*) FROM public.users WHERE role='supervisor')<>1 THEN RAISE EXCEPTION 'Development accounts changed'; END IF;
 IF EXISTS(SELECT 1 FROM public.workers) OR EXISTS(SELECT 1 FROM public.payroll) OR EXISTS(SELECT 1 FROM public.historical_external_worker_payroll) OR EXISTS(SELECT 1 FROM public.paid_payroll_adjustment_cases) OR EXISTS(SELECT 1 FROM public.paid_period_assertion_cases) OR EXISTS(SELECT 1 FROM public.project_cost_reviews) THEN RAISE EXCEPTION 'Business state changed; re-review before installation'; END IF;
 SELECT encode(sha256(convert_to(string_agg(n.nspname||'.'||c.relname||':'||a.attnum||':'||a.attname||':'||format_type(a.atttypid,a.atttypmod)||':'||a.attnotnull::text,E'\n' ORDER BY c.relname,a.attnum),'UTF8')),'hex'),count(*) INTO v_hash,v_count
 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relname=ANY(ARRAY['users','workers','payroll','projects','supervisor_period_payroll','historical_external_worker_payroll','paid_payroll_adjustment_cases','paid_period_assertion_cases','paid_period_assertion_case_events']) AND a.attnum>0 AND NOT a.attisdropped;
 IF v_hash IS DISTINCT FROM 'f517c3cbf49aebd218fd18e3fe92c2a79b57279af9cef6a147e32f9116b9ed5c' OR v_count<>102 THEN RAISE EXCEPTION 'Development schema differs'; END IF;
 FOR r IN SELECT * FROM (VALUES
  ('auth.uid()','7c1ff2ecbe653c9358b3115a2607db9573f88a2944ae4eca9e296a89cc5186a7'),
  ('public.is_founder()','fa022685cbf0e33ef812828fe537dd307a57712ad05e21bb2d47eb72feb341a3'),
  ('public.session_assurance_satisfied()','d4c6a53f7792703119ac26443213db4f4cf695d0b390f008a5926f3b32569850'),
  ('app_private.paid_adjustment_voucher_snapshot(public.payroll)','85f44e7ba0b829eeb6b33e2dd8c3d96281e2c8c9ecf48e8930d9770b54d891e5'),
  ('public.paid_period_assertion_snapshot(text,uuid)','dd0fa88ff40b9012e79ecd8f01cef720c884d2e7eb319fb1a5eee51293ca45ae'),
  ('public.open_paid_payroll_adjustment(uuid,uuid,jsonb,numeric,text)','ff403a8ef943eb27208a00005ba51d493f5b01bb13171d10f15607977696cfb4'),
  ('public.resolve_paid_payroll_adjustment(uuid,text,date,text)','32c702ee23f4ad1b55fb06cca419fdc0494c3dd42a9cee4d023f4fab0ec25e37'),
  ('public.open_paid_period_assertion_case(uuid,text,uuid,jsonb,numeric,text)','c6d3c6c12c7c59bf020a0c3b7401f935b654f20ef2962c39bbe8f95570a38a5d'),
  ('public.resolve_paid_period_assertion_case(uuid,text,date,text,boolean)','11aa2505d96e023a116d33fd672ccb442bfd80b464f5c2803a410f92fe30869e'),
  ('public.guard_paid_period_assertion_case_immutable()','121192dc972339fdee0b353b7bef697126e31624b4bb45279bb97afbd2fc0703'),
  ('public.guard_historical_external_worker_immutable()','9f39082f71f8439c20af30e90ac077529229bd3ce73445db2d2781f87eff3e32'),
  ('app_private.guard_paid_adjustment_immutable()','495aa427f7cba9675d8e085b92fcabe092cc7851888397ebd3357424646664a0'),
  ('public.historical_worker_attribution_projects()','dbf1cdb60d27faf5ffc89753ae4a5a547751fe43c97e4f455cf8ba93ecab95a4')
 ) AS f(signature,digest) LOOP
  IF to_regprocedure(r.signature) IS NULL OR encode(sha256(convert_to(pg_get_functiondef(to_regprocedure(r.signature)),'UTF8')),'hex') IS DISTINCT FROM r.digest THEN RAISE EXCEPTION 'Prerequisite function drift: %',r.signature; END IF;
 END LOOP;
 FOR r IN SELECT * FROM (VALUES
  ('public.paid_payroll_adjustment_cases','guard_paid_adjustment_case_history','app_private.guard_paid_adjustment_immutable()'),
  ('public.paid_period_assertion_cases','paid_period_case_immutable','public.guard_paid_period_assertion_case_immutable()'),
  ('public.historical_external_worker_payroll','historical_external_worker_immutable','public.guard_historical_external_worker_immutable()')
 ) AS t(table_name,trigger_name,function_name) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass(r.table_name) AND tgname=r.trigger_name AND tgenabled='O' AND tgtype=27 AND tgfoid=to_regprocedure(r.function_name) AND NOT tgisinternal) THEN RAISE EXCEPTION 'Source history guard changed: %',r.table_name; END IF;
 END LOOP;
 FOR r IN SELECT * FROM (VALUES ('public.paid_payroll_adjustment_cases'),('public.paid_period_assertion_cases'),('public.paid_period_assertion_case_events'),('public.historical_external_worker_payroll')) AS t(table_name) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid=to_regclass(r.table_name) AND relrowsecurity AND pg_get_userbyid(relowner)='postgres') OR EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) roles(role_name) WHERE has_table_privilege(roles.role_name,r.table_name,'INSERT,UPDATE,DELETE,TRUNCATE') OR EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass(r.table_name) AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege(roles.role_name,a.attrelid,a.attname,'INSERT,UPDATE'))) THEN RAISE EXCEPTION 'Source table owner, RLS or write privilege changed: %',r.table_name; END IF;
 END LOOP;
END $development_preflight$;
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
DECLARE v jsonb;v_original jsonb;v_current jsonb;v_source uuid;v_related jsonb;v_count bigint;v_mismatch boolean;
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
  SELECT count(*),coalesce(bool_or(c.original_voucher IS DISTINCT FROM v_current OR c.worker_id IS DISTINCT FROM (v->>'worker_id')::uuid),false) INTO v_count,v_mismatch FROM public.paid_payroll_adjustment_cases c WHERE c.payroll_id=v_source;
 ELSE
  SELECT count(*),coalesce(bool_or(c.original_snapshot IS DISTINCT FROM v_current),false) INTO v_count,v_mismatch FROM public.paid_period_assertion_cases c WHERE c.source_kind='external_worker' AND c.external_worker_id=v_source;
 END IF;
 IF v_count>100 THEN RAISE EXCEPTION 'More than 100 related cases; separate reconciliation required' USING ERRCODE='54000'; END IF;
 IF v_mismatch THEN RAISE EXCEPTION 'Related case original paid-period evidence differs; investigate' USING ERRCODE='40001'; END IF;
 IF p_kind='voucher' THEN
  SELECT coalesce(jsonb_agg((to_jsonb(c)-'original_voucher')||jsonb_build_object('difference',c.difference::text,'original_fingerprint',encode(sha256(convert_to(c.original_voucher::text,'UTF8')),'hex')) ORDER BY c.id),'[]'::jsonb) INTO v_related FROM public.paid_payroll_adjustment_cases c WHERE c.payroll_id=v_source;
 ELSE
  SELECT coalesce(jsonb_agg((to_jsonb(c)-'original_snapshot')||jsonb_build_object('difference',c.difference::text,'original_fingerprint',encode(sha256(convert_to(c.original_snapshot::text,'UTF8')),'hex')) ORDER BY c.id),'[]'::jsonb) INTO v_related FROM public.paid_period_assertion_cases c WHERE c.source_kind='external_worker' AND c.external_worker_id=v_source;
 END IF;
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

DO $development_postflight$ BEGIN
 IF EXISTS(SELECT 1 FROM public.project_cost_correction_attributions) OR EXISTS(SELECT 1 FROM public.project_cost_correction_sites) OR NOT coalesce((SELECT relrowsecurity FROM pg_class WHERE oid='public.project_cost_correction_attributions'::regclass),false) OR NOT coalesce((SELECT relrowsecurity FROM pg_class WHERE oid='public.project_cost_correction_sites'::regclass),false) THEN RAISE EXCEPTION 'Correction evidence postflight failed'; END IF;
END $development_postflight$;


-- PREPARATION ONLY, NOT APPROVED FOR EXECUTION. Verify the target project
-- reference independently and perform hosted rollback/security review first.
-- Locks and exact empty-state/function pins are specific to the observed demo.
LOCK TABLE public.expenses,public.confirmed_rental_expenses,public.weekly_worker_paid_allocations,public.weekly_worker_draft_sources,public.payroll_payment_dates,public.historical_worker_attributions,public.historical_worker_attribution_sites IN SHARE ROW EXCLUSIVE MODE;
DO $corrected_development_preflight$
DECLARE r record;
BEGIN
 IF EXISTS(SELECT 1 FROM public.expenses) OR EXISTS(SELECT 1 FROM public.historical_worker_attributions) OR EXISTS(SELECT 1 FROM public.historical_worker_attribution_sites) OR EXISTS(SELECT 1 FROM public.weekly_worker_paid_allocations) OR EXISTS(SELECT 1 FROM public.confirmed_rental_expenses) OR EXISTS(SELECT 1 FROM public.weekly_worker_draft_sources) OR EXISTS(SELECT 1 FROM public.payroll_payment_dates) THEN RAISE EXCEPTION 'Development source data changed; re-review'; END IF;
 FOR r IN SELECT * FROM (VALUES
  ('public.project_cost_historical_review(uuid)','e625c812572026a66fe2e61c98f5bd2615ec5ed6b0b8aa9c1e0b4e63bd590f73'),
  ('public.project_cost_reconciliation_preview(uuid)','6fb6b32b0503f0e135c3afbaab65a6cbc7b48c21e46257eaf3beea4bd32aed2f'),
  ('public.project_historical_worker_attributions(uuid)','dfdffffcc44ca28f409bcac76f2ef74706887e7c886503ffed24c7184b5ae70f'),
  ('public.historical_external_worker_lookup(uuid)','45450f8f890a4871dace8b90035c2c05dd5292df28fc79ba2388c67e1c5229c8'),
  ('public.project_paid_worker_evidence(uuid,date,uuid,integer)','87265e59d92156f94e0562ccbdc7cd827b985e46cddf17594b98a2e6212315cb'),
  ('public.project_confirmed_rentals(uuid)','51c5ee154793692183f63e71a51f27312a6dd877375542bd1a1f20c7ddcb9c5e'),
  ('public.record_project_cost_review(uuid,uuid,integer,jsonb,jsonb,text)','a30d6e9f98e3c29aec28a28930016cfbec18fd5f0a621c6b9093ff9052db2cc5'),
  ('public.project_cost_review(uuid,integer)','22c6987706c81a60b91bb449374abc91415afd739df7b554348becef860f224e')
 ) AS f(signature,digest) LOOP
  IF to_regprocedure(r.signature) IS NULL OR encode(sha256(convert_to(pg_get_functiondef(to_regprocedure(r.signature)),'UTF8')),'hex') IS DISTINCT FROM r.digest THEN RAISE EXCEPTION 'Corrected review dependency drift: %',r.signature; END IF;
 END LOOP;
END $corrected_development_preflight$;

-- DEVELOPMENT PREPARATION ONLY. Read-only, point-in-time catalog guard for
-- selected direct textual writers of the correction review's source tables.
-- This is NOT an exhaustive writer audit: dynamic SQL, quoted identifiers,
-- indirect calls, owner actions, triggers and DDL changes can evade this
-- search. The operator must independently verify the target and coordinate
-- a quiet migration; this does not lock function definitions against DDL.
DO $corrected_writer_audit$
DECLARE r record; v_oid oid; v_known oid[]:='{}'::oid[]; v_found integer;
BEGIN
 FOR r IN SELECT * FROM (VALUES
  ('public.confirm_rental_expense(uuid,uuid,uuid,numeric,date,text,text,text,integer,date,date)','fed9d8ec95c7a119fe4fe9ca59b3e91a62ddee3d5662143f1c8cc8d2ea504198',true),
  ('public.create_weekly_worker_draft(uuid,uuid,date)','303f3a42eceb0f16eb01063de08636ededaa9de169f3c830f7c7c29268924018',true),
  ('public.open_paid_payroll_adjustment(uuid,uuid,jsonb,numeric,text)','ff403a8ef943eb27208a00005ba51d493f5b01bb13171d10f15607977696cfb4',true),
  ('public.open_paid_period_assertion_case(uuid,text,uuid,jsonb,numeric,text)','c6d3c6c12c7c59bf020a0c3b7401f935b654f20ef2962c39bbe8f95570a38a5d',true),
  ('public.record_historical_worker_attribution(uuid,uuid,jsonb,jsonb,text,boolean)','ee533b4a2c620cf011bc3df71e3cff322c087b70bda9ab181d7330b77ca4792d',true),
  ('public.refresh_weekly_worker_draft(uuid,uuid,bigint)','cf6ed49a80b94bf27d7a2cf1a789cfc99cf17b3609185d2c33a89b71a684822c',true),
  ('public.resolve_paid_payroll_adjustment(uuid,text,date,text)','32c702ee23f4ad1b55fb06cca419fdc0494c3dd42a9cee4d023f4fab0ec25e37',true),
  ('public.resolve_paid_period_assertion_case(uuid,text,date,text,boolean)','11aa2505d96e023a116d33fd672ccb442bfd80b464f5c2803a410f92fe30869e',true),
  ('public.return_weekly_worker_to_draft(uuid,uuid,bigint,text)','8dfde320739baef335c2ba9b5a18b48e7233f1458d441d76caac920462cf5bfb',true),
  ('public.weekly_payment_date_internal(uuid,date)','7aff33302c8ce5b9dca2bd2a6ca67b27868a31cbfed04a50b23346886ea95ef0',false),
  ('public.weekly_worker_approval_internal(uuid)','34f2ce1bb4173312d76c74acb65cc72c28af1846088dec3e67c5ad7481ae5f93',false),
  ('public.weekly_worker_payment_internal(uuid,date)','a124cbfb4c8e3a8d035fe0cd90c4280899ab33be3795dd46c8a6d94080415f36',false)
 ) AS expected(signature,digest,authenticated_execute) LOOP
  v_oid:=to_regprocedure(r.signature);
  IF v_oid IS NULL OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=v_oid AND p.prokind='f' AND p.prosecdef AND pg_get_userbyid(p.proowner)='postgres') OR encode(sha256(convert_to(pg_get_functiondef(v_oid),'UTF8')),'hex') IS DISTINCT FROM r.digest OR has_function_privilege('anon',v_oid,'EXECUTE') OR has_function_privilege('service_role',v_oid,'EXECUTE') OR has_function_privilege('authenticated',v_oid,'EXECUTE') IS DISTINCT FROM r.authenticated_execute THEN
   RAISE EXCEPTION 'Selected development source writer changed: %',r.signature;
  END IF;
  v_known:=array_append(v_known,v_oid);
 END LOOP;
 SELECT count(*) INTO v_found FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname IN ('public','app_private') AND p.prokind='f'
  AND p.prosrc ~* '(insert\s+into|update|delete\s+from|truncate)\s+(public\.)?(expenses|confirmed_rental_expenses|weekly_worker_paid_allocations|weekly_worker_draft_sources|payroll_payment_dates|historical_worker_attributions|historical_worker_attribution_sites|paid_payroll_adjustment_cases|paid_period_assertion_cases)'
  AND NOT(p.oid=ANY(v_known));
 IF v_found<>0 THEN RAISE EXCEPTION 'Additional selected textual source writer found; review required'; END IF;
END $corrected_writer_audit$;

-- DRAFT ONLY, NOT INSTALLED. Bounded read-only source-period inventory for
-- designing original-period correction reconciliation. It is NOT a total,
-- posting, proof of payment, or evidence that all business costs were found.
-- Existing project-cost reviews remain unchanged and exclude corrections.
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
DO $preflight$ BEGIN
 IF to_regprocedure('public.project_cost_historical_review(uuid)') IS NULL OR to_regprocedure('public.project_cost_correction_attribution(text,uuid,integer)') IS NULL OR to_regclass('public.project_cost_correction_attributions') IS NULL OR to_regclass('public.project_cost_correction_sites') IS NULL OR to_regclass('public.paid_payroll_adjustment_cases') IS NULL OR to_regclass('public.paid_period_assertion_cases') IS NULL OR to_regprocedure('public.is_founder()') IS NULL OR to_regprocedure('public.session_assurance_satisfied()') IS NULL OR to_regprocedure('auth.uid()') IS NULL THEN RAISE EXCEPTION 'Correction inventory prerequisites missing'; END IF;
 IF to_regprocedure('public.project_cost_correction_inventory(uuid)') IS NOT NULL THEN RAISE EXCEPTION 'Correction inventory name collision'; END IF;
END $preflight$;
CREATE FUNCTION public.project_cost_correction_inventory(p_project uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_base jsonb;v_refs jsonb;v_items jsonb:='[]'::jsonb;v_ref jsonb;v_evidence jsonb;v_site text;v_result jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance required' USING ERRCODE='42501'; END IF;
 -- This function and its STABLE dependencies share one statement snapshot.
 -- The historical/base snapshot enforces its own bounds and integrity checks.
 v_base:=public.project_cost_historical_review(p_project);
 -- Inventory cases linked to included source evidence, PLUS cases whose latest
 -- correction split names this site even if the original is absent from it.
 -- Selecting latest BEFORE filtering site prevents older revisions reappearing.
 WITH refs AS (
  SELECT 'voucher'::text kind,(c->>'case_id')::uuid case_id,true source_in_snapshot
   FROM jsonb_array_elements(v_base->'base'->'adjustment_cases') c
  UNION ALL
  SELECT 'external_worker',c.id,true
   FROM jsonb_array_elements(v_base->'historical') h
   JOIN public.paid_period_assertion_cases c ON c.source_kind='external_worker' AND c.external_worker_id=(h->>'source_id')::uuid
  UNION ALL
  SELECT a.source_kind,coalesce(a.voucher_case_id,a.external_case_id),false
   FROM public.project_cost_correction_attributions a JOIN public.project_cost_correction_sites s ON s.request_id=a.request_id
   WHERE s.project_id=p_project AND a.revision=(SELECT max(b.revision) FROM public.project_cost_correction_attributions b WHERE b.source_kind=a.source_kind AND coalesce(b.voucher_case_id,b.external_case_id)=coalesce(a.voucher_case_id,a.external_case_id))
 ), grouped AS (SELECT kind,case_id,bool_or(source_in_snapshot) source_in_snapshot FROM refs GROUP BY kind,case_id ORDER BY kind,case_id LIMIT 501)
 SELECT coalesce(jsonb_agg(jsonb_build_object('kind',kind,'case_id',case_id,'source_in_snapshot',source_in_snapshot) ORDER BY kind,case_id),'[]'::jsonb) INTO v_refs FROM grouped;
 IF jsonb_array_length(v_refs)>500 THEN RAISE EXCEPTION 'More than 500 correction cases; separate reconciliation required' USING ERRCODE='54000'; END IF;
 FOR v_ref IN SELECT value FROM jsonb_array_elements(v_refs) LOOP
  -- The existing case reader validates the complete split, original source,
  -- all siblings and whether a saved revision matches the current case.
  v_evidence:=public.project_cost_correction_attribution(v_ref->>'kind',(v_ref->>'case_id')::uuid,NULL);
  v_site:=NULL;
  IF v_evidence->'attribution'<>'null'::jsonb THEN
   SELECT x->>'gross_change' INTO v_site FROM jsonb_array_elements(v_evidence->'attribution'->'split') x WHERE (x->>'project_id')::uuid=p_project;
   -- An explicit complete reviewed split without this site means zero here;
   -- a missing review remains NULL, not zero. Neither is a posting.
   v_site:=coalesce(v_site,'0.00');
  END IF;
  v_items:=v_items||jsonb_build_array(v_ref||jsonb_build_object('evidence',v_evidence,'site_gross_change',v_site));
 END LOOP;
 v_result:=jsonb_build_object('project_id',p_project,'historical_review',v_base,'corrections',v_items);
 IF octet_length(v_result::text)>2097152 THEN RAISE EXCEPTION 'Correction inventory too large; separate reconciliation required' USING ERRCODE='54000'; END IF;
 RETURN v_result;
END $$;
REVOKE ALL ON FUNCTION public.project_cost_correction_inventory(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.project_cost_correction_inventory(uuid) TO authenticated;
DO $postflight$ BEGIN
 IF has_function_privilege('anon','public.project_cost_correction_inventory(uuid)','EXECUTE') OR has_function_privilege('service_role','public.project_cost_correction_inventory(uuid)','EXECUTE') OR NOT has_function_privilege('authenticated','public.project_cost_correction_inventory(uuid)','EXECUTE') OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.project_cost_correction_inventory(uuid)'::regprocedure AND prosecdef AND provolatile='s' AND proconfig @> ARRAY['search_path=""']) THEN RAISE EXCEPTION 'Unexpected correction inventory privileges'; END IF;
END $postflight$;

-- DRAFT ONLY. Founder-reviewed, bounded, read-only corrected cost illustration.
-- This is not a posting, payment, complete ledger, or a saved review. Existing
-- saved reviews remain immutable and exclude corrections. Inclusion of a
-- correction requires the corresponding original source in this site snapshot.
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
DO $preflight$ BEGIN
 IF to_regprocedure('public.project_cost_correction_inventory(uuid)') IS NULL OR to_regprocedure('public.is_founder()') IS NULL OR to_regprocedure('public.session_assurance_satisfied()') IS NULL OR to_regprocedure('auth.uid()') IS NULL THEN RAISE EXCEPTION 'Corrected preview prerequisites missing'; END IF;
 IF to_regprocedure('public.project_cost_corrected_preview(uuid,jsonb,jsonb,boolean)') IS NOT NULL THEN RAISE EXCEPTION 'Corrected preview name collision'; END IF;
END $preflight$;
CREATE FUNCTION public.project_cost_corrected_preview(p_project uuid,p_snapshot jsonb,p_choices jsonb,p_ack boolean) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_now jsonb;v_base jsonb;v_history jsonb;v_cases jsonb;v_group text;v_choices jsonb;v_row jsonb;v_choice jsonb;v_case jsonb;v_evidence jsonb;v_key text;v_source text;v_source_key text;v_original numeric;v_effect numeric;v_exp numeric:=0;v_excluded_exp numeric:=0;v_paid numeric:=0;v_hist numeric:=0;v_excluded_hist numeric:=0;v_correction numeric:=0;v_excluded_cases integer:=0;v_total numeric;v_sources jsonb:='{}'::jsonb;v_source_reviews jsonb;v_source_entry jsonb;v_expected_ids jsonb;v_required_reviews integer:=0;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance required' USING ERRCODE='42501'; END IF;
 IF p_project IS NULL OR p_ack IS DISTINCT FROM true OR jsonb_typeof(p_snapshot) IS DISTINCT FROM 'object' OR octet_length(p_snapshot::text)>2097152 OR jsonb_typeof(p_choices) IS DISTINCT FROM 'object' OR octet_length(p_choices::text)>500000 OR (SELECT count(*) FROM jsonb_object_keys(p_choices)) NOT IN (3,4) OR NOT(p_choices ?& ARRAY['expenses','historical','corrections']) OR (SELECT count(*) FROM jsonb_object_keys(p_choices))<>(CASE WHEN p_choices ? 'source_reviews' THEN 4 ELSE 3 END) THEN RAISE EXCEPTION 'Invalid corrected review input' USING ERRCODE='22023'; END IF;
 v_source_reviews:=coalesce(p_choices->'source_reviews','{}'::jsonb);
 IF jsonb_typeof(v_source_reviews) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid source reviews' USING ERRCODE='22023'; END IF;
 -- Compare the server's statement snapshot with the full reviewed inventory.
 -- Capture time alone is not financial evidence. A later change still requires
 -- a new read: this preview neither locks writers nor closes a period.
 v_now:=public.project_cost_correction_inventory(p_project);
 IF v_now #- '{historical_review,base,captured_at}' IS DISTINCT FROM p_snapshot #- '{historical_review,base,captured_at}' THEN RAISE EXCEPTION 'Project evidence changed; reload and review' USING ERRCODE='40001'; END IF;
 v_base:=v_now->'historical_review'->'base';v_history:=v_now->'historical_review'->'historical';v_cases:=v_now->'corrections';
 IF jsonb_typeof(v_now) IS DISTINCT FROM 'object' OR v_now->>'project_id' IS DISTINCT FROM p_project::text OR v_now->'historical_review'->>'project_id' IS DISTINCT FROM p_project::text OR jsonb_typeof(v_base) IS DISTINCT FROM 'object' OR jsonb_typeof(v_base->'captured_at') IS DISTINCT FROM 'string' OR jsonb_typeof(v_base->'expenses') IS DISTINCT FROM 'array' OR jsonb_typeof(v_base->'paid_allocations') IS DISTINCT FROM 'array' OR jsonb_typeof(v_base->'adjustment_cases') IS DISTINCT FROM 'array' OR jsonb_typeof(v_history) IS DISTINCT FROM 'array' OR jsonb_typeof(v_cases) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Correction inventory is incomplete or unavailable' USING ERRCODE='22023'; END IF;
 -- Do not let duplicate or missing identities make an incomplete decision map
 -- look complete. Every historical case signal must appear in the inventory.
 IF jsonb_array_length(v_base->'expenses')<>(SELECT count(DISTINCT e->>'id') FROM jsonb_array_elements(v_base->'expenses') e) OR jsonb_array_length(v_base->'paid_allocations')<>(SELECT count(DISTINCT a->>'payroll_id') FROM jsonb_array_elements(v_base->'paid_allocations') a) OR jsonb_array_length(v_history)<>(SELECT count(DISTINCT h->>'request_id') FROM jsonb_array_elements(v_history) h) OR jsonb_array_length(v_history)<>(SELECT count(DISTINCT h->>'source_id') FROM jsonb_array_elements(v_history) h) OR jsonb_array_length(v_cases)<>(SELECT count(DISTINCT (c->>'kind')||':'||(c->>'case_id')) FROM jsonb_array_elements(v_cases) c) OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_history) h WHERE (h->>'case_count')::bigint IS DISTINCT FROM (SELECT count(*) FROM jsonb_array_elements(v_cases) c WHERE c->>'kind'='external_worker' AND (c->>'source_in_snapshot')::boolean AND c->'evidence'->'case'->>'external_worker_id'=h->>'source_id')) OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_base->'adjustment_cases') a WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_cases) c WHERE c->>'kind'='voucher' AND c->>'case_id'=a->>'case_id' AND (c->>'source_in_snapshot')::boolean)) THEN RAISE EXCEPTION 'Correction inventory identity or case signal differs' USING ERRCODE='22023'; END IF;
 FOREACH v_group IN ARRAY ARRAY['expenses','historical','corrections'] LOOP
  v_choices:=p_choices->v_group;
  IF jsonb_typeof(v_choices) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Review every % item',v_group USING ERRCODE='22023'; END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(v_choices))<>(CASE v_group WHEN 'expenses' THEN jsonb_array_length(v_base->'expenses') WHEN 'historical' THEN jsonb_array_length(v_history) ELSE jsonb_array_length(v_cases) END) THEN RAISE EXCEPTION 'Review every % item',v_group USING ERRCODE='22023'; END IF;
  -- All decisions use {decision,reason}. Exclusions require a reason. A
  -- correction inclusion also requires a reason explaining the review; no
  -- implicit duplicate classification is inferred from numbers or an AI hint.
  IF EXISTS(SELECT 1 FROM jsonb_each(v_choices) e WHERE jsonb_typeof(e.value) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(CASE WHEN jsonb_typeof(e.value)='object' THEN e.value ELSE '{}'::jsonb END))<>2 OR NOT(e.value ?& ARRAY['decision','reason']) OR coalesce(e.value->>'decision','') NOT IN ('include','exclude') OR
   (e.value->>'decision'='include' AND v_group<>'corrections' AND e.value->'reason' IS DISTINCT FROM 'null'::jsonb) OR
   ((e.value->>'decision'='exclude' OR v_group='corrections') AND (jsonb_typeof(e.value->'reason') IS DISTINCT FROM 'string' OR length(btrim(e.value->>'reason')) NOT BETWEEN 1 AND 300 OR btrim(e.value->>'reason') IS DISTINCT FROM e.value->>'reason' OR (e.value->>'reason') ~ '[[:cntrl:]]'))) THEN RAISE EXCEPTION 'Invalid % decision or reason',v_group USING ERRCODE='22023'; END IF;
 END LOOP;
 FOR v_row IN SELECT value FROM jsonb_array_elements(v_base->'expenses') LOOP
  v_key:=v_row->>'id';v_choice:=p_choices->'expenses'->v_key;
  IF v_choice IS NULL THEN RAISE EXCEPTION 'Review every expense' USING ERRCODE='22023'; END IF;
  v_original:=(v_row->>'amount')::numeric;
  IF v_original IS NULL OR v_original='NaN'::numeric OR v_original<=0 OR v_original<>round(v_original,2) OR v_original>=10000000000 THEN RAISE EXCEPTION 'Invalid expense evidence' USING ERRCODE='22023'; END IF;
  IF v_choice->>'decision'='include' THEN v_exp:=v_exp+v_original; ELSE v_excluded_exp:=v_excluded_exp+v_original; END IF;
 END LOOP;
 FOR v_row IN SELECT value FROM jsonb_array_elements(v_base->'paid_allocations') LOOP
  v_original:=(v_row->>'gross')::numeric;
  IF v_original IS NULL OR v_original='NaN'::numeric OR v_original<0 OR v_original<>round(v_original,2) OR v_original>=10000000000 THEN RAISE EXCEPTION 'Invalid paid allocation' USING ERRCODE='22023'; END IF;
  v_paid:=v_paid+v_original;
 END LOOP;
 FOR v_row IN SELECT value FROM jsonb_array_elements(v_history) LOOP
  v_key:=v_row->>'request_id';v_choice:=p_choices->'historical'->v_key;
  IF v_choice IS NULL THEN RAISE EXCEPTION 'Review every historical attribution' USING ERRCODE='22023'; END IF;
  v_original:=(v_row->>'site_gross')::numeric;
  IF v_original IS NULL OR v_original='NaN'::numeric OR v_original<=0 OR v_original<>round(v_original,2) OR v_original>=10000000000 THEN RAISE EXCEPTION 'Invalid historical allocation' USING ERRCODE='22023'; END IF;
  IF v_choice->>'decision'='include' THEN
   IF (v_row->>'overlapping_vouchers')::bigint<>0 THEN RAISE EXCEPTION 'Investigate historical voucher overlap' USING ERRCODE='22023'; END IF;
   v_hist:=v_hist+v_original;
  ELSE v_excluded_hist:=v_excluded_hist+v_original; END IF;
 END LOOP;
 FOR v_row IN SELECT value FROM jsonb_array_elements(v_cases) LOOP
  v_key:=(v_row->>'kind')||':'||(v_row->>'case_id');v_choice:=p_choices->'corrections'->v_key;
  IF v_choice IS NULL THEN RAISE EXCEPTION 'Review every correction case' USING ERRCODE='22023'; END IF;
  IF v_choice->>'decision'='exclude' THEN v_excluded_cases:=v_excluded_cases+1;CONTINUE; END IF;
  v_evidence:=v_row->'evidence';v_case:=v_evidence->'case';
  IF coalesce((v_row->>'source_in_snapshot')::boolean,false) IS NOT TRUE OR v_evidence->'attribution' IS NULL OR v_evidence->'attribution'='null'::jsonb OR (v_evidence->'attribution'->>'case_changed')::boolean IS DISTINCT FROM false OR coalesce(v_case->>'status','') NOT IN ('settled_external','no_transfer') OR jsonb_typeof(v_case->'related_cases') IS DISTINCT FROM 'array' OR EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_case->'related_cases')='array' THEN v_case->'related_cases' ELSE '[]'::jsonb END) s WHERE coalesce(s->>'status','') NOT IN ('settled_external','no_transfer')) OR v_row->>'site_gross_change' IS NULL THEN RAISE EXCEPTION 'Included correction lacks current resolved source evidence' USING ERRCODE='22023'; END IF;
  v_source:=CASE v_row->>'kind' WHEN 'voucher' THEN v_case->>'payroll_id' WHEN 'external_worker' THEN v_case->>'external_worker_id' ELSE NULL END;
  IF v_source IS NULL THEN RAISE EXCEPTION 'Correction source unavailable' USING ERRCODE='22023'; END IF;
  v_source_key:=(v_row->>'kind')||':'||v_source;
  IF v_row->>'kind'='voucher' THEN
   SELECT (a->>'gross')::numeric INTO v_original FROM jsonb_array_elements(v_base->'paid_allocations') a WHERE a->>'payroll_id'=v_source;
  ELSE
   SELECT (h->>'site_gross')::numeric INTO v_original FROM jsonb_array_elements(v_history) h WHERE h->>'source_id'=v_source AND p_choices->'historical'->(h->>'request_id')->>'decision'='include' AND (h->>'overlapping_vouchers')::bigint=0;
  END IF;
  IF v_original IS NULL THEN RAISE EXCEPTION 'Correction original is not included in this site review' USING ERRCODE='22023'; END IF;
  v_effect:=(v_row->>'site_gross_change')::numeric;
  IF v_effect='NaN'::numeric OR abs(v_effect)>=10000000000 OR v_effect<>round(v_effect,2) THEN RAISE EXCEPTION 'Correction exceeds or invalidates original site cost' USING ERRCODE='22023'; END IF;
  v_source_entry:=coalesce(v_sources->v_source_key,jsonb_build_object('original',v_original,'effect',0,'cases','[]'::jsonb));
  IF (v_source_entry->>'original')::numeric IS DISTINCT FROM v_original THEN RAISE EXCEPTION 'Correction originals differ' USING ERRCODE='22023'; END IF;
  v_source_entry:=jsonb_set(v_source_entry,'{effect}',to_jsonb((v_source_entry->>'effect')::numeric+v_effect));
  v_source_entry:=jsonb_set(v_source_entry,'{cases}',(v_source_entry->'cases')||jsonb_build_array(v_key));
  v_sources:=jsonb_set(v_sources,ARRAY[v_source_key],v_source_entry,true);
  v_correction:=v_correction+v_effect;
 END LOOP;
 -- An explicit, auditable assertion is required for every original with more
 -- than one included case. It binds the exact selected case IDs and states the
 -- reviewed effects are distinct, not duplicate/overlapping. This is human
 -- evidence, not proof that the assertion or the source records are complete.
 FOR v_source_key,v_source_entry IN SELECT key,value FROM jsonb_each(v_sources) LOOP
  IF (v_source_entry->>'original')::numeric+(v_source_entry->>'effect')::numeric<0 THEN RAISE EXCEPTION 'Correction exceeds or invalidates original site cost' USING ERRCODE='22023'; END IF;
  IF jsonb_array_length(v_source_entry->'cases')>1 THEN
   v_required_reviews:=v_required_reviews+1;
   SELECT jsonb_agg(value ORDER BY value COLLATE "C") INTO v_expected_ids FROM jsonb_array_elements_text(v_source_entry->'cases');
   v_choice:=v_source_reviews->v_source_key;
   IF jsonb_typeof(v_choice) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(CASE WHEN jsonb_typeof(v_choice)='object' THEN v_choice ELSE '{}'::jsonb END))<>3 OR NOT(v_choice ?& ARRAY['case_ids','note','non_overlapping']) OR v_choice->'case_ids' IS DISTINCT FROM v_expected_ids OR v_choice->'non_overlapping' IS DISTINCT FROM 'true'::jsonb OR jsonb_typeof(v_choice->'note') IS DISTINCT FROM 'string' OR length(btrim(v_choice->>'note')) NOT BETWEEN 1 AND 300 OR btrim(v_choice->>'note') IS DISTINCT FROM v_choice->>'note' OR (v_choice->>'note') ~ '[[:cntrl:]]' THEN RAISE EXCEPTION 'Multiple included corrections require an exact distinct-effects review' USING ERRCODE='22023'; END IF;
  END IF;
 END LOOP;
 IF (SELECT count(*) FROM jsonb_object_keys(v_source_reviews))<>v_required_reviews THEN RAISE EXCEPTION 'Unexpected or missing source review' USING ERRCODE='22023'; END IF;
 v_total:=v_exp+v_paid+v_hist+v_correction;
 IF v_total<0 OR v_total>=100000000000000 THEN RAISE EXCEPTION 'Invalid corrected total' USING ERRCODE='22023'; END IF;
 RETURN jsonb_build_object('project_id',p_project,'included_expenses',v_exp::numeric(16,2)::text,'excluded_expenses',v_excluded_exp::numeric(16,2)::text,'paid_gross',v_paid::numeric(16,2)::text,'historical_gross',v_hist::numeric(16,2)::text,'excluded_historical',v_excluded_hist::numeric(16,2)::text,'correction_gross',v_correction::numeric(16,2)::text,'excluded_cases',v_excluded_cases,'incomplete_total',v_total::numeric(16,2)::text,'incomplete',true);
END $$;
REVOKE ALL ON FUNCTION public.project_cost_corrected_preview(uuid,jsonb,jsonb,boolean) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.project_cost_corrected_preview(uuid,jsonb,jsonb,boolean) TO authenticated;
DO $postflight$ BEGIN
 IF has_function_privilege('anon','public.project_cost_corrected_preview(uuid,jsonb,jsonb,boolean)','EXECUTE') OR has_function_privilege('service_role','public.project_cost_corrected_preview(uuid,jsonb,jsonb,boolean)','EXECUTE') OR NOT has_function_privilege('authenticated','public.project_cost_corrected_preview(uuid,jsonb,jsonb,boolean)','EXECUTE') OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.project_cost_corrected_preview(uuid,jsonb,jsonb,boolean)'::regprocedure AND prosecdef AND provolatile='s' AND proconfig @> ARRAY['search_path=""']) THEN RAISE EXCEPTION 'Unexpected corrected preview privileges'; END IF;
END $postflight$;

-- DRAFT ONLY. Separate immutable correction-inclusive INCOMPLETE reviews.
-- Does not change existing reviews, payroll, payments, expenses or allocations.
-- A saved review is a reviewed statement snapshot, not a closed period, an
-- accounting posting, payment proof, or a completeness guarantee.
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
DO $preflight$ BEGIN
 IF to_regclass('public.projects') IS NULL OR to_regclass('public.users') IS NULL OR to_regprocedure('public.project_cost_correction_inventory(uuid)') IS NULL OR to_regprocedure('public.project_cost_corrected_preview(uuid,jsonb,jsonb,boolean)') IS NULL OR to_regprocedure('public.is_founder()') IS NULL OR to_regprocedure('public.session_assurance_satisfied()') IS NULL OR to_regprocedure('auth.uid()') IS NULL THEN RAISE EXCEPTION 'Corrected review prerequisites missing'; END IF;
 IF to_regclass('public.project_cost_corrected_reviews') IS NOT NULL OR to_regprocedure('public.record_project_cost_corrected_review(uuid,uuid,integer,jsonb,jsonb,text,boolean)') IS NOT NULL OR to_regprocedure('public.project_cost_corrected_review(uuid,integer)') IS NOT NULL OR to_regprocedure('app_private.guard_project_cost_corrected_review_immutable()') IS NOT NULL THEN RAISE EXCEPTION 'Corrected review name collision'; END IF;
END $preflight$;
CREATE TABLE public.project_cost_corrected_reviews (
 request_id uuid PRIMARY KEY,project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE RESTRICT,
 revision integer NOT NULL CHECK(revision>0),expected_revision integer NOT NULL CHECK(expected_revision>=0 AND revision=expected_revision+1),
 actor_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object' AND octet_length(snapshot::text)<=2097152),
 choices jsonb NOT NULL CHECK(jsonb_typeof(choices)='object' AND octet_length(choices::text)<=500000),
 result jsonb NOT NULL CHECK(jsonb_typeof(result)='object' AND result @> '{"incomplete":true}'::jsonb),
 note text NOT NULL CHECK(length(note) BETWEEN 1 AND 500 AND note=btrim(note)),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(project_id,revision)
);
ALTER TABLE public.project_cost_corrected_reviews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.project_cost_corrected_reviews FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION app_private.guard_project_cost_corrected_review_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$BEGIN RAISE EXCEPTION 'Corrected review history is immutable' USING ERRCODE='23514'; END$$;
REVOKE ALL ON FUNCTION app_private.guard_project_cost_corrected_review_immutable() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER guard_project_cost_corrected_review_immutable BEFORE UPDATE OR DELETE ON public.project_cost_corrected_reviews FOR EACH ROW EXECUTE FUNCTION app_private.guard_project_cost_corrected_review_immutable();
CREATE FUNCTION public.record_project_cost_corrected_review(p_request uuid,p_project uuid,p_expected_revision integer,p_snapshot jsonb,p_choices jsonb,p_note text,p_ack boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid:=auth.uid();v_existing public.project_cost_corrected_reviews%ROWTYPE;v_latest integer;v_now jsonb;v_result jsonb;v_note text;
BEGIN
 IF v_actor IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance required' USING ERRCODE='42501'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Corrected review requires read committed' USING ERRCODE='P1002'; END IF;
 IF p_request IS NULL OR p_project IS NULL OR p_expected_revision IS NULL OR p_expected_revision<0 OR p_expected_revision>=2147483647 OR jsonb_typeof(p_snapshot) IS DISTINCT FROM 'object' OR octet_length(p_snapshot::text)>2097152 OR jsonb_typeof(p_choices) IS DISTINCT FROM 'object' OR octet_length(p_choices::text)>500000 OR p_note IS NULL OR length(btrim(p_note)) NOT BETWEEN 1 AND 500 OR btrim(p_note) ~ '[[:cntrl:]]' OR p_ack IS DISTINCT FROM true THEN RAISE EXCEPTION 'Invalid corrected review' USING ERRCODE='22023'; END IF;
 v_note:=btrim(p_note);
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
CREATE FUNCTION public.project_cost_corrected_review(p_project uuid,p_revision integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_row public.project_cost_corrected_reviews%ROWTYPE;v_latest integer;v_now jsonb;v_status text:='unavailable';
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance required' USING ERRCODE='42501'; END IF;
 IF p_project IS NULL OR (p_revision IS NOT NULL AND p_revision<1) OR NOT EXISTS(SELECT 1 FROM public.projects WHERE id=p_project) THEN RAISE EXCEPTION 'Corrected review unavailable' USING ERRCODE='22023'; END IF;
 SELECT coalesce(max(revision),0) INTO v_latest FROM public.project_cost_corrected_reviews WHERE project_id=p_project;
 IF v_latest=0 AND p_revision IS NULL THEN RETURN jsonb_build_object('project_id',p_project,'found',false,'latest_revision',0); END IF;
 SELECT * INTO v_row FROM public.project_cost_corrected_reviews WHERE project_id=p_project AND revision=coalesce(p_revision,v_latest);
 IF NOT FOUND THEN RAISE EXCEPTION 'Corrected review unavailable' USING ERRCODE='P0002'; END IF;
 BEGIN
  v_now:=public.project_cost_correction_inventory(p_project);
  v_status:=CASE WHEN v_now #- '{historical_review,base,captured_at}'=v_row.snapshot #- '{historical_review,base,captured_at}' THEN 'matches' ELSE 'changed' END;
 EXCEPTION WHEN others THEN v_status:='unavailable'; END;
 RETURN jsonb_build_object('project_id',p_project,'found',true,'latest_revision',v_latest,'revision',v_row.revision,'request_id',v_row.request_id,'actor_id',v_row.actor_id,'recorded_at',v_row.recorded_at,'snapshot',v_row.snapshot,'choices',v_row.choices,'result',v_row.result,'note',v_row.note,'freshness',v_status);
END $$;
REVOKE ALL ON FUNCTION public.record_project_cost_corrected_review(uuid,uuid,integer,jsonb,jsonb,text,boolean),public.project_cost_corrected_review(uuid,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.record_project_cost_corrected_review(uuid,uuid,integer,jsonb,jsonb,text,boolean),public.project_cost_corrected_review(uuid,integer) TO authenticated;
DO $postflight$
DECLARE r text;
BEGIN
 FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF has_table_privilege(r,'public.project_cost_corrected_reviews','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid='public.project_cost_corrected_reviews'::regclass AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege(r,a.attrelid,a.attname,'SELECT,INSERT,UPDATE,REFERENCES')) OR has_function_privilege(r,'app_private.guard_project_cost_corrected_review_immutable()','EXECUTE') THEN RAISE EXCEPTION 'Unexpected corrected review direct access'; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['anon','service_role']) roles(r) WHERE has_function_privilege(roles.r,'public.record_project_cost_corrected_review(uuid,uuid,integer,jsonb,jsonb,text,boolean)','EXECUTE') OR has_function_privilege(roles.r,'public.project_cost_corrected_review(uuid,integer)','EXECUTE')) OR NOT has_function_privilege('authenticated','public.record_project_cost_corrected_review(uuid,uuid,integer,jsonb,jsonb,text,boolean)','EXECUTE') OR NOT has_function_privilege('authenticated','public.project_cost_corrected_review(uuid,integer)','EXECUTE') THEN RAISE EXCEPTION 'Unexpected corrected review function privileges'; END IF;
END $postflight$;

DO $corrected_development_postflight$ BEGIN
 IF EXISTS(SELECT 1 FROM public.project_cost_corrected_reviews) OR NOT coalesce((SELECT relrowsecurity FROM pg_class WHERE oid='public.project_cost_corrected_reviews'::regclass),false) THEN RAISE EXCEPTION 'Corrected review postflight failed'; END IF;
END $corrected_development_postflight$;
