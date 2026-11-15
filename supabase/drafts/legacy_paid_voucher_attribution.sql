-- HELD CANDIDATE: Founder-reviewed site attribution of an existing legacy paid
-- worker voucher. Creates attribution evidence only: no payment, payroll edit,
-- expense, Bale or accounting posting. Not wired into project-cost reviews.
-- Requires a coordinated reader/correction/coverage cutover and concurrency
-- review before installation; do not execute on a shared or hosted database.
-- KNOWN HOLD: read freshness after lock waits, concurrent correction/weekly/
-- historical writers and review lock ordering have not been proven on PG17.
-- Later-created overlaps/corrections invalidate the evidence; no correction
-- path or atomic invalidation of a saved project review is implemented here.
-- Supervisor historical-name matching and existing expense/Bale overlaps also
-- need integration before any project total can use these rows.
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
DO $preflight$ BEGIN
 IF to_regclass('public.users') IS NULL OR to_regclass('public.workers') IS NULL OR to_regclass('public.projects') IS NULL
 OR to_regclass('public.payroll') IS NULL OR to_regclass('public.advances') IS NULL
 OR to_regclass('public.weekly_worker_draft_sources') IS NULL OR to_regclass('public.weekly_worker_paid_allocations') IS NULL
 OR to_regclass('public.historical_external_worker_payroll') IS NULL OR to_regclass('public.paid_payroll_adjustment_cases') IS NULL
 OR to_regprocedure('app_private.paid_adjustment_voucher_snapshot(public.payroll)') IS NULL
 OR to_regprocedure('auth.uid()') IS NULL OR to_regprocedure('public.is_founder()') IS NULL OR to_regprocedure('public.session_assurance_satisfied()') IS NULL THEN RAISE EXCEPTION 'Legacy attribution prerequisites missing'; END IF;
 IF to_regclass('public.legacy_paid_voucher_attributions') IS NOT NULL OR to_regclass('public.legacy_paid_voucher_attribution_sites') IS NOT NULL OR to_regprocedure('public.legacy_paid_voucher_attribution(uuid)') IS NOT NULL OR to_regprocedure('public.record_legacy_paid_voucher_attribution(uuid,uuid,jsonb,jsonb,text,boolean)') IS NOT NULL THEN RAISE EXCEPTION 'Legacy attribution objects already exist'; END IF;
END $preflight$;
CREATE TABLE public.legacy_paid_voucher_attributions (
 request_id uuid PRIMARY KEY,
 payroll_id uuid NOT NULL UNIQUE REFERENCES public.payroll(id) ON DELETE RESTRICT,
 voucher_snapshot jsonb NOT NULL CHECK(jsonb_typeof(voucher_snapshot)='object' AND octet_length(voucher_snapshot::text)<=65536),
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
DECLARE v_pay public.payroll%ROWTYPE;v_worker public.workers%ROWTYPE;v_saved public.legacy_paid_voucher_attributions%ROWTYPE;v_snapshot jsonb;v_split jsonb;v_cases bigint;v_risks jsonb:='[]'::jsonb;v_source_changed boolean;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance required' USING ERRCODE='42501'; END IF;
 SELECT * INTO v_pay FROM public.payroll WHERE id=p_payroll;
 IF NOT FOUND THEN RAISE EXCEPTION 'Voucher unavailable' USING ERRCODE='P0002'; END IF;
 SELECT * INTO v_worker FROM public.workers WHERE id=v_pay.worker_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Worker unavailable' USING ERRCODE='P0002'; END IF;
 v_snapshot:=app_private.paid_adjustment_voucher_snapshot(v_pay);
 SELECT count(*) INTO v_cases FROM public.paid_payroll_adjustment_cases WHERE payroll_id=p_payroll;
 IF v_pay.status IS DISTINCT FROM 'paid' THEN v_risks:=v_risks||jsonb_build_array('not_paid'); END IF;
 IF v_pay.gross_pay IS NULL OR v_pay.gross_pay='NaN'::numeric OR v_pay.gross_pay<=0 OR v_pay.gross_pay>=100000000 OR v_pay.gross_pay<>round(v_pay.gross_pay,2) OR v_pay.bale_deduction IS NULL OR v_pay.other_deductions IS NULL OR v_pay.net_pay IS NULL OR v_pay.bale_deduction='NaN'::numeric OR v_pay.other_deductions='NaN'::numeric OR v_pay.net_pay='NaN'::numeric OR v_pay.bale_deduction<0 OR v_pay.other_deductions<0 OR v_pay.net_pay<0 OR v_pay.bale_deduction<>round(v_pay.bale_deduction,2) OR v_pay.other_deductions<>round(v_pay.other_deductions,2) OR v_pay.net_pay<>round(v_pay.net_pay,2) OR v_pay.gross_pay-v_pay.bale_deduction-v_pay.other_deductions IS DISTINCT FROM v_pay.net_pay THEN v_risks:=v_risks||jsonb_build_array('invalid_amounts'); END IF;
 IF v_pay.period_start IS NULL OR v_pay.period_end IS NULL OR NOT isfinite(v_pay.period_start) OR NOT isfinite(v_pay.period_end) OR v_pay.period_start>v_pay.period_end THEN v_risks:=v_risks||jsonb_build_array('invalid_period'); END IF;
 IF EXISTS(SELECT 1 FROM public.weekly_worker_draft_sources WHERE payroll_id=p_payroll) OR EXISTS(SELECT 1 FROM public.weekly_worker_paid_allocations WHERE payroll_id=p_payroll) THEN v_risks:=v_risks||jsonb_build_array('generated_or_allocated'); END IF;
 IF strpos(lower(coalesce(v_worker.position,'')),'supervisor')>0 OR EXISTS(SELECT 1 FROM public.users u WHERE u.role IN ('supervisor','founder') AND (u.id=v_worker.id OR lower(btrim(u.name))=lower(btrim(v_worker.name)))) THEN v_risks:=v_risks||jsonb_build_array('possible_supervisor'); END IF;
 IF EXISTS(SELECT 1 FROM public.workers w WHERE w.id<>v_worker.id AND lower(btrim(w.name))=lower(btrim(v_worker.name))) THEN v_risks:=v_risks||jsonb_build_array('possible_duplicate_worker'); END IF;
 IF EXISTS(SELECT 1 FROM public.payroll p WHERE p.id<>p_payroll AND p.worker_id=v_pay.worker_id AND p.period_start<=v_pay.period_end AND p.period_end>=v_pay.period_start) OR EXISTS(SELECT 1 FROM public.historical_external_worker_payroll h WHERE h.worker_id=v_pay.worker_id AND h.period_start<=v_pay.period_end AND h.period_end>=v_pay.period_start) THEN v_risks:=v_risks||jsonb_build_array('overlapping_payroll'); END IF;
 IF v_cases>0 THEN v_risks:=v_risks||jsonb_build_array('correction_cases'); END IF;
 SELECT * INTO v_saved FROM public.legacy_paid_voucher_attributions WHERE payroll_id=p_payroll;
 IF NOT FOUND THEN RETURN jsonb_build_object('payroll_id',p_payroll,'worker_name',v_worker.name,'voucher',v_snapshot,'eligible',jsonb_array_length(v_risks)=0,'risks',v_risks,'found',false); END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('project_id',s.project_id,'gross',s.gross::text) ORDER BY s.project_id),'[]'::jsonb) INTO v_split FROM public.legacy_paid_voucher_attribution_sites s WHERE s.attribution_id=v_saved.request_id;
 IF v_split IS DISTINCT FROM v_saved.split OR (SELECT coalesce(sum(gross),0) FROM public.legacy_paid_voucher_attribution_sites WHERE attribution_id=v_saved.request_id) IS DISTINCT FROM (v_saved.voucher_snapshot->>'gross_pay')::numeric THEN RAISE EXCEPTION 'Saved attribution split differs; investigate' USING ERRCODE='22023'; END IF;
 v_source_changed:=v_snapshot IS DISTINCT FROM v_saved.voucher_snapshot OR jsonb_array_length(v_risks)>0;
 RETURN jsonb_build_object('payroll_id',p_payroll,'worker_name',v_worker.name,'voucher',v_snapshot,'eligible',false,'risks',v_risks,'found',true,'request_id',v_saved.request_id,'snapshot',v_saved.voucher_snapshot,'split',v_saved.split,'note',v_saved.note,'actor_id',v_saved.actor_id,'recorded_at',v_saved.recorded_at,'source_changed',v_source_changed,'case_count',v_cases);
END $$;

CREATE FUNCTION public.record_legacy_paid_voucher_attribution(p_request uuid,p_payroll uuid,p_expected jsonb,p_split jsonb,p_note text,p_ack boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_item jsonb;v_split jsonb:='[]'::jsonb;v_seen uuid[]:='{}';v_project uuid;v_amount numeric;v_sum numeric:=0;v_note text;v_current jsonb;v_saved public.legacy_paid_voucher_attributions%ROWTYPE;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance required' USING ERRCODE='42501'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Legacy attribution requires read committed isolation' USING ERRCODE='P1002'; END IF;
 IF p_request IS NULL OR p_payroll IS NULL OR jsonb_typeof(p_expected) IS DISTINCT FROM 'object' OR octet_length(p_expected::text)>65536 OR jsonb_typeof(p_split) IS DISTINCT FROM 'array' OR jsonb_array_length(p_split) NOT BETWEEN 1 AND 50 OR p_note IS NULL OR length(btrim(p_note)) NOT BETWEEN 1 AND 500 OR btrim(p_note)~'[[:cntrl:]]' OR p_ack IS DISTINCT FROM true THEN RAISE EXCEPTION 'Invalid reviewed voucher attribution' USING ERRCODE='22023'; END IF;
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
 -- Both adjustment paths lock worker then voucher. Subsequent cases are
 -- signalled as changed; this evidence does not freeze or settle them.
 PERFORM 1 FROM public.workers WHERE id=(SELECT worker_id FROM public.payroll WHERE id=p_payroll) FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Worker unavailable' USING ERRCODE='P0002'; END IF;
 PERFORM 1 FROM public.payroll WHERE id=p_payroll FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Voucher unavailable' USING ERRCODE='P0002'; END IF;
 v_current:=public.legacy_paid_voucher_attribution(p_payroll);
 SELECT * INTO v_saved FROM public.legacy_paid_voucher_attributions WHERE request_id=p_request;
 IF FOUND THEN
  IF (v_saved.payroll_id,v_saved.voucher_snapshot,v_saved.split,v_saved.note,v_saved.actor_id) IS DISTINCT FROM (p_payroll,p_expected,v_split,v_note,auth.uid()) OR coalesce((v_current->>'source_changed')::boolean,true) THEN RAISE EXCEPTION 'Retry differs or source evidence changed' USING ERRCODE='22023'; END IF;
  RETURN jsonb_build_object('request_id',p_request,'payroll_id',p_payroll,'replayed',true);
 END IF;
 IF v_current->'voucher' IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'Voucher changed; reload' USING ERRCODE='40001'; END IF;
 IF coalesce((v_current->>'found')::boolean,true) OR NOT coalesce((v_current->>'eligible')::boolean,false) THEN RAISE EXCEPTION 'Voucher requires separate reconciliation' USING ERRCODE='22023'; END IF;
 IF v_sum IS DISTINCT FROM (p_expected->>'gross_pay')::numeric OR (SELECT count(*) FROM public.projects WHERE id=ANY(v_seen))<>cardinality(v_seen) THEN RAISE EXCEPTION 'Site split must equal voucher gross and name existing projects' USING ERRCODE='22023'; END IF;
 INSERT INTO public.legacy_paid_voucher_attributions(request_id,payroll_id,voucher_snapshot,split,note,actor_id) VALUES(p_request,p_payroll,p_expected,v_split,v_note,auth.uid());
 INSERT INTO public.legacy_paid_voucher_attribution_sites(attribution_id,project_id,gross) SELECT p_request,(value->>'project_id')::uuid,(value->>'gross')::numeric FROM jsonb_array_elements(v_split);
 RETURN jsonb_build_object('request_id',p_request,'payroll_id',p_payroll,'replayed',false);
END $$;
REVOKE ALL ON FUNCTION public.legacy_paid_voucher_attribution(uuid),public.record_legacy_paid_voucher_attribution(uuid,uuid,jsonb,jsonb,text,boolean) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.legacy_paid_voucher_attribution(uuid),public.record_legacy_paid_voucher_attribution(uuid,uuid,jsonb,jsonb,text,boolean) TO authenticated;
DO $postflight$ DECLARE r text;t regclass; BEGIN
 FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  FOREACH t IN ARRAY ARRAY['public.legacy_paid_voucher_attributions'::regclass,'public.legacy_paid_voucher_attribution_sites'::regclass] LOOP
   IF has_table_privilege(r,t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=t AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege(r,t,a.attname,'SELECT,INSERT,UPDATE,REFERENCES')) THEN RAISE EXCEPTION 'Unexpected legacy attribution table privilege'; END IF;
  END LOOP;
  IF has_function_privilege(r,'app_private.guard_legacy_voucher_attribution_immutable()','EXECUTE') THEN RAISE EXCEPTION 'Unexpected legacy guard execute'; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['anon','service_role']) roles(r) WHERE has_function_privilege(roles.r,'public.legacy_paid_voucher_attribution(uuid)','EXECUTE') OR has_function_privilege(roles.r,'public.record_legacy_paid_voucher_attribution(uuid,uuid,jsonb,jsonb,text,boolean)','EXECUTE')) OR NOT has_function_privilege('authenticated','public.legacy_paid_voucher_attribution(uuid)','EXECUTE') OR NOT has_function_privilege('authenticated','public.record_legacy_paid_voucher_attribution(uuid,uuid,jsonb,jsonb,text,boolean)','EXECUTE') THEN RAISE EXCEPTION 'Unexpected legacy attribution execute'; END IF;
END $postflight$;
