-- DRAFT ONLY. Read-only evidence view for the exact historical payment-date
-- and settled Bale candidates. Not a release migration or proof of payment.
-- This returns one bounded voucher's evidence, never changes finance records.
CREATE FUNCTION public.historical_finance_evidence_review(p_payroll uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_pay public.payroll%ROWTYPE; v_date public.historical_paid_date_annotations%ROWTYPE;
 v_bale public.historical_settled_bale_evidence%ROWTYPE; v_payment public.payroll_payment_dates%ROWTYPE;
 v_has_date boolean;v_has_bale boolean;v_has_payment boolean;v_snapshot jsonb;v_result jsonb;v_count integer;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN RAISE EXCEPTION 'Founder access with required assurance is required' USING ERRCODE='42501'; END IF;
 IF p_payroll IS NULL THEN RAISE EXCEPTION 'Choose a paid voucher' USING ERRCODE='22023'; END IF;
 SELECT * INTO v_pay FROM public.payroll WHERE id=p_payroll AND status='paid';
 IF NOT FOUND THEN RAISE EXCEPTION 'Paid voucher unavailable' USING ERRCODE='P0002'; END IF;
 v_snapshot:=public.historical_paid_voucher_snapshot(v_pay);
 -- The reviewed candidate schemas enforce uniqueness. Fail closed if a later
 -- schema change removes that protection, rather than picking an arbitrary row.
 SELECT count(*) INTO v_count FROM (SELECT 1 FROM public.historical_paid_date_annotations WHERE payroll_id=p_payroll LIMIT 2) x;
 IF v_count>1 THEN RAISE EXCEPTION 'Ambiguous historical payment-date evidence' USING ERRCODE='22023'; END IF;
 SELECT count(*) INTO v_count FROM (SELECT 1 FROM public.historical_settled_bale_evidence WHERE payroll_id=p_payroll LIMIT 2) x;
 IF v_count>1 THEN RAISE EXCEPTION 'Ambiguous historical Bale evidence' USING ERRCODE='22023'; END IF;
 SELECT count(*) INTO v_count FROM (SELECT 1 FROM public.payroll_payment_dates WHERE payroll_id=p_payroll LIMIT 2) x;
 IF v_count>1 THEN RAISE EXCEPTION 'Ambiguous recorded payment-date evidence' USING ERRCODE='22023'; END IF;
 SELECT * INTO v_date FROM public.historical_paid_date_annotations WHERE payroll_id=p_payroll; v_has_date:=FOUND;
 SELECT * INTO v_bale FROM public.historical_settled_bale_evidence WHERE payroll_id=p_payroll; v_has_bale:=FOUND;
 SELECT * INTO v_payment FROM public.payroll_payment_dates WHERE payroll_id=p_payroll; v_has_payment:=FOUND;
 v_result:=jsonb_build_object('payroll_id',p_payroll,'worker_id',v_pay.worker_id,'period_start',v_pay.period_start,'period_end',v_pay.period_end,
  'voucher_snapshot',v_snapshot,
  'payment_conflict',v_has_date AND v_has_payment,
  'recorded_payment_date',CASE WHEN v_has_payment THEN v_payment.payment_date ELSE NULL END,
  'date_evidence',CASE WHEN v_has_date THEN jsonb_build_object('request_id',v_date.request_id,'payment_date',v_date.payment_date,'note',v_date.evidence_note,
   'recorded_at',v_date.recorded_at,'recorded_by',v_date.recorded_by,'matches_voucher',v_date.voucher_snapshot=v_snapshot) ELSE NULL END,
  'bale_evidence',CASE WHEN v_has_bale THEN jsonb_build_object('request_id',v_bale.request_id,'project_id',v_bale.project_id,
   'release_date',v_bale.release_date,'amount',v_bale.amount::numeric(10,2)::text,'payment_date',v_bale.payment_date,'payment_date_source',v_bale.payment_date_source,
   'note',v_bale.evidence_note,'recorded_at',v_bale.recorded_at,'recorded_by',v_bale.recorded_by,'matches_voucher',v_bale.voucher_snapshot=v_snapshot,
   'context_changed',(v_bale.worker_id IS DISTINCT FROM v_pay.worker_id OR v_bale.amount IS DISTINCT FROM v_pay.bale_deduction OR (v_has_date AND v_has_payment)
    OR (v_bale.payment_date_source='recorded_payment' AND (NOT v_has_payment OR v_payment.payment_date IS DISTINCT FROM v_bale.payment_date))
    OR (v_bale.payment_date_source='historical_annotation' AND (NOT v_has_date OR v_date.payment_date IS DISTINCT FROM v_bale.payment_date OR v_date.voucher_snapshot IS DISTINCT FROM v_bale.voucher_snapshot))
    OR EXISTS(SELECT 1 FROM public.advances a WHERE a.worker_id=v_pay.worker_id AND a.date BETWEEN v_pay.period_start AND v_pay.period_end)
    OR EXISTS(SELECT 1 FROM public.payroll p WHERE p.id<>p_payroll AND p.worker_id=v_pay.worker_id AND p.period_start<=v_pay.period_end AND p.period_end>=v_pay.period_start))) ELSE NULL END);
 IF octet_length(v_result::text)>16384 THEN RAISE EXCEPTION 'Evidence response too large' USING ERRCODE='54000'; END IF;
 RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.historical_finance_evidence_review(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.historical_finance_evidence_review(uuid) TO authenticated;
DO $$ BEGIN IF has_function_privilege('anon','public.historical_finance_evidence_review(uuid)','EXECUTE') OR has_function_privilege('service_role','public.historical_finance_evidence_review(uuid)','EXECUTE') THEN RAISE EXCEPTION 'Unexpected inherited historical evidence review privilege'; END IF; END $$;
