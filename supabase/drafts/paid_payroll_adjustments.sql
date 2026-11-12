-- DRAFT ONLY. Separate Founder-reviewed cases against original paid vouchers.
-- Not a payment system, an automatic reconciliation, or a hosted migration.
-- Do not apply until workflow, live compatibility and transaction tests are reviewed.
-- Requires public.users, public.workers, public.payroll, auth.uid() and
-- public.is_founder(). Existing payroll, advances and accounts are not changed.

CREATE TABLE public.paid_payroll_adjustment_cases (
  id uuid PRIMARY KEY,
  payroll_id uuid NOT NULL REFERENCES public.payroll(id) ON DELETE RESTRICT,
  worker_id uuid NOT NULL REFERENCES public.workers(id) ON DELETE RESTRICT,
  original_voucher jsonb NOT NULL,
  difference numeric(12,2) NOT NULL CHECK (difference <> 0),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','settled_external','no_transfer')),
  created_by uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_by uuid REFERENCES public.users(id) ON DELETE RESTRICT,
  resolved_at timestamptz,
  settled_on date,
  resolution_note text,
  CHECK ((status='pending' AND resolved_by IS NULL AND resolved_at IS NULL AND settled_on IS NULL AND resolution_note IS NULL)
    OR (status='settled_external' AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL AND settled_on IS NOT NULL AND resolution_note IS NOT NULL AND length(resolution_note) BETWEEN 1 AND 500)
    OR (status='no_transfer' AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL AND settled_on IS NULL AND resolution_note IS NOT NULL AND length(resolution_note) BETWEEN 1 AND 500))
);
CREATE UNIQUE INDEX paid_adjustments_one_pending_per_voucher ON public.paid_payroll_adjustment_cases(payroll_id) WHERE status='pending';
CREATE INDEX paid_adjustments_voucher_history ON public.paid_payroll_adjustment_cases(payroll_id,created_at DESC,id);
ALTER TABLE public.paid_payroll_adjustment_cases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.paid_payroll_adjustment_cases FROM PUBLIC,anon,authenticated;

-- This compact snapshot is the exact version the Founder reviewed. All money
-- is returned as text to avoid JavaScript floating-point loss. It is evidence of
-- a database record, not proof money was paid or a correction is owed.
CREATE FUNCTION app_private.paid_adjustment_voucher_snapshot(p public.payroll)
RETURNS jsonb LANGUAGE sql STABLE SET search_path='' AS $$
 SELECT jsonb_build_object('id',p.id,'worker_id',p.worker_id,'period_start',p.period_start,'period_end',p.period_end,
  'status',p.status,'gross_pay',p.gross_pay::text,'bale_deduction',p.bale_deduction::text,
  'other_deductions',p.other_deductions::text,'net_pay',p.net_pay::text)
$$;
REVOKE ALL ON FUNCTION app_private.paid_adjustment_voucher_snapshot(public.payroll) FROM PUBLIC,anon,authenticated;

-- Caller supplies an idempotency ID and the exact voucher version reviewed.
-- Positive difference means more due to the worker; negative means a possible
-- overpayment. Neither value is automatically paid, deducted or carried ahead.
CREATE FUNCTION public.open_paid_payroll_adjustment(p_id uuid,p_payroll_id uuid,p_expected jsonb,p_difference numeric,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_worker uuid; v_pay public.payroll%ROWTYPE; v_prev public.paid_payroll_adjustment_cases%ROWTYPE; v_snapshot jsonb; v_reason text;
BEGIN
 IF NOT coalesce(public.is_founder(),false) THEN RAISE EXCEPTION 'Founder access required' USING ERRCODE='42501'; END IF;
 IF current_setting('transaction_isolation') <> 'read committed' THEN RAISE EXCEPTION 'Adjustment review requires read committed isolation' USING ERRCODE='P1002'; END IF;
 IF p_id IS NULL OR p_payroll_id IS NULL OR p_expected IS NULL OR p_difference IS NULL OR p_difference='NaN'::numeric
   OR p_difference=0 OR abs(p_difference)>=10000000000 OR p_difference<>round(p_difference,2)
   OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 500 THEN
  RAISE EXCEPTION 'Enter a valid nonzero difference and review reason' USING ERRCODE='22023'; END IF;
 v_reason:=btrim(p_reason);
 PERFORM 1 FROM public.users WHERE id=auth.uid() AND role='founder' FOR SHARE;
 IF NOT FOUND OR NOT coalesce(public.is_founder(),false) THEN RAISE EXCEPTION 'Founder access required' USING ERRCODE='42501'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('paid-payroll-adjustment:'||p_id::text,0));
 SELECT worker_id INTO v_worker FROM public.payroll WHERE id=p_payroll_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Paid voucher unavailable' USING ERRCODE='P0002'; END IF;
 -- Match the worker -> voucher lock order of the existing payroll status RPC.
 PERFORM 1 FROM public.workers WHERE id=v_worker FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Worker unavailable' USING ERRCODE='P0002'; END IF;
 SELECT * INTO v_pay FROM public.payroll WHERE id=p_payroll_id FOR UPDATE;
 IF NOT FOUND OR v_pay.worker_id<>v_worker THEN RAISE EXCEPTION 'Voucher changed; refresh' USING ERRCODE='40001'; END IF;
 SELECT * INTO v_prev FROM public.paid_payroll_adjustment_cases WHERE id=p_id;
 IF FOUND THEN
  IF (v_prev.created_by,v_prev.payroll_id,v_prev.original_voucher,v_prev.difference,v_prev.reason) IS DISTINCT FROM (auth.uid(),p_payroll_id,p_expected,p_difference,v_reason) THEN
   RAISE EXCEPTION 'Adjustment ID already used for different details' USING ERRCODE='22023'; END IF;
  RETURN jsonb_build_object('id',v_prev.id,'status',v_prev.status,'replayed',true);
 END IF;
 IF v_pay.status<>'paid' THEN RAISE EXCEPTION 'Only a paid voucher can have a paid-period review case' USING ERRCODE='22023'; END IF;
 v_snapshot:=app_private.paid_adjustment_voucher_snapshot(v_pay);
 IF v_snapshot IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'Voucher changed since review; refresh first' USING ERRCODE='40001'; END IF;
 IF EXISTS(SELECT 1 FROM public.paid_payroll_adjustment_cases WHERE payroll_id=p_payroll_id AND status='pending') THEN
  RAISE EXCEPTION 'This voucher already has a pending review case' USING ERRCODE='22023'; END IF;
 INSERT INTO public.paid_payroll_adjustment_cases(id,payroll_id,worker_id,original_voucher,difference,reason,created_by)
 VALUES(p_id,p_payroll_id,v_worker,v_snapshot,p_difference,v_reason,auth.uid());
 RETURN jsonb_build_object('id',p_id,'status','pending','replayed',false);
END;
$$;
REVOKE ALL ON FUNCTION public.open_paid_payroll_adjustment(uuid,uuid,jsonb,numeric,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.open_paid_payroll_adjustment(uuid,uuid,jsonb,numeric,text) TO authenticated;

-- External settlement is a human statement, not a money transfer. This narrow
-- draft records either a complete external settlement or no transfer; partial
-- settlements require a separate future design rather than silent aggregation.
CREATE FUNCTION public.resolve_paid_payroll_adjustment(p_id uuid,p_resolution text,p_settled_on date,p_note text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_payroll uuid; v_worker uuid; v_pay public.payroll%ROWTYPE; v_case public.paid_payroll_adjustment_cases%ROWTYPE; v_note text;
BEGIN
 IF NOT coalesce(public.is_founder(),false) THEN RAISE EXCEPTION 'Founder access required' USING ERRCODE='42501'; END IF;
 IF current_setting('transaction_isolation') <> 'read committed' THEN RAISE EXCEPTION 'Adjustment review requires read committed isolation' USING ERRCODE='P1002'; END IF;
 IF p_id IS NULL OR p_resolution IS NULL OR p_resolution NOT IN ('settled_external','no_transfer')
   OR p_note IS NULL OR length(btrim(p_note)) NOT BETWEEN 1 AND 500
   OR (p_resolution='no_transfer' AND p_settled_on IS NOT NULL)
   OR (p_resolution='settled_external' AND (p_settled_on IS NULL OR p_settled_on<'1900-01-01'::date OR p_settled_on>(clock_timestamp() AT TIME ZONE 'Asia/Manila')::date)) THEN
  RAISE EXCEPTION 'Enter a valid resolution, date and explanation' USING ERRCODE='22023'; END IF;
 v_note:=btrim(p_note);
 PERFORM 1 FROM public.users WHERE id=auth.uid() AND role='founder' FOR SHARE;
 IF NOT FOUND OR NOT coalesce(public.is_founder(),false) THEN RAISE EXCEPTION 'Founder access required' USING ERRCODE='42501'; END IF;
 SELECT payroll_id,worker_id INTO v_payroll,v_worker FROM public.paid_payroll_adjustment_cases WHERE id=p_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Adjustment case unavailable' USING ERRCODE='P0002'; END IF;
 PERFORM 1 FROM public.workers WHERE id=v_worker FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Worker unavailable' USING ERRCODE='P0002'; END IF;
 SELECT * INTO v_pay FROM public.payroll WHERE id=v_payroll FOR UPDATE;
 IF NOT FOUND OR v_pay.worker_id<>v_worker THEN RAISE EXCEPTION 'Voucher changed; refresh' USING ERRCODE='40001'; END IF;
 SELECT * INTO v_case FROM public.paid_payroll_adjustment_cases WHERE id=p_id FOR UPDATE;
 IF NOT FOUND OR v_case.payroll_id<>v_payroll OR v_case.worker_id<>v_worker THEN RAISE EXCEPTION 'Adjustment changed; refresh' USING ERRCODE='40001'; END IF;
 IF p_resolution='settled_external' AND p_settled_on<v_pay.period_start THEN
  RAISE EXCEPTION 'Settlement date cannot precede the original payroll period' USING ERRCODE='22023'; END IF;
 IF v_case.status<>'pending' THEN
  IF (v_case.status,v_case.resolved_by,v_case.settled_on,v_case.resolution_note) IS NOT DISTINCT FROM (p_resolution,auth.uid(),p_settled_on,v_note) THEN
   RETURN jsonb_build_object('id',v_case.id,'status',v_case.status,'replayed',true); END IF;
  RAISE EXCEPTION 'Case already resolved; review recorded decision' USING ERRCODE='22023'; END IF;
 IF v_pay.status<>'paid' OR app_private.paid_adjustment_voucher_snapshot(v_pay) IS DISTINCT FROM v_case.original_voucher THEN
  RAISE EXCEPTION 'Original voucher changed since review; investigate before resolving' USING ERRCODE='40001'; END IF;
 UPDATE public.paid_payroll_adjustment_cases SET status=p_resolution,resolved_by=auth.uid(),resolved_at=clock_timestamp(),settled_on=p_settled_on,resolution_note=v_note WHERE id=p_id;
 RETURN jsonb_build_object('id',p_id,'status',p_resolution,'replayed',false);
END;
$$;
REVOKE ALL ON FUNCTION public.resolve_paid_payroll_adjustment(uuid,text,date,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_paid_payroll_adjustment(uuid,text,date,text) TO authenticated;

CREATE FUNCTION public.paid_payroll_adjustment_list(p_payroll_id uuid,p_offset integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_total bigint; v_items jsonb;
BEGIN
 IF NOT coalesce(public.is_founder(),false) THEN RAISE EXCEPTION 'Founder access required' USING ERRCODE='42501'; END IF;
 IF p_payroll_id IS NULL OR p_offset IS NULL OR p_offset<0 OR p_offset>1000000 THEN RAISE EXCEPTION 'Invalid adjustment list request' USING ERRCODE='22023'; END IF;
 SELECT count(*) INTO v_total FROM public.paid_payroll_adjustment_cases WHERE payroll_id=p_payroll_id;
 SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.created_at DESC,x.id),'[]'::jsonb) INTO v_items FROM (
  SELECT c.id,c.payroll_id,c.worker_id,c.original_voucher,c.difference::text AS difference,c.reason,c.status,c.created_at,c.created_by,c.resolved_at,c.resolved_by,c.settled_on,c.resolution_note
  FROM public.paid_payroll_adjustment_cases c WHERE c.payroll_id=p_payroll_id ORDER BY c.created_at DESC,c.id LIMIT 100 OFFSET p_offset
 ) x;
 RETURN jsonb_build_object('total',v_total,'offset',p_offset,'items',v_items);
END;
$$;
REVOKE ALL ON FUNCTION public.paid_payroll_adjustment_list(uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.paid_payroll_adjustment_list(uuid,integer) TO authenticated;

-- Fail closed if default or inherited role grants leave a client with table or
-- internal-helper access, or if anonymous execution remains effective.
DO $postflight$
DECLARE v_proc regprocedure; v_signature text;
BEGIN
 IF NOT (SELECT relrowsecurity FROM pg_catalog.pg_class WHERE oid='public.paid_payroll_adjustment_cases'::regclass)
  OR has_table_privilege('anon','public.paid_payroll_adjustment_cases','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  OR has_table_privilege('authenticated','public.paid_payroll_adjustment_cases','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN
  RAISE EXCEPTION 'Unexpected direct adjustment-table client privilege'; END IF;
 v_proc:='app_private.paid_adjustment_voucher_snapshot(public.payroll)'::regprocedure;
 IF has_function_privilege('anon',v_proc,'EXECUTE') OR has_function_privilege('authenticated',v_proc,'EXECUTE') THEN
  RAISE EXCEPTION 'Unexpected internal adjustment-helper privilege'; END IF;
 FOREACH v_signature IN ARRAY ARRAY['public.open_paid_payroll_adjustment(uuid,uuid,jsonb,numeric,text)','public.resolve_paid_payroll_adjustment(uuid,text,date,text)','public.paid_payroll_adjustment_list(uuid,integer)'] LOOP
  v_proc:=v_signature::regprocedure;
  IF has_function_privilege('anon',v_proc,'EXECUTE') OR NOT has_function_privilege('authenticated',v_proc,'EXECUTE')
    OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE oid=v_proc AND prosecdef AND proconfig @> ARRAY['search_path=""']) THEN
   RAISE EXCEPTION 'Unexpected adjustment RPC security: %',v_signature; END IF;
 END LOOP;
END;
$postflight$;
