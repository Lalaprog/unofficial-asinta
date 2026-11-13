-- EXPERIMENTAL, UNINSTALLED, NOT A COMPLETE ROLLOUT. A Founder assertion that
-- a worker's weekly pay and any stated Bale deduction already happened outside
-- the app. This creates NO payroll voucher, advance, expense, payment, transfer,
-- project allocation or automatic reconciliation. It is NOT proof of payment.
-- The guard triggers affect legacy writers globally and require read committed;
-- load/deadlock review, identity reconciliation, correction design, old-client
-- cutover, hosted catalog checks and recovery are essential before any install.
-- Execute only as a single reviewed transaction on a disposable test database.
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
DO $preflight$
BEGIN
 IF to_regprocedure('auth.uid()') IS NULL OR to_regprocedure('public.is_founder()') IS NULL OR to_regprocedure('public.session_assurance_satisfied()') IS NULL
 OR to_regclass('public.users') IS NULL OR to_regclass('public.workers') IS NULL OR to_regclass('public.payroll') IS NULL OR to_regclass('public.advances') IS NULL THEN RAISE EXCEPTION 'Historical external payroll prerequisites missing'; END IF;
 IF to_regclass('public.historical_external_worker_payroll') IS NOT NULL OR to_regclass('public.historical_external_worker_events') IS NOT NULL
 OR to_regprocedure('public.record_historical_external_worker_payroll(uuid,uuid,date,date,numeric,numeric,numeric,numeric,text,jsonb,boolean)') IS NOT NULL THEN RAISE EXCEPTION 'Historical external payroll name collision'; END IF;
 -- No cross-ledger identity/lock coordination exists yet. Refuse both install
 -- orders rather than silently letting the two candidates claim the same pay.
 IF to_regclass('public.supervisor_period_payroll') IS NOT NULL THEN RAISE EXCEPTION 'Supervisor payroll ledger requires coordinated cross-ledger reconciliation'; END IF;
 IF EXISTS (SELECT 1 FROM pg_catalog.pg_class WHERE oid IN ('public.payroll'::regclass,'public.advances'::regclass) AND (relkind<>'r' OR NOT relrowsecurity)) THEN RAISE EXCEPTION 'Existing financial tables must have RLS'; END IF;
END;
$preflight$;

CREATE TABLE public.historical_external_worker_payroll (
 request_id uuid PRIMARY KEY,
 worker_id uuid NOT NULL REFERENCES public.workers(id) ON DELETE RESTRICT,
 period_start date NOT NULL,
 period_end date NOT NULL,
 paid_on date NOT NULL,
 gross numeric(10,2) NOT NULL CHECK(gross>=0),
 bale numeric(10,2) NOT NULL CHECK(bale>=0),
 other_deductions numeric(10,2) NOT NULL CHECK(other_deductions>=0),
 net numeric(10,2) NOT NULL CHECK(net>=0),
 evidence_note text NOT NULL CHECK(length(evidence_note) BETWEEN 1 AND 500),
 worker_snapshot jsonb NOT NULL,
 recorded_by uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(period_end=period_start+6 AND extract(dow FROM period_start)=0),
 CHECK(paid_on>=period_start), CHECK(gross-bale-other_deductions=net),
 UNIQUE(worker_id,period_start)
);
CREATE TABLE public.historical_external_worker_events (
 request_id uuid PRIMARY KEY REFERENCES public.historical_external_worker_payroll(request_id) ON DELETE RESTRICT,
 actor_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 action text NOT NULL CHECK(action='recorded'),
 after_row jsonb NOT NULL
);
ALTER TABLE public.historical_external_worker_payroll ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.historical_external_worker_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.historical_external_worker_payroll,public.historical_external_worker_events FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.guard_historical_external_worker_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN RAISE EXCEPTION 'Historical external evidence is immutable; investigate separately' USING ERRCODE='22023'; END;
$$;
REVOKE ALL ON FUNCTION public.guard_historical_external_worker_immutable() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER historical_external_worker_immutable BEFORE UPDATE OR DELETE ON public.historical_external_worker_payroll FOR EACH ROW EXECUTE FUNCTION public.guard_historical_external_worker_immutable();
CREATE TRIGGER historical_external_worker_event_immutable BEFORE UPDATE OR DELETE ON public.historical_external_worker_events FOR EACH ROW EXECUTE FUNCTION public.guard_historical_external_worker_immutable();

-- These guards also affect legacy clients; deny non-read-committed snapshots
-- rather than letting a waiting writer miss a just-committed assertion. The
-- recording path takes conflicting SHARE ROW EXCLUSIVE locks on these tables.
CREATE FUNCTION public.guard_historical_external_payroll_overlap() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Historical payroll guard requires read committed isolation' USING ERRCODE='P1002'; END IF;
 IF NEW.worker_id IS NULL OR NEW.period_start IS NULL OR NEW.period_end IS NULL OR NEW.period_end<NEW.period_start THEN RAISE EXCEPTION 'Invalid payroll period' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM public.historical_external_worker_payroll h WHERE h.worker_id=NEW.worker_id AND h.period_start<=NEW.period_end AND h.period_end>=NEW.period_start) THEN
  RAISE EXCEPTION 'Historical external payroll evidence overlaps this voucher; investigate the original period' USING ERRCODE='22023'; END IF;
 RETURN NEW;
END;
$$;
CREATE FUNCTION public.guard_historical_external_advance_overlap() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Historical advance guard requires read committed isolation' USING ERRCODE='P1002'; END IF;
 IF NEW.worker_id IS NULL OR NEW.date IS NULL THEN RAISE EXCEPTION 'Invalid advance identity or date' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM public.historical_external_worker_payroll h WHERE h.worker_id=NEW.worker_id AND (NEW.date BETWEEN h.period_start AND h.period_end OR (NEW.date<h.period_start AND NEW.status IN ('active','partially_deducted')))) THEN
  RAISE EXCEPTION 'Historical external payroll evidence conflicts with this Bale date or older open balance; investigate the original period' USING ERRCODE='22023'; END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_historical_external_payroll_overlap(),public.guard_historical_external_advance_overlap() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER guard_historical_external_payroll_overlap BEFORE INSERT OR UPDATE ON public.payroll FOR EACH ROW EXECUTE FUNCTION public.guard_historical_external_payroll_overlap();
CREATE TRIGGER guard_historical_external_advance_overlap BEFORE INSERT OR UPDATE ON public.advances FOR EACH ROW EXECUTE FUNCTION public.guard_historical_external_advance_overlap();

CREATE FUNCTION public.historical_external_worker_catalog() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_items jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 IF (SELECT count(*) FROM public.workers)>2000 THEN RAISE EXCEPTION 'Worker catalog exceeds historical-entry limit' USING ERRCODE='54000'; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name,'position',position,'active',active) ORDER BY name,id),'[]'::jsonb) INTO v_items FROM public.workers;
 RETURN jsonb_build_object('workers',v_items);
END;
$$;

CREATE FUNCTION public.historical_external_worker_review(p_worker uuid,p_start date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_worker jsonb; v_name text; v_position text; v_risk boolean;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 IF p_worker IS NULL OR p_start IS NULL OR NOT isfinite(p_start) OR p_start<DATE '1900-01-01' OR p_start>DATE '9998-12-24' OR extract(dow FROM p_start)<>0 THEN RAISE EXCEPTION 'Choose a worker and Sunday' USING ERRCODE='22023'; END IF;
 SELECT jsonb_build_object('id',id,'name',name,'position',position,'active',active),name,position INTO v_worker,v_name,v_position FROM public.workers WHERE id=p_worker;
 IF NOT FOUND THEN RAISE EXCEPTION 'Worker unavailable' USING ERRCODE='P0002'; END IF;
 SELECT strpos(lower(coalesce(v_position,'')),'supervisor')>0 OR EXISTS(SELECT 1 FROM public.users WHERE role='supervisor' AND (id=p_worker OR lower(btrim(name))=lower(btrim(v_name)))) INTO v_risk;
 RETURN jsonb_build_object('worker',v_worker,'start',p_start,'end',p_start+6,'as_of',(statement_timestamp() AT TIME ZONE 'Asia/Manila')::date,'possible_supervisor',v_risk,
  'possible_worker_duplicate',EXISTS(SELECT 1 FROM public.workers WHERE id<>p_worker AND lower(btrim(name))=lower(btrim(v_name))),
  'overlapping_vouchers',(SELECT count(*) FROM public.payroll WHERE worker_id=p_worker AND period_start<=p_start+6 AND period_end>=p_start),
  'period_advances',(SELECT count(*) FROM public.advances WHERE worker_id=p_worker AND date BETWEEN p_start AND p_start+6),
  'older_open_advances',(SELECT count(*) FROM public.advances WHERE worker_id=p_worker AND date<p_start AND status IN ('active','partially_deducted')),
  'existing_assertions',(SELECT count(*) FROM public.historical_external_worker_payroll WHERE worker_id=p_worker AND period_start<=p_start+6 AND period_end>=p_start));
END;
$$;

CREATE FUNCTION public.record_historical_external_worker_payroll(p_request uuid,p_worker uuid,p_start date,p_paid_on date,p_gross numeric,p_bale numeric,p_other numeric,p_net numeric,p_note text,p_expected_worker jsonb,p_ack boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_previous public.historical_external_worker_payroll%ROWTYPE; v_row public.historical_external_worker_payroll%ROWTYPE; v_review jsonb; v_note text; v_amount numeric;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Historical entry requires read committed isolation' USING ERRCODE='P1002'; END IF;
 IF p_request IS NULL OR p_worker IS NULL OR p_start IS NULL OR NOT isfinite(p_start) OR p_start<DATE '1900-01-01' OR p_start>DATE '9998-12-24' OR extract(dow FROM p_start)<>0
 OR p_paid_on IS NULL OR NOT isfinite(p_paid_on) OR p_paid_on<p_start OR p_paid_on>(statement_timestamp() AT TIME ZONE 'Asia/Manila')::date
 OR p_note IS NULL OR length(btrim(p_note)) NOT BETWEEN 1 AND 500 OR p_expected_worker IS NULL OR p_ack IS DISTINCT FROM true THEN RAISE EXCEPTION 'Invalid date, reviewed worker, note or confirmation' USING ERRCODE='22023'; END IF;
 FOREACH v_amount IN ARRAY ARRAY[p_gross,p_bale,p_other,p_net] LOOP
  IF v_amount IS NULL OR v_amount='NaN'::numeric OR v_amount<0 OR v_amount>=100000000 OR v_amount<>round(v_amount,2) THEN RAISE EXCEPTION 'Invalid monetary amount' USING ERRCODE='22023'; END IF;
 END LOOP;
 IF p_gross-p_bale-p_other<>p_net THEN RAISE EXCEPTION 'Amounts do not reconcile' USING ERRCODE='22023'; END IF;
 v_note:=btrim(p_note);PERFORM pg_catalog.set_config('lock_timeout','3s',true);
 LOCK TABLE public.users,public.workers,public.advances,public.payroll IN SHARE ROW EXCLUSIVE MODE;
 -- The role could have changed while waiting for the lock. Check it again under
 -- the lock before either recording or returning a successful retry.
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 SELECT * INTO v_previous FROM public.historical_external_worker_payroll WHERE request_id=p_request;
 IF FOUND THEN
  IF (v_previous.worker_id,v_previous.period_start,v_previous.paid_on,v_previous.gross,v_previous.bale,v_previous.other_deductions,v_previous.net,v_previous.evidence_note,v_previous.worker_snapshot,v_previous.recorded_by)
   IS DISTINCT FROM (p_worker,p_start,p_paid_on,p_gross,p_bale,p_other,p_net,v_note,p_expected_worker,auth.uid()) THEN RAISE EXCEPTION 'Request ID used for different evidence' USING ERRCODE='22023'; END IF;
  RETURN jsonb_build_object('request_id',p_request,'replayed',true);
 END IF;
 v_review:=public.historical_external_worker_review(p_worker,p_start);
 IF v_review->'worker' IS DISTINCT FROM p_expected_worker THEN RAISE EXCEPTION 'Worker changed; review again' USING ERRCODE='40001'; END IF;
 IF coalesce((v_review->>'possible_supervisor')::boolean,true) OR coalesce((v_review->>'possible_worker_duplicate')::boolean,true) THEN RAISE EXCEPTION 'Possible Supervisor or duplicate worker identity requires separate review' USING ERRCODE='22023'; END IF;
 IF (v_review->>'overlapping_vouchers')::bigint>0 OR (v_review->>'period_advances')::bigint>0 OR (v_review->>'older_open_advances')::bigint>0 OR (v_review->>'existing_assertions')::bigint>0 THEN
  RAISE EXCEPTION 'Existing voucher, Bale or historical evidence requires separate reconciliation' USING ERRCODE='22023'; END IF;
 INSERT INTO public.historical_external_worker_payroll(request_id,worker_id,period_start,period_end,paid_on,gross,bale,other_deductions,net,evidence_note,worker_snapshot,recorded_by)
 VALUES(p_request,p_worker,p_start,p_start+6,p_paid_on,p_gross,p_bale,p_other,p_net,v_note,p_expected_worker,auth.uid()) RETURNING * INTO v_row;
 INSERT INTO public.historical_external_worker_events(request_id,actor_id,action,after_row) VALUES(p_request,auth.uid(),'recorded',to_jsonb(v_row));
 RETURN jsonb_build_object('request_id',p_request,'replayed',false);
END;
$$;

-- Founder-only bounded read; no direct table privileges are granted.
CREATE FUNCTION public.historical_external_worker_list(p_worker uuid,p_offset integer DEFAULT 0) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_total bigint; v_items jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 IF p_worker IS NULL OR p_offset IS NULL OR p_offset<0 OR p_offset>1000000 THEN RAISE EXCEPTION 'Invalid history request' USING ERRCODE='22023'; END IF;
 SELECT count(*) INTO v_total FROM public.historical_external_worker_payroll WHERE worker_id=p_worker;
 SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.period_start DESC,x.request_id),'[]'::jsonb) INTO v_items FROM (
  SELECT request_id,worker_id,period_start,period_end,paid_on,gross::text,bale::text,other_deductions::text,net::text,evidence_note,worker_snapshot,recorded_by,recorded_at
  FROM public.historical_external_worker_payroll WHERE worker_id=p_worker ORDER BY period_start DESC,request_id LIMIT 100 OFFSET p_offset
 ) x;
 RETURN jsonb_build_object('total',v_total,'offset',p_offset,'items',v_items);
END;
$$;
CREATE FUNCTION public.historical_external_worker_lookup(p_request uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_row jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 IF p_request IS NULL THEN RAISE EXCEPTION 'Invalid request' USING ERRCODE='22023'; END IF;
 SELECT to_jsonb(x) INTO v_row FROM (SELECT request_id,worker_id,period_start,period_end,paid_on,gross::text,bale::text,other_deductions::text,net::text,evidence_note,worker_snapshot,recorded_by,recorded_at FROM public.historical_external_worker_payroll WHERE request_id=p_request) x;
 RETURN v_row;
END;
$$;
REVOKE ALL ON FUNCTION public.historical_external_worker_catalog(),public.historical_external_worker_review(uuid,date),public.record_historical_external_worker_payroll(uuid,uuid,date,date,numeric,numeric,numeric,numeric,text,jsonb,boolean),public.historical_external_worker_list(uuid,integer),public.historical_external_worker_lookup(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.historical_external_worker_catalog(),public.historical_external_worker_review(uuid,date),public.record_historical_external_worker_payroll(uuid,uuid,date,date,numeric,numeric,numeric,numeric,text,jsonb,boolean),public.historical_external_worker_list(uuid,integer),public.historical_external_worker_lookup(uuid) TO authenticated;
DO $postflight$
DECLARE v text;
BEGIN
 FOREACH v IN ARRAY ARRAY['public.historical_external_worker_payroll','public.historical_external_worker_events'] LOOP
  IF EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r WHERE has_table_privilege(r,v,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
   OR EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a CROSS JOIN unnest(ARRAY['anon','authenticated','service_role']) r WHERE a.attrelid=to_regclass(v) AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege(r,a.attrelid,a.attname,'SELECT,INSERT,UPDATE,REFERENCES')) THEN RAISE EXCEPTION 'Unexpected external history table privileges'; END IF;
 END LOOP;
 FOREACH v IN ARRAY ARRAY['public.historical_external_worker_catalog()','public.historical_external_worker_review(uuid,date)','public.record_historical_external_worker_payroll(uuid,uuid,date,date,numeric,numeric,numeric,numeric,text,jsonb,boolean)','public.historical_external_worker_list(uuid,integer)','public.historical_external_worker_lookup(uuid)'] LOOP
  IF has_function_privilege('anon',v,'EXECUTE') OR has_function_privilege('service_role',v,'EXECUTE') OR NOT has_function_privilege('authenticated',v,'EXECUTE') THEN RAISE EXCEPTION 'Unexpected external history RPC privileges'; END IF;
 END LOOP;
END;
$postflight$;
