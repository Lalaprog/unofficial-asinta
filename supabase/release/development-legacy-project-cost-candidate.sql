-- DEVELOPMENT CANDIDATE: execute in ONE managed transaction only.
-- This payload is held pending exact-target rollback rehearsal and client release.
-- It cannot ensure old open browser tabs refresh or prevent privileged writers.
DO $hold$ BEGIN IF current_setting('app.legacy_cost_development_reviewed',true) IS DISTINCT FROM 'yes' THEN RAISE EXCEPTION 'Legacy cost development rollout is held'; END IF; END $hold$;
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='60s';
DO $target$
DECLARE r record;f oid;
BEGIN
 IF current_database()<>'postgres' THEN RAISE EXCEPTION 'Unexpected development database'; END IF;
 FOR r IN SELECT * FROM (VALUES
  ('public.project_cost_corrected_preview(uuid,jsonb,jsonb,boolean)','2be1e27aa9b69d0076edc5e1c350d232',true),
  ('public.project_cost_correction_inventory(uuid)','77d2de8f891678789ec4ffc1fdf34079',true),
  ('public.project_cost_correction_attribution(text,uuid,integer)','a2b84f7beca7138cfd721216917efe32',true),
  ('public.project_cost_corrected_review(uuid,integer)','a5a2b78df46d98e5736b2cb0e97382ea',true),
  ('public.project_cost_cross_site_review(uuid,integer)','44a016ef665816798689061e9dbf2bb3',true),
  ('public.project_cost_cross_site_review_context(uuid,text,uuid)','8653ebc231881861173d539bd9062c67',true),
  ('public.project_cost_recorded_coverage(uuid)','95fa4a3a6f8d212b319e0fbde7be4df9',true),
  ('public.project_recorded_cost_snapshot(uuid)','a470f6a602c2327dd80ed477551dea7a',false),
  ('public.project_cost_cross_site_overview(uuid)','400f4c80ce4a6e5208df64fa3740a46d',false)
 ) AS e(signature,digest,definer) LOOP
  f:=to_regprocedure(r.signature);
  IF f IS NULL OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=f AND p.prokind='f' AND p.prosecdef=r.definer AND p.provolatile='s' AND pg_get_userbyid(p.proowner)='postgres' AND md5(p.prosrc)=r.digest) OR NOT has_function_privilege('authenticated',f,'EXECUTE') OR has_function_privilege('anon',f,'EXECUTE') OR has_function_privilege('service_role',f,'EXECUTE') THEN RAISE EXCEPTION 'Development dependency differs: %',r.signature; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_class c WHERE c.oid IN ('public.weekly_worker_paid_allocations'::regclass,'public.weekly_worker_draft_sources'::regclass,'public.paid_payroll_adjustment_cases'::regclass,'public.project_cost_correction_attributions'::regclass,'public.project_cost_correction_sites'::regclass,'public.project_cost_corrected_reviews'::regclass,'public.project_cost_cross_site_reviews'::regclass) AND (NOT c.relrowsecurity OR pg_get_userbyid(c.relowner)<>'postgres' OR has_table_privilege('anon',c.oid,'INSERT,UPDATE,DELETE,TRUNCATE') OR has_table_privilege('authenticated',c.oid,'INSERT,UPDATE,DELETE,TRUNCATE') OR has_table_privilege('service_role',c.oid,'INSERT,UPDATE,DELETE,TRUNCATE'))) THEN RAISE EXCEPTION 'Unexpected evidence table permissions'; END IF;
END $target$;
-- The nested candidates remain held standalone; this reviewed bundle makes
-- their local hold settings explicit, inside the same transaction.
SET LOCAL app.legacy_correction_candidate='synthetic-only';
SET LOCAL app.legacy_old_client_guard_candidate='synthetic-only';

-- Source: legacy_paid_voucher_attribution.sql SHA256 c4fbfce753bb49e95d2ee32ec126ba45f246347e9398a94eb10d9d5c359939ea
-- HELD CANDIDATE: Founder-reviewed site attribution of an existing legacy paid
-- worker voucher. Creates attribution evidence only: no payment, payroll edit,
-- expense, Bale or accounting posting. Not wired into project-cost reviews.
-- Requires a coordinated reader/correction/coverage cutover and concurrency
-- review before installation; do not execute on a shared or hosted database.
-- KNOWN HOLD: concurrent correction/weekly/
-- historical writers and review lock ordering have not been proven on PG17.
-- Later-created overlaps/corrections invalidate the evidence; no correction
-- path or atomic invalidation of a saved project review is implemented here.
-- Supervisor names are conservative clues, not reliable identity. Existing
-- expense/Bale overlap review still needs integration before totals use these rows.
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
DO $preflight$ BEGIN
 IF to_regclass('public.users') IS NULL OR to_regclass('public.workers') IS NULL OR to_regclass('public.projects') IS NULL
 OR to_regclass('public.payroll') IS NULL OR to_regclass('public.advances') IS NULL
 OR to_regclass('public.weekly_worker_draft_sources') IS NULL OR to_regclass('public.weekly_worker_paid_allocations') IS NULL
 OR to_regclass('public.historical_external_worker_payroll') IS NULL OR to_regclass('public.paid_payroll_adjustment_cases') IS NULL OR to_regclass('public.supervisor_period_payroll') IS NULL
 OR to_regprocedure('app_private.paid_adjustment_voucher_snapshot(public.payroll)') IS NULL
 OR to_regprocedure('auth.uid()') IS NULL OR to_regprocedure('public.is_founder()') IS NULL OR to_regprocedure('public.session_assurance_satisfied()') IS NULL THEN RAISE EXCEPTION 'Legacy attribution prerequisites missing'; END IF;
 IF to_regclass('public.legacy_paid_voucher_attributions') IS NOT NULL OR to_regclass('public.legacy_paid_voucher_attribution_sites') IS NOT NULL OR to_regprocedure('public.legacy_paid_voucher_attribution(uuid)') IS NOT NULL OR to_regprocedure('public.record_legacy_paid_voucher_attribution(uuid,uuid,jsonb,jsonb,jsonb,text,boolean)') IS NOT NULL OR to_regprocedure('public.record_legacy_paid_voucher_attribution(uuid,uuid,jsonb,jsonb,jsonb,text,boolean,jsonb)') IS NOT NULL THEN RAISE EXCEPTION 'Legacy attribution objects already exist'; END IF;
END $preflight$;
CREATE TABLE public.legacy_paid_voucher_attributions (
 request_id uuid PRIMARY KEY,
 payroll_id uuid NOT NULL UNIQUE REFERENCES public.payroll(id) ON DELETE RESTRICT,
 voucher_snapshot jsonb NOT NULL CHECK(jsonb_typeof(voucher_snapshot)='object' AND octet_length(voucher_snapshot::text)<=65536),
 worker_snapshot jsonb NOT NULL CHECK(jsonb_typeof(worker_snapshot)='object' AND octet_length(worker_snapshot::text)<=65536),
 case_snapshot jsonb NOT NULL CHECK(jsonb_typeof(case_snapshot)='array' AND jsonb_array_length(case_snapshot)<=500 AND octet_length(case_snapshot::text)<=524288),
 split jsonb NOT NULL CHECK(jsonb_typeof(split)='array' AND jsonb_array_length(split) BETWEEN 1 AND 50),
 note text NOT NULL CHECK(length(note) BETWEEN 1 AND 500 AND note=btrim(note)),
 actor_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE public.legacy_paid_voucher_attribution_sites (
 attribution_id uuid NOT NULL REFERENCES public.legacy_paid_voucher_attributions(request_id) ON DELETE RESTRICT,
 project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE RESTRICT,
 gross numeric(10,2) NOT NULL CHECK(gross>0),
 PRIMARY KEY(attribution_id,project_id)
);
CREATE INDEX legacy_paid_voucher_attribution_project_idx ON public.legacy_paid_voucher_attribution_sites(project_id,attribution_id);
ALTER TABLE public.legacy_paid_voucher_attributions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.legacy_paid_voucher_attribution_sites ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.legacy_paid_voucher_attributions,public.legacy_paid_voucher_attribution_sites FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION app_private.guard_legacy_voucher_attribution_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$BEGIN RAISE EXCEPTION 'Legacy voucher attribution is immutable; separate correction required' USING ERRCODE='23514'; END$$;
REVOKE ALL ON FUNCTION app_private.guard_legacy_voucher_attribution_immutable() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER legacy_voucher_attribution_immutable BEFORE UPDATE OR DELETE ON public.legacy_paid_voucher_attributions FOR EACH ROW EXECUTE FUNCTION app_private.guard_legacy_voucher_attribution_immutable();
CREATE TRIGGER legacy_voucher_attribution_sites_immutable BEFORE UPDATE OR DELETE ON public.legacy_paid_voucher_attribution_sites FOR EACH ROW EXECUTE FUNCTION app_private.guard_legacy_voucher_attribution_immutable();

-- This point-in-time status is neither payment proof nor a guarantee that a
-- subsequent write will succeed. The writer rechecks under locks.
CREATE FUNCTION public.legacy_paid_voucher_attribution(p_payroll uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_pay public.payroll%ROWTYPE;v_worker public.workers%ROWTYPE;v_saved public.legacy_paid_voucher_attributions%ROWTYPE;v_snapshot jsonb;v_worker_snapshot jsonb;v_split jsonb;v_cases bigint;v_case_snapshot jsonb;v_risks jsonb:='[]'::jsonb;v_source_changed boolean;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance required' USING ERRCODE='42501'; END IF;
 SELECT * INTO v_pay FROM public.payroll WHERE id=p_payroll;
 IF NOT FOUND THEN RAISE EXCEPTION 'Voucher unavailable' USING ERRCODE='P0002'; END IF;
 SELECT * INTO v_worker FROM public.workers WHERE id=v_pay.worker_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Worker unavailable' USING ERRCODE='P0002'; END IF;
 v_snapshot:=app_private.paid_adjustment_voucher_snapshot(v_pay);
 v_worker_snapshot:=jsonb_build_object('id',v_worker.id,'name',v_worker.name,'position',v_worker.position,'active',v_worker.active);
 SELECT count(*),coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.id),'[]'::jsonb) INTO v_cases,v_case_snapshot FROM public.paid_payroll_adjustment_cases c WHERE payroll_id=p_payroll;
 IF v_cases>500 OR octet_length(v_case_snapshot::text)>524288 THEN RAISE EXCEPTION 'Too many correction cases to review' USING ERRCODE='54000'; END IF;
 IF v_pay.status IS DISTINCT FROM 'paid' THEN v_risks:=v_risks||jsonb_build_array('not_paid'); END IF;
 IF v_pay.gross_pay IS NULL OR v_pay.gross_pay='NaN'::numeric OR v_pay.gross_pay<=0 OR v_pay.gross_pay>=100000000 OR v_pay.gross_pay<>round(v_pay.gross_pay,2) OR v_pay.bale_deduction IS NULL OR v_pay.other_deductions IS NULL OR v_pay.net_pay IS NULL OR v_pay.bale_deduction='NaN'::numeric OR v_pay.other_deductions='NaN'::numeric OR v_pay.net_pay='NaN'::numeric OR v_pay.bale_deduction<0 OR v_pay.other_deductions<0 OR v_pay.net_pay<0 OR v_pay.bale_deduction<>round(v_pay.bale_deduction,2) OR v_pay.other_deductions<>round(v_pay.other_deductions,2) OR v_pay.net_pay<>round(v_pay.net_pay,2) OR v_pay.gross_pay-v_pay.bale_deduction-v_pay.other_deductions IS DISTINCT FROM v_pay.net_pay THEN v_risks:=v_risks||jsonb_build_array('invalid_amounts'); END IF;
 IF v_pay.period_start IS NULL OR v_pay.period_end IS NULL OR NOT isfinite(v_pay.period_start) OR NOT isfinite(v_pay.period_end) OR v_pay.period_start>v_pay.period_end THEN v_risks:=v_risks||jsonb_build_array('invalid_period'); END IF;
 IF EXISTS(SELECT 1 FROM public.weekly_worker_draft_sources WHERE payroll_id=p_payroll) OR EXISTS(SELECT 1 FROM public.weekly_worker_paid_allocations WHERE payroll_id=p_payroll) THEN v_risks:=v_risks||jsonb_build_array('generated_or_allocated'); END IF;
 IF strpos(lower(coalesce(v_worker.position,'')),'supervisor')>0 OR EXISTS(SELECT 1 FROM public.users u WHERE u.role IN ('supervisor','founder') AND (u.id=v_worker.id OR lower(btrim(u.name))=lower(btrim(v_worker.name)))) OR EXISTS(SELECT 1 FROM public.supervisor_period_payroll s JOIN public.users u ON u.id=s.supervisor_id WHERE s.period_start<=v_pay.period_end AND s.period_end>=v_pay.period_start AND (s.supervisor_id=v_worker.id OR lower(btrim(v_worker.name)) IN (lower(btrim(s.supervisor_name)),lower(btrim(u.name))))) THEN v_risks:=v_risks||jsonb_build_array('possible_supervisor'); END IF;
 IF EXISTS(SELECT 1 FROM public.workers w WHERE w.id<>v_worker.id AND lower(btrim(w.name))=lower(btrim(v_worker.name))) THEN v_risks:=v_risks||jsonb_build_array('possible_duplicate_worker'); END IF;
 IF EXISTS(SELECT 1 FROM public.payroll p WHERE p.id<>p_payroll AND p.worker_id=v_pay.worker_id AND p.period_start<=v_pay.period_end AND p.period_end>=v_pay.period_start) OR EXISTS(SELECT 1 FROM public.historical_external_worker_payroll h WHERE h.worker_id=v_pay.worker_id AND h.period_start<=v_pay.period_end AND h.period_end>=v_pay.period_start) THEN v_risks:=v_risks||jsonb_build_array('overlapping_payroll'); END IF;
 IF v_cases>0 THEN v_risks:=v_risks||jsonb_build_array('correction_cases'); END IF;
 SELECT * INTO v_saved FROM public.legacy_paid_voucher_attributions WHERE payroll_id=p_payroll;
 -- A case does not change the original voucher's site split. It must be
 -- reviewed separately before a corrected project total can be produced.
 IF NOT FOUND THEN RETURN jsonb_build_object('payroll_id',p_payroll,'worker_name',v_worker.name,'worker',v_worker_snapshot,'voucher',v_snapshot,'eligible',v_risks IN ('[]'::jsonb,'["correction_cases"]'::jsonb),'risks',v_risks,'cases',v_case_snapshot,'found',false); END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('project_id',s.project_id,'gross',s.gross::text) ORDER BY s.project_id),'[]'::jsonb) INTO v_split FROM public.legacy_paid_voucher_attribution_sites s WHERE s.attribution_id=v_saved.request_id;
 IF v_split IS DISTINCT FROM v_saved.split OR (SELECT coalesce(sum(gross),0) FROM public.legacy_paid_voucher_attribution_sites WHERE attribution_id=v_saved.request_id) IS DISTINCT FROM (v_saved.voucher_snapshot->>'gross_pay')::numeric THEN RAISE EXCEPTION 'Saved attribution split differs; investigate' USING ERRCODE='22023'; END IF;
 v_source_changed:=v_snapshot IS DISTINCT FROM v_saved.voucher_snapshot OR v_worker_snapshot IS DISTINCT FROM v_saved.worker_snapshot OR v_risks NOT IN ('[]'::jsonb,'["correction_cases"]'::jsonb);
 RETURN jsonb_build_object('payroll_id',p_payroll,'worker_name',v_worker.name,'worker',v_worker_snapshot,'voucher',v_snapshot,'eligible',false,'risks',v_risks,'found',true,'request_id',v_saved.request_id,'snapshot',v_saved.voucher_snapshot,'recorded_worker',v_saved.worker_snapshot,'split',v_saved.split,'note',v_saved.note,'actor_id',v_saved.actor_id,'recorded_at',v_saved.recorded_at,'source_changed',v_source_changed,'case_count',v_cases,'cases',v_case_snapshot,'recorded_cases',v_saved.case_snapshot);
END $$;

CREATE FUNCTION public.record_legacy_paid_voucher_attribution(p_request uuid,p_payroll uuid,p_expected jsonb,p_expected_worker jsonb,p_split jsonb,p_note text,p_ack boolean,p_expected_cases jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_item jsonb;v_split jsonb:='[]'::jsonb;v_seen uuid[]:='{}';v_project uuid;v_amount numeric;v_sum numeric:=0;v_note text;v_current jsonb;v_saved public.legacy_paid_voucher_attributions%ROWTYPE;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance required' USING ERRCODE='42501'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Legacy attribution requires read committed isolation' USING ERRCODE='P1002'; END IF;
 IF p_request IS NULL OR p_payroll IS NULL OR jsonb_typeof(p_expected) IS DISTINCT FROM 'object' OR octet_length(p_expected::text)>65536 OR jsonb_typeof(p_expected_worker) IS DISTINCT FROM 'object' OR octet_length(p_expected_worker::text)>65536 OR jsonb_typeof(p_split) IS DISTINCT FROM 'array' OR jsonb_array_length(p_split) NOT BETWEEN 1 AND 50 OR p_note IS NULL OR length(btrim(p_note)) NOT BETWEEN 1 AND 500 OR btrim(p_note)~'[[:cntrl:]]' OR p_ack IS DISTINCT FROM true OR jsonb_typeof(p_expected_cases) IS DISTINCT FROM 'array' OR jsonb_array_length(p_expected_cases)>500 OR octet_length(p_expected_cases::text)>524288 THEN RAISE EXCEPTION 'Invalid reviewed voucher attribution' USING ERRCODE='22023'; END IF;
 FOR v_item IN SELECT value FROM jsonb_array_elements(p_split) LOOP
  IF jsonb_typeof(v_item) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(v_item))<>2 OR NOT(v_item ?& ARRAY['project_id','gross']) OR coalesce(v_item->>'project_id','')!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR coalesce(v_item->>'gross','')!~'^(0|[1-9][0-9]{0,7})\.[0-9]{2}$' THEN RAISE EXCEPTION 'Invalid split row' USING ERRCODE='22023'; END IF;
  v_project:=(v_item->>'project_id')::uuid;v_amount:=(v_item->>'gross')::numeric;
  IF v_project=ANY(v_seen) OR v_amount<=0 OR v_amount>=100000000 THEN RAISE EXCEPTION 'Duplicate site or invalid gross' USING ERRCODE='22023'; END IF;
  v_seen:=array_append(v_seen,v_project);v_sum:=v_sum+v_amount;v_split:=v_split||jsonb_build_array(jsonb_build_object('project_id',v_project,'gross',v_amount::numeric(10,2)::text));
 END LOOP;
 SELECT jsonb_agg(value ORDER BY (value->>'project_id')::uuid) INTO v_split FROM jsonb_array_elements(v_split);v_note:=btrim(p_note);
 PERFORM pg_catalog.set_config('lock_timeout','3s',true);
 -- Common leading lock order with historical payroll and weekly payment.
 LOCK TABLE public.users,public.workers,public.projects,public.advances,public.payroll IN SHARE ROW EXCLUSIVE MODE;
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance required' USING ERRCODE='42501'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('legacy-voucher-attribution-request:'||p_request::text,0));
 -- Both adjustment paths lock worker then voucher. Cases are signalled
 -- separately; the original split neither freezes nor settles them.
 PERFORM 1 FROM public.workers WHERE id=(SELECT worker_id FROM public.payroll WHERE id=p_payroll) FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Worker unavailable' USING ERRCODE='P0002'; END IF;
 PERFORM 1 FROM public.payroll WHERE id=p_payroll FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Voucher unavailable' USING ERRCODE='P0002'; END IF;
 v_current:=public.legacy_paid_voucher_attribution(p_payroll);
 SELECT * INTO v_saved FROM public.legacy_paid_voucher_attributions WHERE request_id=p_request;
 IF FOUND THEN
  IF (v_saved.payroll_id,v_saved.voucher_snapshot,v_saved.worker_snapshot,v_saved.case_snapshot,v_saved.split,v_saved.note,v_saved.actor_id) IS DISTINCT FROM (p_payroll,p_expected,p_expected_worker,p_expected_cases,v_split,v_note,auth.uid()) OR coalesce((v_current->>'source_changed')::boolean,true) THEN RAISE EXCEPTION 'Retry differs or source evidence changed' USING ERRCODE='22023'; END IF;
  RETURN jsonb_build_object('request_id',p_request,'payroll_id',p_payroll,'replayed',true);
 END IF;
 IF v_current->'voucher' IS DISTINCT FROM p_expected OR v_current->'worker' IS DISTINCT FROM p_expected_worker THEN RAISE EXCEPTION 'Voucher or worker changed; reload' USING ERRCODE='40001'; END IF;
 IF v_current->'cases' IS DISTINCT FROM p_expected_cases THEN RAISE EXCEPTION 'Correction cases changed; reload before recording' USING ERRCODE='40001'; END IF;
 IF coalesce((v_current->>'found')::boolean,true) OR NOT coalesce((v_current->>'eligible')::boolean,false) THEN RAISE EXCEPTION 'Voucher requires separate reconciliation' USING ERRCODE='22023'; END IF;
 IF v_sum IS DISTINCT FROM (p_expected->>'gross_pay')::numeric OR (SELECT count(*) FROM public.projects WHERE id=ANY(v_seen))<>cardinality(v_seen) THEN RAISE EXCEPTION 'Site split must equal voucher gross and name existing projects' USING ERRCODE='22023'; END IF;
 INSERT INTO public.legacy_paid_voucher_attributions(request_id,payroll_id,voucher_snapshot,worker_snapshot,case_snapshot,split,note,actor_id) VALUES(p_request,p_payroll,p_expected,p_expected_worker,p_expected_cases,v_split,v_note,auth.uid());
 INSERT INTO public.legacy_paid_voucher_attribution_sites(attribution_id,project_id,gross) SELECT p_request,(value->>'project_id')::uuid,(value->>'gross')::numeric FROM jsonb_array_elements(v_split);
 RETURN jsonb_build_object('request_id',p_request,'payroll_id',p_payroll,'replayed',false);
END $$;
REVOKE ALL ON FUNCTION public.legacy_paid_voucher_attribution(uuid),public.record_legacy_paid_voucher_attribution(uuid,uuid,jsonb,jsonb,jsonb,text,boolean,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.legacy_paid_voucher_attribution(uuid),public.record_legacy_paid_voucher_attribution(uuid,uuid,jsonb,jsonb,jsonb,text,boolean,jsonb) TO authenticated;
DO $postflight$ DECLARE r text;t regclass; BEGIN
 FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  FOREACH t IN ARRAY ARRAY['public.legacy_paid_voucher_attributions'::regclass,'public.legacy_paid_voucher_attribution_sites'::regclass] LOOP
   IF has_table_privilege(r,t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=t AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege(r,t,a.attname,'SELECT,INSERT,UPDATE,REFERENCES')) THEN RAISE EXCEPTION 'Unexpected legacy attribution table privilege'; END IF;
  END LOOP;
  IF has_function_privilege(r,'app_private.guard_legacy_voucher_attribution_immutable()','EXECUTE') THEN RAISE EXCEPTION 'Unexpected legacy guard execute'; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['anon','service_role']) roles(r) WHERE has_function_privilege(roles.r,'public.legacy_paid_voucher_attribution(uuid)','EXECUTE') OR has_function_privilege(roles.r,'public.record_legacy_paid_voucher_attribution(uuid,uuid,jsonb,jsonb,jsonb,text,boolean,jsonb)','EXECUTE')) OR NOT has_function_privilege('authenticated','public.legacy_paid_voucher_attribution(uuid)','EXECUTE') OR NOT has_function_privilege('authenticated','public.record_legacy_paid_voucher_attribution(uuid,uuid,jsonb,jsonb,jsonb,text,boolean,jsonb)','EXECUTE') THEN RAISE EXCEPTION 'Unexpected legacy attribution execute'; END IF;
END $postflight$;


-- Source: project_cost_legacy_voucher_preview.sql SHA256 26c00f8736b72e9f2e67f0882115aefda19c9563eae73430d4e28816cf3ac0a8
-- HELD: additive legacy-voucher review experiment. Not an installation script
-- or a saved accounting ledger. Requires legacy_paid_voucher_attribution.sql,
-- correction inventory and corrected preview; do not deploy in isolation.
-- A later case or changed source blocks this whole preview pending an actual
-- correction workflow. Existing saved reviews and coverage DO NOT include these
-- legacy splits. They must be updated atomically before any production use.
-- No money, expense, payroll, project allocation or saved review is written.
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
DO $preflight$ BEGIN
 IF to_regclass('public.legacy_paid_voucher_attributions') IS NULL OR to_regclass('public.legacy_paid_voucher_attribution_sites') IS NULL
 OR to_regprocedure('public.legacy_paid_voucher_attribution(uuid)') IS NULL OR to_regprocedure('public.project_cost_correction_inventory(uuid)') IS NULL
 OR to_regprocedure('public.project_cost_corrected_preview(uuid,jsonb,jsonb,boolean)') IS NULL OR to_regprocedure('public.is_founder()') IS NULL OR to_regprocedure('public.session_assurance_satisfied()') IS NULL OR to_regprocedure('auth.uid()') IS NULL THEN RAISE EXCEPTION 'Legacy project preview prerequisites missing'; END IF;
 IF to_regprocedure('public.project_cost_legacy_voucher_inventory(uuid)') IS NOT NULL OR to_regprocedure('public.project_cost_legacy_voucher_preview(uuid,jsonb,jsonb,jsonb,boolean)') IS NOT NULL THEN RAISE EXCEPTION 'Legacy project preview already exists'; END IF;
END $preflight$;
CREATE FUNCTION public.project_cost_legacy_voucher_inventory(p_project uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_base jsonb;v_row record;v_status jsonb;v_legacy jsonb:='[]'::jsonb;v_result jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance required' USING ERRCODE='42501'; END IF;
 IF p_project IS NULL OR NOT EXISTS(SELECT 1 FROM public.projects WHERE id=p_project) THEN RAISE EXCEPTION 'Project unavailable' USING ERRCODE='42501'; END IF;
 v_base:=public.project_cost_correction_inventory(p_project);
 IF v_base->>'project_id' IS DISTINCT FROM p_project::text OR jsonb_typeof(v_base->'historical_review'->'base'->'paid_allocations') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Project cost inventory unavailable' USING ERRCODE='22023'; END IF;
 IF (SELECT count(*) FROM public.legacy_paid_voucher_attribution_sites WHERE project_id=p_project)>500 THEN RAISE EXCEPTION 'More than 500 legacy voucher attributions' USING ERRCODE='54000'; END IF;
 FOR v_row IN SELECT a.request_id,a.payroll_id,s.gross FROM public.legacy_paid_voucher_attribution_sites s JOIN public.legacy_paid_voucher_attributions a ON a.request_id=s.attribution_id WHERE s.project_id=p_project ORDER BY a.payroll_id LOOP
  v_status:=public.legacy_paid_voucher_attribution(v_row.payroll_id);
  IF v_status->'found' IS DISTINCT FROM 'true'::jsonb OR v_status->>'request_id' IS DISTINCT FROM v_row.request_id::text OR v_status->'source_changed' IS DISTINCT FROM 'false'::jsonb OR v_status->'case_count' IS DISTINCT FROM '0'::jsonb OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_base->'historical_review'->'base'->'paid_allocations') p WHERE p->>'payroll_id'=v_row.payroll_id::text) THEN RAISE EXCEPTION 'Legacy voucher changed, overlaps a paid allocation or has a correction; investigate' USING ERRCODE='40001'; END IF;
  v_legacy:=v_legacy||jsonb_build_array(jsonb_build_object('request_id',v_row.request_id,'payroll_id',v_row.payroll_id,'site_gross',v_row.gross::text,'status',v_status));
 END LOOP;
 v_result:=jsonb_build_object('project_id',p_project,'base',v_base,'legacy_vouchers',v_legacy);
 IF octet_length(v_result::text)>2097152 THEN RAISE EXCEPTION 'Legacy project inventory too large' USING ERRCODE='54000'; END IF;
 RETURN v_result;
END $$;
CREATE FUNCTION public.project_cost_legacy_voucher_preview(p_project uuid,p_snapshot jsonb,p_choices jsonb,p_legacy_choices jsonb,p_ack boolean) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_now jsonb;v_base jsonb;v_item jsonb;v_choice jsonb;v_included numeric:=0;v_excluded numeric:=0;v_total numeric;v_count integer:=0;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance required' USING ERRCODE='42501'; END IF;
 IF p_project IS NULL OR p_ack IS DISTINCT FROM true OR jsonb_typeof(p_snapshot) IS DISTINCT FROM 'object' OR octet_length(p_snapshot::text)>2097152 OR jsonb_typeof(p_legacy_choices) IS DISTINCT FROM 'object' OR octet_length(p_legacy_choices::text)>500000 THEN RAISE EXCEPTION 'Invalid legacy cost review' USING ERRCODE='22023'; END IF;
 v_now:=public.project_cost_legacy_voucher_inventory(p_project);
 IF v_now #- '{base,historical_review,base,captured_at}' IS DISTINCT FROM p_snapshot #- '{base,historical_review,base,captured_at}' THEN RAISE EXCEPTION 'Project evidence changed; reload and review' USING ERRCODE='40001'; END IF;
 IF (SELECT count(*) FROM jsonb_object_keys(p_legacy_choices))<>jsonb_array_length(v_now->'legacy_vouchers') THEN RAISE EXCEPTION 'Review every legacy voucher' USING ERRCODE='22023'; END IF;
 FOR v_item IN SELECT value FROM jsonb_array_elements(v_now->'legacy_vouchers') LOOP
  v_choice:=p_legacy_choices->(v_item->>'request_id');
  IF jsonb_typeof(v_choice) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(CASE WHEN jsonb_typeof(v_choice)='object' THEN v_choice ELSE '{}'::jsonb END))<>2 OR NOT(v_choice ?& ARRAY['decision','reason']) OR coalesce(v_choice->>'decision','') NOT IN ('include','exclude') OR (v_choice->>'decision'='include' AND v_choice->'reason' IS DISTINCT FROM 'null'::jsonb) OR (v_choice->>'decision'='exclude' AND (jsonb_typeof(v_choice->'reason') IS DISTINCT FROM 'string' OR length(btrim(v_choice->>'reason')) NOT BETWEEN 1 AND 300 OR btrim(v_choice->>'reason') IS DISTINCT FROM v_choice->>'reason' OR (v_choice->>'reason')~'[[:cntrl:]]')) THEN RAISE EXCEPTION 'Invalid legacy voucher decision' USING ERRCODE='22023'; END IF;
  IF v_choice->>'decision'='include' THEN v_included:=v_included+(v_item->>'site_gross')::numeric; ELSE v_excluded:=v_excluded+(v_item->>'site_gross')::numeric;v_count:=v_count+1; END IF;
 END LOOP;
 v_base:=public.project_cost_corrected_preview(p_project,v_now->'base',p_choices,true);
 v_total:=(v_base->>'incomplete_total')::numeric+v_included;
 IF v_total<0 OR v_total>=100000000000000 THEN RAISE EXCEPTION 'Invalid legacy cost total' USING ERRCODE='22023'; END IF;
 RETURN jsonb_build_object('project_id',p_project,'base',v_base,'legacy_included_gross',v_included::numeric(16,2)::text,'legacy_excluded_gross',v_excluded::numeric(16,2)::text,'legacy_excluded_count',v_count,'incomplete_total',v_total::numeric(16,2)::text,'incomplete',true);
END $$;
REVOKE ALL ON FUNCTION public.project_cost_legacy_voucher_inventory(uuid),public.project_cost_legacy_voucher_preview(uuid,jsonb,jsonb,jsonb,boolean) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.project_cost_legacy_voucher_inventory(uuid),public.project_cost_legacy_voucher_preview(uuid,jsonb,jsonb,jsonb,boolean) TO authenticated;
DO $postflight$ DECLARE f oid; BEGIN
 FOREACH f IN ARRAY ARRAY['public.project_cost_legacy_voucher_inventory(uuid)'::regprocedure::oid,'public.project_cost_legacy_voucher_preview(uuid,jsonb,jsonb,jsonb,boolean)'::regprocedure::oid] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=f AND prosecdef AND provolatile='s' AND proconfig @> ARRAY['search_path=""']) OR NOT has_function_privilege('authenticated',f,'EXECUTE') OR has_function_privilege('anon',f,'EXECUTE') OR has_function_privilege('service_role',f,'EXECUTE') THEN RAISE EXCEPTION 'Unexpected legacy project preview privileges'; END IF;
 END LOOP;
END $postflight$;


-- Source: project_cost_legacy_review_ledger.sql SHA256 e9f995a93c4aa2bb32d9f62705da6107e9633013758eae5a198f235cb04416d8
-- HELD candidate: saves the separate legacy-inclusive corrected preview. Not a
-- replacement for the existing overview or cross-site ledger, a posting, a
-- complete cost, or proof of payment. The current legacy inventory blocks any
-- later case or changed source instead of resolving it. Do not install before
-- all screens, coverage, original-period corrections, privileges and lock
-- order are integrated and tested against the actual deployed functions.
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
DO $preflight$ BEGIN
 IF to_regprocedure('public.project_cost_legacy_voucher_inventory(uuid)') IS NULL OR to_regprocedure('public.project_cost_legacy_voucher_preview(uuid,jsonb,jsonb,jsonb,boolean)') IS NULL OR to_regclass('public.project_cost_legacy_reviews') IS NOT NULL OR to_regprocedure('public.record_project_cost_legacy_review(uuid,uuid,integer,jsonb,jsonb,jsonb,text,boolean)') IS NOT NULL OR to_regprocedure('public.project_cost_legacy_review(uuid,integer)') IS NOT NULL THEN RAISE EXCEPTION 'Legacy review prerequisites missing or collision'; END IF;
END $preflight$;
CREATE TABLE public.project_cost_legacy_reviews (
 request_id uuid PRIMARY KEY,project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE RESTRICT,
 revision integer NOT NULL CHECK(revision>0),expected_revision integer NOT NULL CHECK(expected_revision>=0 AND revision=expected_revision+1),
 actor_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object' AND octet_length(snapshot::text)<=2097152),
 choices jsonb NOT NULL CHECK(jsonb_typeof(choices)='object' AND octet_length(choices::text)<=500000),
 legacy_choices jsonb NOT NULL CHECK(jsonb_typeof(legacy_choices)='object' AND octet_length(legacy_choices::text)<=500000),
 result jsonb NOT NULL CHECK(jsonb_typeof(result)='object' AND result @> '{"incomplete":true}'::jsonb),
 note text NOT NULL CHECK(length(note) BETWEEN 1 AND 500 AND note=btrim(note)),recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(project_id,revision)
);
ALTER TABLE public.project_cost_legacy_reviews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.project_cost_legacy_reviews FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION app_private.guard_project_cost_legacy_review_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$BEGIN RAISE EXCEPTION 'Legacy review history is immutable' USING ERRCODE='23514'; END$$;
REVOKE ALL ON FUNCTION app_private.guard_project_cost_legacy_review_immutable() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER project_cost_legacy_review_immutable BEFORE UPDATE OR DELETE ON public.project_cost_legacy_reviews FOR EACH ROW EXECUTE FUNCTION app_private.guard_project_cost_legacy_review_immutable();
CREATE FUNCTION public.record_project_cost_legacy_review(p_request uuid,p_project uuid,p_expected_revision integer,p_snapshot jsonb,p_choices jsonb,p_legacy_choices jsonb,p_note text,p_ack boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid:=auth.uid();v_existing public.project_cost_legacy_reviews%ROWTYPE;v_latest integer;v_now jsonb;v_result jsonb;v_note text;
BEGIN
 IF v_actor IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance required' USING ERRCODE='42501'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Legacy review requires read committed' USING ERRCODE='P1002'; END IF;
 IF p_request IS NULL OR p_project IS NULL OR p_expected_revision IS NULL OR p_expected_revision<0 OR p_expected_revision>=2147483647 OR jsonb_typeof(p_snapshot) IS DISTINCT FROM 'object' OR octet_length(p_snapshot::text)>2097152 OR jsonb_typeof(p_choices) IS DISTINCT FROM 'object' OR octet_length(p_choices::text)>500000 OR jsonb_typeof(p_legacy_choices) IS DISTINCT FROM 'object' OR octet_length(p_legacy_choices::text)>500000 OR p_note IS NULL OR length(btrim(p_note)) NOT BETWEEN 1 AND 500 OR btrim(p_note)~'[[:cntrl:]]' OR p_ack IS DISTINCT FROM true THEN RAISE EXCEPTION 'Invalid legacy review' USING ERRCODE='22023'; END IF;
 v_note:=btrim(p_note);PERFORM pg_catalog.set_config('lock_timeout','3s',true);
 PERFORM 1 FROM public.users WHERE id=v_actor AND role='founder' FOR SHARE;
 IF NOT FOUND OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance required' USING ERRCODE='42501'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('legacy-cost-review-request:'||p_request::text,0));
 SELECT * INTO v_existing FROM public.project_cost_legacy_reviews WHERE request_id=p_request;
 IF FOUND THEN
  IF (v_existing.project_id,v_existing.actor_id,v_existing.expected_revision,v_existing.snapshot #- '{base,historical_review,base,captured_at}',v_existing.choices,v_existing.legacy_choices,v_existing.note) IS DISTINCT FROM (p_project,v_actor,p_expected_revision,p_snapshot #- '{base,historical_review,base,captured_at}',p_choices,p_legacy_choices,v_note) THEN RAISE EXCEPTION 'Legacy review request already used for different details' USING ERRCODE='22023'; END IF;
  RETURN jsonb_build_object('request_id',p_request,'project_id',p_project,'revision',v_existing.revision,'replayed',true);
 END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('legacy-cost-review-project:'||p_project::text,0));
 PERFORM 1 FROM public.projects WHERE id=p_project FOR KEY SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Project unavailable' USING ERRCODE='42501'; END IF;
 -- Match the deployed corrected-review source lock order; append new evidence.
 -- This remains a held candidate until all writers and race behavior are tested.
 LOCK TABLE public.users,public.workers,public.projects,public.supervisor_period_payroll,public.historical_external_worker_payroll,public.paid_period_assertion_cases,public.paid_payroll_adjustment_cases,public.expenses,public.confirmed_rental_expenses,public.payroll,public.weekly_worker_draft_sources,public.weekly_worker_paid_allocations,public.payroll_payment_dates,public.historical_worker_attributions,public.historical_worker_attribution_sites,public.project_cost_correction_attributions,public.project_cost_correction_sites,public.legacy_paid_voucher_attributions,public.legacy_paid_voucher_attribution_sites IN SHARE MODE;
 IF NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance required' USING ERRCODE='42501'; END IF;
 SELECT coalesce(max(revision),0) INTO v_latest FROM public.project_cost_legacy_reviews WHERE project_id=p_project;
 IF v_latest<>p_expected_revision THEN RAISE EXCEPTION 'Legacy review changed; reload and review' USING ERRCODE='40001'; END IF;
 v_now:=public.project_cost_legacy_voucher_inventory(p_project);
 IF v_now #- '{base,historical_review,base,captured_at}' IS DISTINCT FROM p_snapshot #- '{base,historical_review,base,captured_at}' THEN RAISE EXCEPTION 'Legacy project evidence changed; reload and review' USING ERRCODE='40001'; END IF;
 v_result:=public.project_cost_legacy_voucher_preview(p_project,v_now,p_choices,p_legacy_choices,true);
 INSERT INTO public.project_cost_legacy_reviews(request_id,project_id,revision,expected_revision,actor_id,snapshot,choices,legacy_choices,result,note) VALUES(p_request,p_project,v_latest+1,v_latest,v_actor,v_now,p_choices,p_legacy_choices,v_result,v_note);
 RETURN jsonb_build_object('request_id',p_request,'project_id',p_project,'revision',v_latest+1,'replayed',false);
END $$;
CREATE FUNCTION public.project_cost_legacy_review(p_project uuid,p_revision integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_row public.project_cost_legacy_reviews%ROWTYPE;v_latest integer;v_now jsonb;v_status text:='unavailable';
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance required' USING ERRCODE='42501'; END IF;
 IF p_project IS NULL OR (p_revision IS NOT NULL AND p_revision<1) OR NOT EXISTS(SELECT 1 FROM public.projects WHERE id=p_project) THEN RAISE EXCEPTION 'Legacy review unavailable' USING ERRCODE='22023'; END IF;
 SELECT coalesce(max(revision),0) INTO v_latest FROM public.project_cost_legacy_reviews WHERE project_id=p_project;
 IF v_latest=0 AND p_revision IS NULL THEN RETURN jsonb_build_object('project_id',p_project,'found',false,'latest_revision',0); END IF;
 SELECT * INTO v_row FROM public.project_cost_legacy_reviews WHERE project_id=p_project AND revision=coalesce(p_revision,v_latest);
 IF NOT FOUND THEN RAISE EXCEPTION 'Legacy review unavailable' USING ERRCODE='P0002'; END IF;
 BEGIN v_now:=public.project_cost_legacy_voucher_inventory(p_project);v_status:=CASE WHEN v_now #- '{base,historical_review,base,captured_at}'=v_row.snapshot #- '{base,historical_review,base,captured_at}' THEN 'matches' ELSE 'changed' END; EXCEPTION WHEN others THEN v_status:='unavailable'; END;
 RETURN jsonb_build_object('project_id',p_project,'found',true,'latest_revision',v_latest,'revision',v_row.revision,'request_id',v_row.request_id,'actor_id',v_row.actor_id,'recorded_at',v_row.recorded_at,'snapshot',v_row.snapshot,'choices',v_row.choices,'legacy_choices',v_row.legacy_choices,'result',v_row.result,'note',v_row.note,'freshness',v_status);
END $$;
REVOKE ALL ON FUNCTION public.record_project_cost_legacy_review(uuid,uuid,integer,jsonb,jsonb,jsonb,text,boolean),public.project_cost_legacy_review(uuid,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.record_project_cost_legacy_review(uuid,uuid,integer,jsonb,jsonb,jsonb,text,boolean),public.project_cost_legacy_review(uuid,integer) TO authenticated;
DO $postflight$ DECLARE r text; BEGIN
 FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF has_table_privilege(r,'public.project_cost_legacy_reviews','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid='public.project_cost_legacy_reviews'::regclass AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege(r,a.attrelid,a.attname,'SELECT,INSERT,UPDATE,REFERENCES')) OR has_function_privilege(r,'app_private.guard_project_cost_legacy_review_immutable()','EXECUTE') THEN RAISE EXCEPTION 'Unexpected legacy review direct access'; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['anon','service_role']) roles(r) WHERE has_function_privilege(roles.r,'public.record_project_cost_legacy_review(uuid,uuid,integer,jsonb,jsonb,jsonb,text,boolean)','EXECUTE') OR has_function_privilege(roles.r,'public.project_cost_legacy_review(uuid,integer)','EXECUTE')) OR NOT has_function_privilege('authenticated','public.record_project_cost_legacy_review(uuid,uuid,integer,jsonb,jsonb,jsonb,text,boolean)','EXECUTE') OR NOT has_function_privilege('authenticated','public.project_cost_legacy_review(uuid,integer)','EXECUTE') THEN RAISE EXCEPTION 'Unexpected legacy review privileges'; END IF;
END $postflight$;


-- Source: project_cost_legacy_correction_context.sql SHA256 c012553c450ecf2860f9cff22d701c47987d6940e0c3afa0bdb8a77f8428e2eb
-- HELD, read-only original-period context for a correction of an attributed
-- legacy voucher. It is NOT a corrected cost, decision, payment, posting, or
-- destination review. It does not unlock the existing legacy cost preview.
-- Case-only invalidation is distinguished from any changed voucher, worker,
-- competing allocation, Supervisor clue or overlapping payroll. The original
-- site split and current complete case evidence must still be reconciled by a
-- later reviewed, atomic cross-site workflow before inclusion in a total.
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
DO $preflight$ BEGIN
 IF to_regprocedure('public.legacy_paid_voucher_attribution(uuid)') IS NULL OR to_regprocedure('public.project_cost_correction_attribution(text,uuid,integer)') IS NULL OR to_regclass('public.paid_payroll_adjustment_cases') IS NULL OR to_regprocedure('public.project_cost_legacy_correction_context(uuid)') IS NOT NULL THEN RAISE EXCEPTION 'Legacy correction context prerequisites missing or collision'; END IF;
END $preflight$;
CREATE FUNCTION public.project_cost_legacy_correction_context(p_case uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_payroll uuid;v_status jsonb;v_correction jsonb;v_case jsonb;v_result jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance required' USING ERRCODE='42501'; END IF;
 IF p_case IS NULL THEN RAISE EXCEPTION 'Correction case required' USING ERRCODE='22023'; END IF;
 SELECT payroll_id INTO v_payroll FROM public.paid_payroll_adjustment_cases WHERE id=p_case;
 IF NOT FOUND THEN RAISE EXCEPTION 'Correction case unavailable' USING ERRCODE='P0002'; END IF;
 v_status:=public.legacy_paid_voucher_attribution(v_payroll);
 IF v_status->'found' IS DISTINCT FROM 'true'::jsonb OR v_status->'source_changed' IS DISTINCT FROM 'false'::jsonb OR v_status->'risks' IS DISTINCT FROM '["correction_cases"]'::jsonb OR (v_status->>'case_count')::integer<1 OR v_status->'voucher' IS DISTINCT FROM v_status->'snapshot' OR v_status->'worker' IS DISTINCT FROM v_status->'recorded_worker' THEN RAISE EXCEPTION 'Legacy original evidence changed or has another conflict; investigate' USING ERRCODE='40001'; END IF;
 v_correction:=public.project_cost_correction_attribution('voucher',p_case,NULL);v_case:=v_correction->'case';
 IF v_case->>'id' IS DISTINCT FROM p_case::text OR v_case->>'payroll_id' IS DISTINCT FROM v_payroll::text OR v_case->'original_voucher' IS DISTINCT FROM v_status->'snapshot' OR jsonb_typeof(v_case->'related_cases') IS DISTINCT FROM 'array' OR jsonb_array_length(v_case->'related_cases') IS DISTINCT FROM (v_status->>'case_count')::integer THEN RAISE EXCEPTION 'Correction and original voucher evidence differ' USING ERRCODE='40001'; END IF;
 v_result:=jsonb_build_object('source_kind','legacy_voucher','case_id',p_case,'payroll_id',v_payroll,'original',v_status,'correction',v_correction,'incomplete',true);
 IF octet_length(v_result::text)>262144 THEN RAISE EXCEPTION 'Legacy correction context too large' USING ERRCODE='54000'; END IF;
 RETURN v_result;
END $$;
REVOKE ALL ON FUNCTION public.project_cost_legacy_correction_context(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.project_cost_legacy_correction_context(uuid) TO authenticated;
DO $postflight$ BEGIN
 IF has_function_privilege('anon','public.project_cost_legacy_correction_context(uuid)','EXECUTE') OR has_function_privilege('service_role','public.project_cost_legacy_correction_context(uuid)','EXECUTE') OR NOT has_function_privilege('authenticated','public.project_cost_legacy_correction_context(uuid)','EXECUTE') OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.project_cost_legacy_correction_context(uuid)'::regprocedure AND prosecdef AND provolatile='s' AND proconfig @> ARRAY['search_path=""']) THEN RAISE EXCEPTION 'Unexpected legacy correction context privileges'; END IF;
END $postflight$;


-- Source: project_cost_legacy_corrected_source.sql SHA256 0fc99530f02b4dc25b51c2619506793318ff0490977f8579ae85519dd1cec72b
-- HELD: one legacy voucher with every original-period gross correction, across
-- every affected site in one statement snapshot. No posting/payment/review.
-- Callers must explicitly review whether multiple cases are distinct and must
-- not add these corrected amounts on top of the original legacy site split.
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
DO $preflight$ BEGIN
 IF to_regprocedure('public.project_cost_legacy_correction_context(uuid)') IS NULL OR to_regprocedure('public.legacy_paid_voucher_attribution(uuid)') IS NULL OR to_regclass('public.paid_payroll_adjustment_cases') IS NULL OR to_regprocedure('public.project_cost_legacy_corrected_source(uuid)') IS NOT NULL THEN RAISE EXCEPTION 'Legacy corrected source prerequisites missing or collision'; END IF;
END $preflight$;
CREATE FUNCTION public.project_cost_legacy_corrected_source(p_payroll uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_original jsonb;v_case_id uuid;v_context jsonb;v_correction jsonb;v_cases jsonb:='[]'::jsonb;v_projects uuid[];v_project uuid;v_before numeric;v_change numeric;v_after numeric;v_total numeric:=0;v_initial_total numeric:=0;v_change_total numeric:=0;v_expected_change numeric:=0;v_sites jsonb:='[]'::jsonb;v_result jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance required' USING ERRCODE='42501'; END IF;
 IF p_payroll IS NULL THEN RAISE EXCEPTION 'Voucher required' USING ERRCODE='22023'; END IF;
 v_original:=public.legacy_paid_voucher_attribution(p_payroll);
 IF v_original->'found' IS DISTINCT FROM 'true'::jsonb OR v_original->'source_changed' IS DISTINCT FROM 'false'::jsonb OR v_original->'voucher' IS DISTINCT FROM v_original->'snapshot' OR v_original->'worker' IS DISTINCT FROM v_original->'recorded_worker' OR v_original->'risks' NOT IN ('[]'::jsonb,'["correction_cases"]'::jsonb) THEN RAISE EXCEPTION 'Legacy voucher evidence changed or conflicts; investigate' USING ERRCODE='40001'; END IF;
 IF (v_original->>'case_count')::integer>100 THEN RAISE EXCEPTION 'Too many cases for one voucher' USING ERRCODE='54000'; END IF;
 FOR v_case_id IN SELECT id FROM public.paid_payroll_adjustment_cases WHERE payroll_id=p_payroll ORDER BY id LOOP
  v_context:=public.project_cost_legacy_correction_context(v_case_id);v_correction:=v_context->'correction';
  IF v_context->'original' IS DISTINCT FROM v_original OR v_correction->'case'->>'status' NOT IN ('settled_external','no_transfer') OR jsonb_typeof(v_correction->'attribution') IS DISTINCT FROM 'object' OR v_correction->'attribution'->'case_changed' IS DISTINCT FROM 'false'::jsonb OR v_correction->'attribution'->'case_snapshot' IS DISTINCT FROM v_correction->'case' OR jsonb_typeof(v_correction->'attribution'->'split') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Every legacy correction requires current resolved attribution' USING ERRCODE='22023'; END IF;
  v_expected_change:=v_expected_change+(v_correction->'attribution'->>'gross_change')::numeric;
  v_cases:=v_cases||jsonb_build_array(jsonb_build_object('case_id',v_case_id,'evidence',v_correction));
 END LOOP;
 IF jsonb_array_length(v_cases) IS DISTINCT FROM (v_original->>'case_count')::integer THEN RAISE EXCEPTION 'Legacy cases changed' USING ERRCODE='40001'; END IF;
 SELECT array_agg(project_id ORDER BY project_id) INTO v_projects FROM (
  SELECT (s->>'project_id')::uuid project_id FROM jsonb_array_elements(v_original->'split') s
  UNION SELECT (s->>'project_id')::uuid FROM jsonb_array_elements(v_cases) c CROSS JOIN LATERAL jsonb_array_elements(c->'evidence'->'attribution'->'split') s
 ) projects;
 IF coalesce(cardinality(v_projects),0) NOT BETWEEN 1 AND 150 THEN RAISE EXCEPTION 'Legacy corrected sites unavailable or too many' USING ERRCODE='54000'; END IF;
 FOREACH v_project IN ARRAY v_projects LOOP
  SELECT coalesce(sum((s->>'gross')::numeric),0) INTO v_before FROM jsonb_array_elements(v_original->'split') s WHERE (s->>'project_id')::uuid=v_project;
  SELECT coalesce(sum((s->>'gross_change')::numeric),0) INTO v_change FROM jsonb_array_elements(v_cases) c CROSS JOIN LATERAL jsonb_array_elements(c->'evidence'->'attribution'->'split') s WHERE (s->>'project_id')::uuid=v_project;
  v_after:=v_before+v_change;
  IF v_after<0 OR v_after>=10000000000 OR v_after<>round(v_after,2) THEN RAISE EXCEPTION 'Legacy correction exceeds original site cost' USING ERRCODE='22023'; END IF;
  v_initial_total:=v_initial_total+v_before;v_change_total:=v_change_total+v_change;v_total:=v_total+v_after;
  v_sites:=v_sites||jsonb_build_array(jsonb_build_object('project_id',v_project,'original_gross',v_before::numeric(12,2)::text,'gross_change',v_change::numeric(12,2)::text,'corrected_gross',v_after::numeric(12,2)::text));
 END LOOP;
 IF v_initial_total IS DISTINCT FROM (v_original->'snapshot'->>'gross_pay')::numeric OR v_change_total IS DISTINCT FROM v_expected_change OR v_total IS DISTINCT FROM v_initial_total+v_expected_change THEN RAISE EXCEPTION 'Legacy corrected source totals differ' USING ERRCODE='22023'; END IF;
 v_result:=jsonb_build_object('payroll_id',p_payroll,'original',v_original,'cases',v_cases,'sites',v_sites,'original_gross',v_initial_total::numeric(12,2)::text,'gross_change',v_change_total::numeric(12,2)::text,'corrected_gross',v_total::numeric(13,2)::text,'incomplete',true);
 IF octet_length(v_result::text)>1048576 THEN RAISE EXCEPTION 'Legacy corrected source too large' USING ERRCODE='54000'; END IF;
 RETURN v_result;
END $$;
REVOKE ALL ON FUNCTION public.project_cost_legacy_corrected_source(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.project_cost_legacy_corrected_source(uuid) TO authenticated;
DO $postflight$ BEGIN
 IF has_function_privilege('anon','public.project_cost_legacy_corrected_source(uuid)','EXECUTE') OR has_function_privilege('service_role','public.project_cost_legacy_corrected_source(uuid)','EXECUTE') OR NOT has_function_privilege('authenticated','public.project_cost_legacy_corrected_source(uuid)','EXECUTE') OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.project_cost_legacy_corrected_source(uuid)'::regprocedure AND prosecdef AND provolatile='s' AND proconfig @> ARRAY['search_path=""']) THEN RAISE EXCEPTION 'Unexpected legacy corrected source privileges'; END IF;
END $postflight$;


-- Source: project_cost_legacy_corrected_review_upgrade.sql SHA256 659677c0faa3f37032d714c07730c3ed0d238af4ddbba217b475eb03e5e0fbcb
-- HELD synthetic candidate. Changes legacy cost sources from original splits to
-- fully reconciled original-period sources (all cases, all sites). It does not
-- install by itself on the hosted project. A coordinated client and coverage
-- upgrade, old-writer cutover, lock audit and real-chain tests are required.
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
DO $preflight$ BEGIN
 IF current_setting('app.legacy_correction_candidate',true) IS DISTINCT FROM 'synthetic-only' THEN RAISE EXCEPTION 'Held for synthetic rehearsal'; END IF;
 IF to_regprocedure('public.project_cost_legacy_corrected_source(uuid)') IS NULL OR to_regprocedure('public.project_cost_legacy_voucher_inventory(uuid)') IS NULL OR to_regprocedure('public.project_cost_legacy_voucher_preview(uuid,jsonb,jsonb,jsonb,boolean)') IS NULL OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.project_cost_legacy_voucher_inventory(uuid)'::regprocedure)<>'76092c71deb0f1bb9b9c2e08558461dc' OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.project_cost_legacy_voucher_preview(uuid,jsonb,jsonb,jsonb,boolean)'::regprocedure)<>'4e9b2d52ff30dd1e3d9198f2ea262700' THEN RAISE EXCEPTION 'Legacy review dependency changed'; END IF;
END $preflight$;
CREATE OR REPLACE FUNCTION public.project_cost_legacy_voucher_inventory(p_project uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_base jsonb;v_row record;v_source jsonb;v_site jsonb;v_legacy jsonb:='[]'::jsonb;v_result jsonb;v_count bigint;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance required' USING ERRCODE='42501'; END IF;
 IF p_project IS NULL OR NOT EXISTS(SELECT 1 FROM public.projects WHERE id=p_project) THEN RAISE EXCEPTION 'Project unavailable' USING ERRCODE='42501'; END IF;
 v_base:=public.project_cost_correction_inventory(p_project);
 IF v_base->>'project_id' IS DISTINCT FROM p_project::text OR jsonb_typeof(v_base->'historical_review'->'base'->'paid_allocations') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Project cost inventory unavailable' USING ERRCODE='22023'; END IF;
 -- Include sources with an original split OR a latest correction at this site.
 -- Choosing the latest correction before filtering prevents old sites reappearing.
 SELECT count(*) INTO v_count FROM public.legacy_paid_voucher_attributions a WHERE EXISTS(SELECT 1 FROM public.legacy_paid_voucher_attribution_sites s WHERE s.attribution_id=a.request_id AND s.project_id=p_project) OR EXISTS(SELECT 1 FROM public.paid_payroll_adjustment_cases c JOIN public.project_cost_correction_attributions ca ON ca.voucher_case_id=c.id AND ca.source_kind='voucher' JOIN public.project_cost_correction_sites cs ON cs.request_id=ca.request_id WHERE c.payroll_id=a.payroll_id AND cs.project_id=p_project AND ca.revision=(SELECT max(b.revision) FROM public.project_cost_correction_attributions b WHERE b.source_kind='voucher' AND b.voucher_case_id=c.id));
 IF v_count>500 THEN RAISE EXCEPTION 'More than 500 legacy sources; separate reconciliation required' USING ERRCODE='54000'; END IF;
 FOR v_row IN SELECT a.request_id,a.payroll_id FROM public.legacy_paid_voucher_attributions a WHERE EXISTS(SELECT 1 FROM public.legacy_paid_voucher_attribution_sites s WHERE s.attribution_id=a.request_id AND s.project_id=p_project) OR EXISTS(SELECT 1 FROM public.paid_payroll_adjustment_cases c JOIN public.project_cost_correction_attributions ca ON ca.voucher_case_id=c.id AND ca.source_kind='voucher' JOIN public.project_cost_correction_sites cs ON cs.request_id=ca.request_id WHERE c.payroll_id=a.payroll_id AND cs.project_id=p_project AND ca.revision=(SELECT max(b.revision) FROM public.project_cost_correction_attributions b WHERE b.source_kind='voucher' AND b.voucher_case_id=c.id)) ORDER BY a.payroll_id LOOP
  v_source:=public.project_cost_legacy_corrected_source(v_row.payroll_id);
  IF v_source->'original'->>'request_id' IS DISTINCT FROM v_row.request_id::text OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_base->'historical_review'->'base'->'paid_allocations') p WHERE p->>'payroll_id'=v_row.payroll_id::text) THEN RAISE EXCEPTION 'Legacy source overlaps a paid allocation or differs' USING ERRCODE='40001'; END IF;
  SELECT x INTO v_site FROM jsonb_array_elements(v_source->'sites') x WHERE x->>'project_id'=p_project::text;
  IF v_site IS NULL THEN RAISE EXCEPTION 'Legacy site source unavailable' USING ERRCODE='40001'; END IF;
  v_legacy:=v_legacy||jsonb_build_array(jsonb_build_object('request_id',v_row.request_id,'payroll_id',v_row.payroll_id,'site_gross',v_site->>'corrected_gross','status',v_source->'original','corrected',v_source));
 END LOOP;
 v_result:=jsonb_build_object('project_id',p_project,'base',v_base,'legacy_vouchers',v_legacy);
 IF octet_length(v_result::text)>2097152 THEN RAISE EXCEPTION 'Legacy project inventory too large' USING ERRCODE='54000'; END IF;
 RETURN v_result;
END $$;
CREATE OR REPLACE FUNCTION public.project_cost_legacy_voucher_preview(p_project uuid,p_snapshot jsonb,p_choices jsonb,p_legacy_choices jsonb,p_ack boolean) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_now jsonb;v_base jsonb;v_item jsonb;v_choice jsonb;v_cases jsonb;v_ids jsonb;v_review jsonb;v_included numeric:=0;v_excluded numeric:=0;v_total numeric;v_count integer:=0;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance required' USING ERRCODE='42501'; END IF;
 IF p_project IS NULL OR p_ack IS DISTINCT FROM true OR jsonb_typeof(p_snapshot) IS DISTINCT FROM 'object' OR octet_length(p_snapshot::text)>2097152 OR jsonb_typeof(p_legacy_choices) IS DISTINCT FROM 'object' OR octet_length(p_legacy_choices::text)>500000 THEN RAISE EXCEPTION 'Invalid legacy cost review' USING ERRCODE='22023'; END IF;
 v_now:=public.project_cost_legacy_voucher_inventory(p_project);
 IF v_now #- '{base,historical_review,base,captured_at}' IS DISTINCT FROM p_snapshot #- '{base,historical_review,base,captured_at}' THEN RAISE EXCEPTION 'Project evidence changed; reload and review' USING ERRCODE='40001'; END IF;
 IF (SELECT count(*) FROM jsonb_object_keys(p_legacy_choices))<>jsonb_array_length(v_now->'legacy_vouchers') THEN RAISE EXCEPTION 'Review every legacy voucher' USING ERRCODE='22023'; END IF;
 FOR v_item IN SELECT value FROM jsonb_array_elements(v_now->'legacy_vouchers') LOOP
  v_choice:=p_legacy_choices->(v_item->>'request_id');v_cases:=v_item->'corrected'->'cases';
  IF jsonb_typeof(v_choice) IS DISTINCT FROM 'object' OR NOT(v_choice ?& ARRAY['decision','reason']) OR coalesce(v_choice->>'decision','') NOT IN ('include','exclude') OR (v_choice->>'decision'='include' AND v_choice->'reason' IS DISTINCT FROM 'null'::jsonb) OR (v_choice->>'decision'='exclude' AND (jsonb_typeof(v_choice->'reason') IS DISTINCT FROM 'string' OR length(btrim(v_choice->>'reason')) NOT BETWEEN 1 AND 300 OR btrim(v_choice->>'reason') IS DISTINCT FROM v_choice->>'reason' OR (v_choice->>'reason')~'[[:cntrl:]]')) THEN RAISE EXCEPTION 'Invalid legacy voucher decision' USING ERRCODE='22023'; END IF;
  IF v_choice->>'decision'='include' AND jsonb_array_length(v_cases)>1 THEN
   v_review:=v_choice->'case_review';SELECT jsonb_agg(c->>'case_id' ORDER BY c->>'case_id' COLLATE "C") INTO v_ids FROM jsonb_array_elements(v_cases) c;
   IF (SELECT count(*) FROM jsonb_object_keys(v_choice))<>3 OR jsonb_typeof(v_review) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(CASE WHEN jsonb_typeof(v_review)='object' THEN v_review ELSE '{}'::jsonb END))<>3 OR NOT(v_review ?& ARRAY['case_ids','note','non_overlapping']) OR v_review->'case_ids' IS DISTINCT FROM v_ids OR v_review->'non_overlapping' IS DISTINCT FROM 'true'::jsonb OR jsonb_typeof(v_review->'note') IS DISTINCT FROM 'string' OR length(btrim(v_review->>'note')) NOT BETWEEN 1 AND 300 OR btrim(v_review->>'note') IS DISTINCT FROM v_review->>'note' OR (v_review->>'note')~'[[:cntrl:]]' THEN RAISE EXCEPTION 'Distinct effects review required for every legacy case' USING ERRCODE='22023'; END IF;
  ELSIF (SELECT count(*) FROM jsonb_object_keys(v_choice))<>2 THEN RAISE EXCEPTION 'Unexpected legacy voucher decision fields' USING ERRCODE='22023'; END IF;
  -- The base inventory can also list these same corrections as incoming; they
  -- must be excluded there because the corrected source already contains them.
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_cases) c JOIN jsonb_array_elements(v_now->'base'->'corrections') b ON b->>'kind'='voucher' AND b->>'case_id'=c->>'case_id' WHERE p_choices->'corrections'->('voucher:'||(c->>'case_id'))->>'decision' IS DISTINCT FROM 'exclude') THEN RAISE EXCEPTION 'Legacy correction must not also be included in base' USING ERRCODE='22023'; END IF;
  IF v_choice->>'decision'='include' THEN v_included:=v_included+(v_item->>'site_gross')::numeric;ELSE v_excluded:=v_excluded+(v_item->>'site_gross')::numeric;v_count:=v_count+1;END IF;
 END LOOP;
 v_base:=public.project_cost_corrected_preview(p_project,v_now->'base',p_choices,true);
 v_total:=(v_base->>'incomplete_total')::numeric+v_included;
 IF v_total<0 OR v_total>=100000000000000 THEN RAISE EXCEPTION 'Invalid legacy cost total' USING ERRCODE='22023'; END IF;
 RETURN jsonb_build_object('project_id',p_project,'base',v_base,'legacy_included_gross',v_included::numeric(16,2)::text,'legacy_excluded_gross',v_excluded::numeric(16,2)::text,'legacy_excluded_count',v_count,'incomplete_total',v_total::numeric(16,2)::text,'incomplete',true);
END $$;


-- Source: project_cost_legacy_recorded_coverage.sql SHA256 da952f19aa83e65404b6e1e4451124d7d63f9e482ef59a75e0aa547ba1a7e7ef
-- HELD candidate: same-statement legacy-aware coverage plus ordinary and
-- legacy-inclusive reviews. Not completeness/payment proof; not a release.
-- Requires coordinated clients, correction handling and lock verification.
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
DO $preflight$ BEGIN
 IF to_regprocedure('public.project_cost_recorded_coverage(uuid)') IS NULL OR to_regprocedure('public.project_cost_legacy_review(uuid,integer)') IS NULL OR to_regprocedure('public.legacy_paid_voucher_attribution(uuid)') IS NULL OR to_regprocedure('public.project_cost_legacy_corrected_source(uuid)') IS NULL OR to_regclass('public.legacy_paid_voucher_attributions') IS NULL OR to_regclass('public.legacy_paid_voucher_attribution_sites') IS NULL OR to_regprocedure('public.project_cost_legacy_recorded_coverage(uuid)') IS NOT NULL THEN RAISE EXCEPTION 'Legacy coverage prerequisites missing or collision'; END IF;
END $preflight$;
CREATE FUNCTION public.project_cost_legacy_recorded_coverage(p_project uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_base jsonb;v_review jsonb;v_count bigint;v_bad bigint:=0;v_valid uuid[]:='{}'::uuid[];v_row record;v_status jsonb;v_unallocated bigint;v_attendance bigint;v_site bigint;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance required' USING ERRCODE='42501'; END IF;
 IF p_project IS NULL OR NOT EXISTS(SELECT 1 FROM public.projects WHERE id=p_project) THEN RAISE EXCEPTION 'Project unavailable' USING ERRCODE='42501'; END IF;
 v_base:=public.project_cost_recorded_coverage(p_project);
 SELECT count(*) INTO v_count FROM public.legacy_paid_voucher_attributions;
 IF v_count>1000 THEN RAISE EXCEPTION 'Too many legacy vouchers for coverage; separate reconciliation required' USING ERRCODE='54000'; END IF;
 -- A split suppresses the unallocated warning only if all source evidence
 -- remains valid. Any unverifiable row fails the entire reader closed.
 FOR v_row IN SELECT request_id,payroll_id FROM public.legacy_paid_voucher_attributions ORDER BY payroll_id LOOP
  v_status:=public.legacy_paid_voucher_attribution(v_row.payroll_id);
  IF v_status->'found' IS DISTINCT FROM 'true'::jsonb OR v_status->>'request_id' IS DISTINCT FROM v_row.request_id::text THEN RAISE EXCEPTION 'Legacy attribution status unavailable' USING ERRCODE='22023'; END IF;
  BEGIN
   PERFORM public.project_cost_legacy_corrected_source(v_row.payroll_id);
   v_valid:=array_append(v_valid,v_row.payroll_id);
  EXCEPTION WHEN data_exception OR integrity_constraint_violation OR SQLSTATE '40001' OR SQLSTATE '54000' THEN v_bad:=v_bad+1;
  END;
 END LOOP;
 SELECT count(*) FILTER (WHERE p.status='paid' AND p.gross_pay>0 AND NOT EXISTS(SELECT 1 FROM public.weekly_worker_paid_allocations a WHERE a.payroll_id=p.id) AND NOT(p.id=ANY(v_valid))),
  count(*) FILTER (WHERE p.status='paid' AND p.gross_pay>0 AND NOT EXISTS(SELECT 1 FROM public.weekly_worker_paid_allocations a WHERE a.payroll_id=p.id) AND NOT(p.id=ANY(v_valid)) AND EXISTS(SELECT 1 FROM public.attendance a WHERE a.project_id=p_project AND a.worker_id=p.worker_id AND a.date BETWEEN p.period_start AND p.period_end))
 INTO v_unallocated,v_attendance FROM public.payroll p;
 SELECT count(*) INTO v_site FROM public.legacy_paid_voucher_attributions a WHERE EXISTS(SELECT 1 FROM public.legacy_paid_voucher_attribution_sites s WHERE s.attribution_id=a.request_id AND s.project_id=p_project) OR EXISTS(SELECT 1 FROM public.paid_payroll_adjustment_cases c JOIN public.project_cost_correction_attributions ca ON ca.voucher_case_id=c.id AND ca.source_kind='voucher' JOIN public.project_cost_correction_sites cs ON cs.request_id=ca.request_id WHERE c.payroll_id=a.payroll_id AND cs.project_id=p_project AND ca.revision=(SELECT max(b.revision) FROM public.project_cost_correction_attributions b WHERE b.source_kind='voucher' AND b.voucher_case_id=c.id));
 v_review:=public.project_cost_legacy_review(p_project,NULL);
 RETURN jsonb_build_object('project_id',p_project,'captured_at',statement_timestamp(),'unallocated_paid',v_unallocated,'attendance_matches',v_attendance,'inconsistent_allocations',v_base->'inconsistent_allocations','unattributed_history',v_base->'unattributed_history','review',v_base->'review','legacy_site_attributions',v_site,'changed_legacy_attributions',v_bad,'legacy_review',v_review);
END $$;
REVOKE ALL ON FUNCTION public.project_cost_legacy_recorded_coverage(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.project_cost_legacy_recorded_coverage(uuid) TO authenticated;
DO $postflight$ BEGIN
 IF has_function_privilege('anon','public.project_cost_legacy_recorded_coverage(uuid)','EXECUTE') OR has_function_privilege('service_role','public.project_cost_legacy_recorded_coverage(uuid)','EXECUTE') OR NOT has_function_privilege('authenticated','public.project_cost_legacy_recorded_coverage(uuid)','EXECUTE') OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.project_cost_legacy_recorded_coverage(uuid)'::regprocedure AND prosecdef AND provolatile='s' AND proconfig @> ARRAY['search_path=""']) THEN RAISE EXCEPTION 'Unexpected legacy coverage privileges'; END IF;
END $postflight$;


-- Source: project_cost_legacy_recorded_snapshot.sql SHA256 2df7e87a4b52447c90e73c3370e3aeeeb8a8deca7bf133c5f509a57535796d08
-- HELD: one point-in-time snapshot for simple recorded costs when the
-- older-voucher feature is also enabled. The client must withhold the simple
-- amount if an older split or incoming legacy correction affects this site.
-- No financial records are changed. Install only as part of a coordinated
-- legacy cutover after verifying the exact target functions and permissions.
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
DO $preflight$ BEGIN
 IF to_regprocedure('public.project_cost_legacy_recorded_snapshot(uuid)') IS NOT NULL
 OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.project_cost_legacy_recorded_coverage(uuid)') AND md5(prosrc)='2bfdf3d979feebbdd4fd77a5d09e84c9' AND prosecdef AND provolatile='s')
 OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.project_recorded_cost_snapshot(uuid)') AND md5(prosrc)='a470f6a602c2327dd80ed477551dea7a' AND NOT prosecdef AND provolatile='s') THEN RAISE EXCEPTION 'Legacy recorded snapshot prerequisites differ or name collision'; END IF;
END $preflight$;
CREATE FUNCTION public.project_cost_legacy_recorded_snapshot(p_project uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path='' AS $$
 SELECT jsonb_build_object('project_id',p_project,'legacy',public.project_cost_legacy_recorded_coverage(p_project),'ordinary',public.project_recorded_cost_snapshot(p_project))
$$;
REVOKE ALL ON FUNCTION public.project_cost_legacy_recorded_snapshot(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.project_cost_legacy_recorded_snapshot(uuid) TO authenticated;
DO $postflight$ BEGIN
 IF has_function_privilege('anon','public.project_cost_legacy_recorded_snapshot(uuid)','EXECUTE') OR has_function_privilege('service_role','public.project_cost_legacy_recorded_snapshot(uuid)','EXECUTE') OR NOT has_function_privilege('authenticated','public.project_cost_legacy_recorded_snapshot(uuid)','EXECUTE') OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.project_cost_legacy_recorded_snapshot(uuid)'::regprocedure AND NOT prosecdef AND provolatile='s' AND proconfig @> ARRAY['search_path=""']) THEN RAISE EXCEPTION 'Unexpected legacy recorded snapshot privileges'; END IF;
END $postflight$;


-- Source: project_cost_legacy_cross_site_overview.sql SHA256 92030586234dabc7ea0f5d0b465cc824d50b14959ea519f84da8e1e045ae90e3
-- HELD until the entire legacy attribution and review cutover is coordinated.
-- Combine legacy coverage and ordinary cross-site evidence in one snapshot so
-- an older split added between browser requests cannot be silently omitted.
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
DO $preflight$ BEGIN
 IF to_regprocedure('public.project_cost_legacy_cross_site_overview(uuid)') IS NOT NULL OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.project_cost_legacy_recorded_coverage(uuid)') AND md5(prosrc)='2bfdf3d979feebbdd4fd77a5d09e84c9' AND prosecdef AND provolatile='s') OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.project_cost_cross_site_overview(uuid)') AND md5(prosrc)='400f4c80ce4a6e5208df64fa3740a46d' AND NOT prosecdef AND provolatile='s') THEN RAISE EXCEPTION 'Legacy cross-site overview prerequisites differ or name collision'; END IF;
END $preflight$;
CREATE FUNCTION public.project_cost_legacy_cross_site_overview(p_project uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path='' AS $$
 SELECT jsonb_build_object('project_id',p_project,'legacy',public.project_cost_legacy_recorded_coverage(p_project),'ordinary',public.project_cost_cross_site_overview(p_project))
$$;
REVOKE ALL ON FUNCTION public.project_cost_legacy_cross_site_overview(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.project_cost_legacy_cross_site_overview(uuid) TO authenticated;
DO $postflight$ BEGIN
 IF has_function_privilege('anon','public.project_cost_legacy_cross_site_overview(uuid)','EXECUTE') OR has_function_privilege('service_role','public.project_cost_legacy_cross_site_overview(uuid)','EXECUTE') OR NOT has_function_privilege('authenticated','public.project_cost_legacy_cross_site_overview(uuid)','EXECUTE') OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.project_cost_legacy_cross_site_overview(uuid)'::regprocedure AND NOT prosecdef AND provolatile='s' AND proconfig @> ARRAY['search_path=""']) THEN RAISE EXCEPTION 'Unexpected legacy cross-site overview privileges'; END IF;
END $postflight$;


-- Source: project_cost_legacy_old_client_guard.sql SHA256 841eadcd499323be666d19b76392ed9f18ae867cc1feb77600dbaf423d8788e9
-- HELD: synthetic rehearsal only. Old clients cannot account for older voucher
-- splits. After a split is recorded, their ordinary/cross-site saved amounts
-- must fail closed. Updated clients may inspect the guarded base only alongside
-- independently verified legacy coverage; this is not a payment or posting.
-- Coordinated installation, old-client compatibility and lock tests remain required.
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
DO $preflight$ BEGIN
 IF current_setting('app.legacy_old_client_guard_candidate',true) IS DISTINCT FROM 'synthetic-only' THEN RAISE EXCEPTION 'Held for synthetic rehearsal'; END IF;
 IF to_regclass('public.legacy_paid_voucher_attributions') IS NULL OR to_regclass('public.legacy_paid_voucher_attribution_sites') IS NULL OR to_regclass('public.project_cost_correction_attributions') IS NULL OR to_regclass('public.project_cost_correction_sites') IS NULL OR to_regclass('public.paid_payroll_adjustment_cases') IS NULL OR to_regprocedure('app_private.project_cost_corrected_review_before_legacy_guard(uuid,integer)') IS NOT NULL OR to_regprocedure('app_private.project_cost_cross_site_review_before_legacy_guard(uuid,integer)') IS NOT NULL OR to_regprocedure('app_private.project_cost_legacy_site_guard(uuid)') IS NOT NULL THEN RAISE EXCEPTION 'Legacy old-client guard prerequisites missing or collision'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.project_cost_corrected_review(uuid,integer)') AND md5(prosrc)='a5a2b78df46d98e5736b2cb0e97382ea' AND prosecdef AND provolatile='s') OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.project_cost_cross_site_review(uuid,integer)') AND md5(prosrc)='44a016ef665816798689061e9dbf2bb3' AND prosecdef AND provolatile='s') OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.project_cost_cross_site_review_context(uuid,text,uuid)') AND md5(prosrc) IN ('a6e51c1c3d2b39dfedc223f8f5b6d950','8653ebc231881861173d539bd9062c67') AND prosecdef AND provolatile='s') THEN RAISE EXCEPTION 'Unexpected saved-review readers'; END IF;
END $preflight$;
ALTER FUNCTION public.project_cost_corrected_review(uuid,integer) RENAME TO project_cost_corrected_review_before_legacy_guard;
ALTER FUNCTION public.project_cost_corrected_review_before_legacy_guard(uuid,integer) SET SCHEMA app_private;
ALTER FUNCTION public.project_cost_cross_site_review(uuid,integer) RENAME TO project_cost_cross_site_review_before_legacy_guard;
ALTER FUNCTION public.project_cost_cross_site_review_before_legacy_guard(uuid,integer) SET SCHEMA app_private;
REVOKE ALL ON FUNCTION app_private.project_cost_corrected_review_before_legacy_guard(uuid,integer),app_private.project_cost_cross_site_review_before_legacy_guard(uuid,integer) FROM PUBLIC,anon,authenticated,service_role;
-- Source-context verification checks the ordinary source evidence, not the
-- site's complete cost. Keep that internal check working without exposing the
-- unguarded reader as a public RPC. Reject any unfamiliar function definition.
DO $context$ DECLARE definition text;updated text;needle text:='public.project_cost_corrected_review((v_source_site->>''project_id'')::uuid,NULL)'; BEGIN
 SELECT pg_get_functiondef('public.project_cost_cross_site_review_context(uuid,text,uuid)'::regprocedure) INTO definition;
 updated:=replace(definition,needle,'app_private.project_cost_corrected_review_before_legacy_guard((v_source_site->>''project_id'')::uuid,NULL)');
 IF updated=definition OR (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'Unexpected source context definition'; END IF;
 EXECUTE updated;
END $context$;
CREATE FUNCTION app_private.project_cost_legacy_site_guard(p_project uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM public.legacy_paid_voucher_attributions a
  WHERE EXISTS(SELECT 1 FROM public.legacy_paid_voucher_attribution_sites s WHERE s.attribution_id=a.request_id AND s.project_id=p_project)
  OR EXISTS(SELECT 1 FROM public.paid_payroll_adjustment_cases c JOIN public.project_cost_correction_attributions ca ON ca.voucher_case_id=c.id AND ca.source_kind='voucher' JOIN public.project_cost_correction_sites cs ON cs.request_id=ca.request_id WHERE c.payroll_id=a.payroll_id AND cs.project_id=p_project AND ca.revision=(SELECT max(b.revision) FROM public.project_cost_correction_attributions b WHERE b.source_kind='voucher' AND b.voucher_case_id=c.id)))
$$;
REVOKE ALL ON FUNCTION app_private.project_cost_legacy_site_guard(uuid) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.project_cost_corrected_review(p_project uuid,p_revision integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v jsonb;
BEGIN
 v:=app_private.project_cost_corrected_review_before_legacy_guard(p_project,p_revision);
 IF v->'found'='true'::jsonb AND v->>'freshness'='matches' AND app_private.project_cost_legacy_site_guard(p_project) THEN
  v:=v||jsonb_build_object('freshness','changed','legacy_guarded',true);
 END IF;
 RETURN v;
END $$;
CREATE FUNCTION public.project_cost_cross_site_review(p_project uuid,p_revision integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v jsonb;
BEGIN
 v:=app_private.project_cost_cross_site_review_before_legacy_guard(p_project,p_revision);
 IF v->'found'='true'::jsonb AND v->>'freshness'='matches' AND app_private.project_cost_legacy_site_guard(p_project) THEN
  v:=v||jsonb_build_object('freshness','changed','legacy_guarded',true);
 END IF;
 RETURN v;
END $$;
REVOKE ALL ON FUNCTION public.project_cost_corrected_review(uuid,integer),public.project_cost_cross_site_review(uuid,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.project_cost_corrected_review(uuid,integer),public.project_cost_cross_site_review(uuid,integer) TO authenticated;
DO $postflight$ DECLARE r text; BEGIN
 FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF has_function_privilege(r,'app_private.project_cost_corrected_review_before_legacy_guard(uuid,integer)','EXECUTE') OR has_function_privilege(r,'app_private.project_cost_cross_site_review_before_legacy_guard(uuid,integer)','EXECUTE') OR has_function_privilege(r,'app_private.project_cost_legacy_site_guard(uuid)','EXECUTE') THEN RAISE EXCEPTION 'Unexpected private reader privilege'; END IF;
 END LOOP;
 IF has_function_privilege('anon','public.project_cost_corrected_review(uuid,integer)','EXECUTE') OR has_function_privilege('service_role','public.project_cost_corrected_review(uuid,integer)','EXECUTE') OR NOT has_function_privilege('authenticated','public.project_cost_corrected_review(uuid,integer)','EXECUTE') OR has_function_privilege('anon','public.project_cost_cross_site_review(uuid,integer)','EXECUTE') OR has_function_privilege('service_role','public.project_cost_cross_site_review(uuid,integer)','EXECUTE') OR NOT has_function_privilege('authenticated','public.project_cost_cross_site_review(uuid,integer)','EXECUTE') THEN RAISE EXCEPTION 'Unexpected guarded-reader privilege'; END IF;
END $postflight$;

-- Verify the replacement reader preserves the public API and private originals.
DO $final$ BEGIN
 IF to_regprocedure('public.project_cost_legacy_recorded_snapshot(uuid)') IS NULL OR to_regprocedure('public.project_cost_legacy_cross_site_overview(uuid)') IS NULL OR to_regprocedure('public.record_legacy_paid_voucher_attribution(uuid,uuid,jsonb,jsonb,jsonb,text,boolean,jsonb)') IS NULL OR has_function_privilege('authenticated','app_private.project_cost_corrected_review_before_legacy_guard(uuid,integer)','EXECUTE') OR has_function_privilege('authenticated','app_private.project_cost_cross_site_review_before_legacy_guard(uuid,integer)','EXECUTE') THEN RAISE EXCEPTION 'Legacy development postflight failed'; END IF;
END $final$;
