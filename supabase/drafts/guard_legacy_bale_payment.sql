-- Draft safety gate for the existing paid transition. This does not implement
-- the new payroll generator, real transfers, historical reconciliation, actual
-- payment dates or the weekly request/release schedule. It never rewrites rows.
-- Existing paid vouchers stay authoritative; ambiguous cases require review.

-- Serialize ordinary client advance insertion with payroll finalization using
-- the worker lock shared by existing payroll and manual-deduction functions.
-- A late advance for an approved/paid period must go through a separately
-- designed correction/reconciliation workflow, not silently affect history.
CREATE FUNCTION public.guard_new_advance_finalized_payroll()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  -- Privileged imports/service/database-owner work is outside this guard.
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  IF current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'Bale recording requires read committed isolation' USING ERRCODE='P1002'; END IF;
  PERFORM 1 FROM public.workers WHERE id=NEW.worker_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Worker unavailable' USING ERRCODE='22023'; END IF;
  IF EXISTS(SELECT 1 FROM public.payroll p WHERE p.worker_id=NEW.worker_id AND NEW.date BETWEEN p.period_start AND p.period_end AND p.status IN ('approved','paid')) THEN
    RAISE EXCEPTION 'Approved or paid payroll covers this Bale date; review a separate correction for the original period' USING ERRCODE='22023'; END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_new_advance_finalized_payroll() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER guard_new_advance_finalized_payroll BEFORE INSERT ON public.advances
FOR EACH ROW EXECUTE FUNCTION public.guard_new_advance_finalized_payroll();

-- Keep the atomic implementation and its audit behavior, but do not expose an
-- unguarded callable alias to API roles after renaming it.
ALTER FUNCTION public.set_payroll_status_atomic(uuid,text) RENAME TO legacy_set_payroll_status_atomic_unchecked;
REVOKE ALL ON FUNCTION public.legacy_set_payroll_status_atomic_unchecked(uuid,text) FROM PUBLIC,anon,authenticated,service_role;
DO $$
BEGIN
  IF has_function_privilege('anon','public.legacy_set_payroll_status_atomic_unchecked(uuid,text)','EXECUTE')
    OR has_function_privilege('authenticated','public.legacy_set_payroll_status_atomic_unchecked(uuid,text)','EXECUTE')
    OR has_function_privilege('service_role','public.legacy_set_payroll_status_atomic_unchecked(uuid,text)','EXECUTE') THEN
    RAISE EXCEPTION 'Unchecked payroll transition remains executable through inherited privileges'; END IF;
END;
$$;

CREATE FUNCTION public.set_payroll_status_atomic(p_payroll_id uuid,p_status text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_worker uuid; v_pay public.payroll%ROWTYPE; v_period_total numeric; v_has_period_bale boolean;
BEGIN
  IF NOT coalesce(public.is_founder(),false) THEN RAISE EXCEPTION 'Founder access is required' USING ERRCODE='42501'; END IF;
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Payroll status requires read committed isolation' USING ERRCODE='P1002'; END IF;
  IF p_status IS NULL OR p_status NOT IN ('approved','paid') THEN RAISE EXCEPTION 'Unsupported payroll transition' USING ERRCODE='22023'; END IF;
  SELECT worker_id INTO v_worker FROM public.payroll WHERE id=p_payroll_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payroll voucher not found' USING ERRCODE='P0002'; END IF;
  PERFORM 1 FROM public.workers WHERE id=v_worker FOR UPDATE;
  SELECT * INTO v_pay FROM public.payroll WHERE id=p_payroll_id FOR UPDATE;
  IF NOT FOUND OR v_pay.worker_id<>v_worker THEN RAISE EXCEPTION 'Payroll voucher changed; refresh and retry' USING ERRCODE='40001'; END IF;
  -- Preserve harmless already-paid retries and leave invalid transitions to the
  -- legacy implementation; never re-run deductions for a paid voucher.
  IF p_status='paid' AND v_pay.status='approved' THEN
    IF EXISTS(SELECT 1 FROM public.payroll p WHERE p.id<>v_pay.id AND p.worker_id=v_worker AND p.status IN ('approved','paid')
      AND p.period_start<=v_pay.period_end AND p.period_end>=v_pay.period_start) THEN
      RAISE EXCEPTION 'Another approved or paid voucher overlaps this period; review before recording payment' USING ERRCODE='22023'; END IF;
    IF v_pay.gross_pay-v_pay.bale_deduction-v_pay.other_deductions<0 OR v_pay.net_pay<>v_pay.gross_pay-v_pay.bale_deduction-v_pay.other_deductions THEN
      RAISE EXCEPTION 'Voucher totals need review before recording payment' USING ERRCODE='22023'; END IF;
    PERFORM 1 FROM public.advances WHERE worker_id=v_worker ORDER BY id FOR UPDATE;
    SELECT EXISTS(SELECT 1 FROM public.advances a WHERE a.worker_id=v_worker AND a.date BETWEEN v_pay.period_start AND v_pay.period_end
      AND (a.status<>'cancelled' OR a.amount_deducted<>0)) INTO v_has_period_bale;
    IF (v_pay.bale_deduction>0 OR v_has_period_bale) AND
      (v_pay.period_end<>v_pay.period_start+6 OR extract(dow FROM v_pay.period_start)<>0) THEN
      RAISE EXCEPTION 'Bale on a non-weekly voucher requires separate Founder reconciliation' USING ERRCODE='22023'; END IF;
    -- The legacy payment function consumes oldest outstanding balances first.
    -- Never let it silently draw a different period to satisfy this voucher.
    IF v_pay.bale_deduction>0 AND EXISTS(SELECT 1 FROM public.advances a WHERE a.worker_id=v_worker
      AND a.status IN ('active','partially_deducted') AND (a.date<v_pay.period_start OR a.date>v_pay.period_end)) THEN
      RAISE EXCEPTION 'Outstanding Bale outside this period requires separate Founder reconciliation; it will not be carried forward' USING ERRCODE='22023'; END IF;
    IF EXISTS(SELECT 1 FROM public.advances a WHERE a.worker_id=v_worker AND a.date BETWEEN v_pay.period_start AND v_pay.period_end
      AND ((a.status='cancelled' AND a.amount_deducted<>0) OR (a.status<>'cancelled' AND (
        a.status<>'active' OR a.amount_deducted<>0 OR extract(dow FROM a.date)<>3 OR NOT EXISTS(
          SELECT 1 FROM public.advance_requests r WHERE r.issued_advance_id=a.id AND r.status='issued'
            AND r.worker_id=a.worker_id AND r.project_id=a.project_id AND r.requested_amount=a.amount
            AND (r.issued_at AT TIME ZONE 'Asia/Manila')::date=a.date))))) THEN
      RAISE EXCEPTION 'Recorded Bale release, date or previous deduction needs Founder reconciliation' USING ERRCODE='22023'; END IF;
    IF EXISTS(SELECT 1 FROM public.advances a WHERE a.worker_id=v_worker AND a.date BETWEEN v_pay.period_start AND v_pay.period_end AND a.status<>'cancelled'
      GROUP BY a.project_id,a.date,a.amount HAVING count(*)>1) THEN
      RAISE EXCEPTION 'Possible duplicate Bale releases require Founder reconciliation' USING ERRCODE='22023'; END IF;
    SELECT coalesce(sum(a.amount),0) INTO v_period_total FROM public.advances a
      WHERE a.worker_id=v_worker AND a.date BETWEEN v_pay.period_start AND v_pay.period_end AND a.status='active';
    IF v_period_total<>v_pay.bale_deduction THEN
      RAISE EXCEPTION 'Voucher Bale deduction does not match all recorded releases for this period; review before payment' USING ERRCODE='22023'; END IF;
  END IF;
  RETURN public.legacy_set_payroll_status_atomic_unchecked(p_payroll_id,p_status);
END;
$$;
REVOKE ALL ON FUNCTION public.set_payroll_status_atomic(uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.set_payroll_status_atomic(uuid,text) TO authenticated,service_role;
