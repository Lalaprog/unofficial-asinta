-- EXPERIMENTAL, UNINSTALLED. Separate review cases against a paid Supervisor
-- ledger or an externally paid worker assertion. No original row, advance,
-- payment, expense, allocation or future period is changed. A resolution is a
-- human assertion, not a transfer or proof. No partial settlement, void, source
-- identity repair or accounting posting. Apply only to a disposable test DB.
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
DO $preflight$
BEGIN
 IF to_regclass('public.supervisor_period_payroll') IS NULL OR to_regclass('public.historical_external_worker_payroll') IS NULL OR to_regprocedure('public.is_founder()') IS NULL OR to_regprocedure('public.session_assurance_satisfied()') IS NULL OR to_regprocedure('auth.uid()') IS NULL THEN RAISE EXCEPTION 'Paid period case prerequisites missing'; END IF;
 IF to_regclass('public.paid_period_assertion_cases') IS NOT NULL OR to_regclass('public.paid_period_assertion_case_events') IS NOT NULL OR to_regprocedure('public.open_paid_period_assertion_case(uuid,text,uuid,jsonb,numeric,text)') IS NOT NULL THEN RAISE EXCEPTION 'Paid period case name collision'; END IF;
END;
$preflight$;
CREATE TABLE public.paid_period_assertion_cases (
 id uuid PRIMARY KEY,
 source_kind text NOT NULL CHECK(source_kind IN ('supervisor','external_worker')),
 supervisor_payroll_id uuid REFERENCES public.supervisor_period_payroll(id) ON DELETE RESTRICT,
 external_worker_id uuid REFERENCES public.historical_external_worker_payroll(request_id) ON DELETE RESTRICT,
 original_snapshot jsonb NOT NULL,
 difference numeric(12,2) NOT NULL CHECK(difference<>0),
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 500),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','settled_external','no_transfer')),
 created_by uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 resolved_by uuid REFERENCES public.users(id) ON DELETE RESTRICT,
 resolved_at timestamptz,
 settled_on date,
 resolution_note text,
 CHECK((source_kind='supervisor' AND supervisor_payroll_id IS NOT NULL AND external_worker_id IS NULL) OR (source_kind='external_worker' AND supervisor_payroll_id IS NULL AND external_worker_id IS NOT NULL)),
 CHECK((status='pending' AND resolved_by IS NULL AND resolved_at IS NULL AND settled_on IS NULL AND resolution_note IS NULL)
 OR (status='settled_external' AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL AND settled_on IS NOT NULL AND resolution_note IS NOT NULL AND length(resolution_note) BETWEEN 1 AND 500)
 OR (status='no_transfer' AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL AND settled_on IS NULL AND resolution_note IS NOT NULL AND length(resolution_note) BETWEEN 1 AND 500))
);
CREATE UNIQUE INDEX paid_period_case_supervisor_pending ON public.paid_period_assertion_cases(supervisor_payroll_id) WHERE status='pending' AND supervisor_payroll_id IS NOT NULL;
CREATE UNIQUE INDEX paid_period_case_external_pending ON public.paid_period_assertion_cases(external_worker_id) WHERE status='pending' AND external_worker_id IS NOT NULL;
CREATE TABLE public.paid_period_assertion_case_events (
 case_id uuid NOT NULL REFERENCES public.paid_period_assertion_cases(id) ON DELETE RESTRICT,
 kind text NOT NULL CHECK(kind IN ('opened','resolved')),
 actor_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 before_row jsonb,
 after_row jsonb NOT NULL,
 PRIMARY KEY(case_id,kind),
 CHECK((kind='opened' AND before_row IS NULL) OR (kind='resolved' AND before_row IS NOT NULL))
);
ALTER TABLE public.paid_period_assertion_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.paid_period_assertion_case_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.paid_period_assertion_cases,public.paid_period_assertion_case_events FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.guard_paid_period_assertion_case_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF TG_TABLE_NAME='paid_period_assertion_case_events' OR TG_OP='DELETE' THEN RAISE EXCEPTION 'Paid period case history is immutable' USING ERRCODE='22023'; END IF;
 IF OLD.status<>'pending' OR NEW.status NOT IN ('settled_external','no_transfer') OR (to_jsonb(NEW)-ARRAY['status','resolved_by','resolved_at','settled_on','resolution_note']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','resolved_by','resolved_at','settled_on','resolution_note']) OR auth.uid() IS NULL OR NEW.resolved_by IS DISTINCT FROM auth.uid() OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Only a controlled final case decision is allowed' USING ERRCODE='22023'; END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_paid_period_assertion_case_immutable() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER paid_period_case_immutable BEFORE UPDATE OR DELETE ON public.paid_period_assertion_cases FOR EACH ROW EXECUTE FUNCTION public.guard_paid_period_assertion_case_immutable();
CREATE TRIGGER paid_period_event_immutable BEFORE UPDATE OR DELETE ON public.paid_period_assertion_case_events FOR EACH ROW EXECUTE FUNCTION public.guard_paid_period_assertion_case_immutable();

-- Compact, exact, textual money snapshot. Source rows are human assertions;
-- status paid here does not prove cash moved or that the source is correct.
CREATE FUNCTION public.paid_period_assertion_snapshot(p_kind text,p_source uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v jsonb;
BEGIN
 IF p_kind='supervisor' THEN
  SELECT jsonb_build_object('kind','supervisor','id',id,'person_id',supervisor_id,'name',supervisor_name,'start',period_start,'end',period_end,'paid_on',paid_on,'gross',gross::text,'net',gross::text,'status',status,'details',jsonb_build_object('daily_rate',daily_rate::text,'half_day_units',half_day_units,'source_fingerprint',pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object('source_snapshot',source_snapshot,'unmarked_dates',unmarked_dates)::text,'UTF8')),'hex'),'created_by',created_by,'created_at',created_at,'approved_by',approved_by,'approved_at',approved_at,'paid_by',paid_by,'recorded_paid_at',recorded_paid_at)) INTO v FROM public.supervisor_period_payroll WHERE id=p_source AND status='paid';
 ELSIF p_kind='external_worker' THEN
  SELECT jsonb_build_object('kind','external_worker','id',request_id,'person_id',worker_id,'name',worker_snapshot->>'name','start',period_start,'end',period_end,'paid_on',paid_on,'gross',gross::text,'net',net::text,'status','paid_assertion','details',jsonb_build_object('bale',bale::text,'other_deductions',other_deductions::text,'worker_snapshot',worker_snapshot,'evidence_note',evidence_note,'recorded_by',recorded_by,'recorded_at',recorded_at)) INTO v FROM public.historical_external_worker_payroll WHERE request_id=p_source;
 ELSE RAISE EXCEPTION 'Invalid paid period source' USING ERRCODE='22023'; END IF;
 IF v IS NULL THEN RAISE EXCEPTION 'Paid period source unavailable' USING ERRCODE='P0002'; END IF;
 RETURN v;
END;
$$;
REVOKE ALL ON FUNCTION public.paid_period_assertion_snapshot(text,uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.open_paid_period_assertion_case(p_id uuid,p_kind text,p_source uuid,p_expected jsonb,p_difference numeric,p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_snapshot jsonb;v_prev public.paid_period_assertion_cases%ROWTYPE;v_reason text;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Paid period case requires read committed isolation' USING ERRCODE='P1002'; END IF;
 IF p_id IS NULL OR p_source IS NULL OR p_kind IS NULL OR p_kind NOT IN ('supervisor','external_worker') OR p_expected IS NULL OR p_difference IS NULL OR p_difference='NaN'::numeric OR p_difference=0 OR abs(p_difference)>=10000000000 OR p_difference<>round(p_difference,2) OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'Invalid original period, difference or reason' USING ERRCODE='22023'; END IF;
 v_reason:=btrim(p_reason);PERFORM pg_catalog.set_config('lock_timeout','3s',true);
 -- Shared global first locks serialize these cases with both source writers.
 LOCK TABLE public.users,public.workers,public.supervisor_period_payroll,public.historical_external_worker_payroll,public.paid_period_assertion_cases,public.paid_period_assertion_case_events IN SHARE ROW EXCLUSIVE MODE;
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 SELECT * INTO v_prev FROM public.paid_period_assertion_cases WHERE id=p_id;
 IF FOUND THEN
  IF (v_prev.source_kind,coalesce(v_prev.supervisor_payroll_id,v_prev.external_worker_id),v_prev.original_snapshot,v_prev.difference,v_prev.reason,v_prev.created_by) IS DISTINCT FROM (p_kind,p_source,p_expected,p_difference,v_reason,auth.uid()) THEN RAISE EXCEPTION 'Case ID already used for different details' USING ERRCODE='22023'; END IF;
  RETURN jsonb_build_object('id',p_id,'status',v_prev.status,'replayed',true);
 END IF;
 v_snapshot:=public.paid_period_assertion_snapshot(p_kind,p_source);
 IF v_snapshot IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'Original period changed; review again' USING ERRCODE='40001'; END IF;
 IF EXISTS(SELECT 1 FROM public.paid_period_assertion_cases WHERE source_kind=p_kind AND coalesce(supervisor_payroll_id,external_worker_id)=p_source AND original_snapshot IS DISTINCT FROM v_snapshot) THEN RAISE EXCEPTION 'Prior case has a different original period; investigate' USING ERRCODE='40001'; END IF;
 IF (SELECT count(*) FROM public.paid_period_assertion_cases WHERE source_kind=p_kind AND coalesce(supervisor_payroll_id,external_worker_id)=p_source)>=100 THEN RAISE EXCEPTION 'Case history limit reached; separate reconciliation required' USING ERRCODE='54000'; END IF;
 IF EXISTS(SELECT 1 FROM public.paid_period_assertion_cases WHERE source_kind=p_kind AND coalesce(supervisor_payroll_id,external_worker_id)=p_source AND status='pending') THEN RAISE EXCEPTION 'An open case already exists for this period' USING ERRCODE='22023'; END IF;
 INSERT INTO public.paid_period_assertion_cases(id,source_kind,supervisor_payroll_id,external_worker_id,original_snapshot,difference,reason,created_by)
 VALUES(p_id,p_kind,CASE WHEN p_kind='supervisor' THEN p_source END,CASE WHEN p_kind='external_worker' THEN p_source END,v_snapshot,p_difference,v_reason,auth.uid()) RETURNING * INTO v_prev;
 INSERT INTO public.paid_period_assertion_case_events(case_id,kind,actor_id,after_row) VALUES(p_id,'opened',auth.uid(),to_jsonb(v_prev));
 RETURN jsonb_build_object('id',p_id,'status','pending','replayed',false);
END;
$$;

CREATE FUNCTION public.resolve_paid_period_assertion_case(p_id uuid,p_resolution text,p_settled_on date,p_note text,p_ack boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_case public.paid_period_assertion_cases%ROWTYPE;v_before jsonb;v_source uuid;v_note text;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Paid period case requires read committed isolation' USING ERRCODE='P1002'; END IF;
 IF p_id IS NULL OR p_resolution IS NULL OR p_resolution NOT IN ('settled_external','no_transfer') OR p_note IS NULL OR length(btrim(p_note)) NOT BETWEEN 1 AND 500 OR p_ack IS DISTINCT FROM true OR (p_resolution='no_transfer' AND p_settled_on IS NOT NULL) OR (p_resolution='settled_external' AND (p_settled_on IS NULL OR NOT isfinite(p_settled_on) OR p_settled_on<DATE '1900-01-01' OR p_settled_on>(clock_timestamp() AT TIME ZONE 'Asia/Manila')::date)) THEN RAISE EXCEPTION 'Invalid resolution, date or acknowledgement' USING ERRCODE='22023'; END IF;
 v_note:=btrim(p_note);PERFORM pg_catalog.set_config('lock_timeout','3s',true);
 LOCK TABLE public.users,public.workers,public.supervisor_period_payroll,public.historical_external_worker_payroll,public.paid_period_assertion_cases,public.paid_period_assertion_case_events IN SHARE ROW EXCLUSIVE MODE;
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 SELECT * INTO v_case FROM public.paid_period_assertion_cases WHERE id=p_id FOR UPDATE;IF NOT FOUND THEN RAISE EXCEPTION 'Case unavailable' USING ERRCODE='P0002'; END IF;
 v_source:=coalesce(v_case.supervisor_payroll_id,v_case.external_worker_id);
 IF p_resolution='settled_external' AND p_settled_on<(v_case.original_snapshot->>'paid_on')::date THEN RAISE EXCEPTION 'Settlement cannot precede original payment date' USING ERRCODE='22023'; END IF;
 IF v_case.status<>'pending' THEN
  IF (v_case.status,v_case.resolved_by,v_case.settled_on,v_case.resolution_note) IS NOT DISTINCT FROM (p_resolution,auth.uid(),p_settled_on,v_note) THEN RETURN jsonb_build_object('id',p_id,'status',v_case.status,'replayed',true); END IF;
  RAISE EXCEPTION 'Case already resolved; review recorded decision' USING ERRCODE='22023'; END IF;
 IF public.paid_period_assertion_snapshot(v_case.source_kind,v_source) IS DISTINCT FROM v_case.original_snapshot THEN RAISE EXCEPTION 'Original paid period changed; investigate' USING ERRCODE='40001'; END IF;
 v_before:=to_jsonb(v_case);
 UPDATE public.paid_period_assertion_cases SET status=p_resolution,resolved_by=auth.uid(),resolved_at=clock_timestamp(),settled_on=p_settled_on,resolution_note=v_note WHERE id=p_id RETURNING * INTO v_case;
 INSERT INTO public.paid_period_assertion_case_events(case_id,kind,actor_id,before_row,after_row) VALUES(p_id,'resolved',auth.uid(),v_before,to_jsonb(v_case));
 RETURN jsonb_build_object('id',p_id,'status',v_case.status,'replayed',false);
END;
$$;
CREATE FUNCTION public.paid_period_assertion_case_list(p_kind text,p_source uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_snapshot jsonb;v_total bigint;v_items jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 IF p_source IS NULL OR p_kind IS NULL OR p_kind NOT IN ('supervisor','external_worker') THEN RAISE EXCEPTION 'Invalid paid period source' USING ERRCODE='22023'; END IF;
 v_snapshot:=public.paid_period_assertion_snapshot(p_kind,p_source);
 SELECT count(*) INTO v_total FROM public.paid_period_assertion_cases WHERE source_kind=p_kind AND coalesce(supervisor_payroll_id,external_worker_id)=p_source;
 IF v_total>100 THEN RAISE EXCEPTION 'Case history exceeds 100 entries; separate reconciliation required' USING ERRCODE='54000'; END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.created_at DESC,x.id),'[]'::jsonb) INTO v_items FROM (
  SELECT id,source_kind,coalesce(supervisor_payroll_id,external_worker_id) source_id,original_snapshot,difference::text,reason,status,created_by,created_at,resolved_by,resolved_at,settled_on,resolution_note
  FROM public.paid_period_assertion_cases WHERE source_kind=p_kind AND coalesce(supervisor_payroll_id,external_worker_id)=p_source
 ) x;
 RETURN jsonb_build_object('snapshot',v_snapshot,'total',v_total,'items',v_items);
END;
$$;
REVOKE ALL ON FUNCTION public.open_paid_period_assertion_case(uuid,text,uuid,jsonb,numeric,text),public.resolve_paid_period_assertion_case(uuid,text,date,text,boolean),public.paid_period_assertion_case_list(text,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.open_paid_period_assertion_case(uuid,text,uuid,jsonb,numeric,text),public.resolve_paid_period_assertion_case(uuid,text,date,text,boolean),public.paid_period_assertion_case_list(text,uuid) TO authenticated;
DO $postflight$
DECLARE v text;
BEGIN
 FOREACH v IN ARRAY ARRAY['public.paid_period_assertion_cases','public.paid_period_assertion_case_events'] LOOP
  IF EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r WHERE has_table_privilege(r,v,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) OR EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a CROSS JOIN unnest(ARRAY['anon','authenticated','service_role']) r WHERE a.attrelid=to_regclass(v) AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege(r,a.attrelid,a.attname,'SELECT,INSERT,UPDATE,REFERENCES')) THEN RAISE EXCEPTION 'Unexpected paid period case table privilege'; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r CROSS JOIN unnest(ARRAY['public.paid_period_assertion_snapshot(text,uuid)','public.guard_paid_period_assertion_case_immutable()']) f WHERE has_function_privilege(r,f,'EXECUTE')) THEN RAISE EXCEPTION 'Unexpected internal paid period case privilege'; END IF;
 FOREACH v IN ARRAY ARRAY['public.open_paid_period_assertion_case(uuid,text,uuid,jsonb,numeric,text)','public.resolve_paid_period_assertion_case(uuid,text,date,text,boolean)','public.paid_period_assertion_case_list(text,uuid)'] LOOP
  IF has_function_privilege('anon',v,'EXECUTE') OR has_function_privilege('service_role',v,'EXECUTE') OR NOT has_function_privilege('authenticated',v,'EXECUTE') THEN RAISE EXCEPTION 'Unexpected paid period case RPC privilege'; END IF;
 END LOOP;
END;
$postflight$;
