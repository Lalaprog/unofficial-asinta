-- Payroll payment and Bale deductions must commit together. Existing paid
-- vouchers are left untouched; reconcile historical inconsistencies separately.
-- All application mutations of advance balances now use the functions below.

CREATE OR REPLACE FUNCTION public.guard_payroll_finalized_fields()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF auth.uid() IS NOT NULL AND NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'New payroll vouchers must start as drafts.' USING ERRCODE = '22023';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status IN ('approved', 'paid') AND
     (NEW.worker_id, NEW.period_start, NEW.period_end, NEW.gross_pay,
      NEW.bale_deduction, NEW.other_deductions, NEW.net_pay, NEW.days_worked,
      NEW.hours_worked, NEW.notes)
     IS DISTINCT FROM
     (OLD.worker_id, OLD.period_start, OLD.period_end, OLD.gross_pay,
      OLD.bale_deduction, OLD.other_deductions, OLD.net_pay, OLD.days_worked,
      OLD.hours_worked, OLD.notes) THEN
    RAISE EXCEPTION 'Approved or paid payroll vouchers cannot be recalculated.' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS guard_payroll_finalized_fields ON public.payroll;
CREATE TRIGGER guard_payroll_finalized_fields BEFORE INSERT OR UPDATE ON public.payroll
FOR EACH ROW EXECUTE FUNCTION public.guard_payroll_finalized_fields();

-- Do not let an old client update balances first and fail to update payroll
-- afterwards, or bypass the transactional status transition. The generator
-- still needs the explicitly listed draft voucher columns.
REVOKE UPDATE ON public.advances FROM PUBLIC, anon, authenticated;
REVOKE UPDATE ON public.payroll FROM PUBLIC, anon, authenticated;
GRANT UPDATE (worker_id, period_start, period_end, gross_pay, bale_deduction,
              other_deductions, net_pay, days_worked, hours_worked, notes)
  ON public.payroll TO authenticated;

CREATE OR REPLACE FUNCTION public.set_payroll_status_atomic(p_payroll_id uuid, p_status text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_worker_id uuid;
  v_before public.payroll%ROWTYPE;
  v_after public.payroll%ROWTYPE;
  v_advance public.advances%ROWTYPE;
  v_updated public.advances%ROWTYPE;
  v_available numeric;
  v_remaining numeric;
  v_deduct numeric;
  v_changed jsonb := '[]'::jsonb;
  v_email text;
BEGIN
  IF public.is_founder() IS NOT TRUE THEN
    RAISE EXCEPTION 'Founder access is required.' USING ERRCODE = '42501';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('approved', 'paid') THEN
    RAISE EXCEPTION 'Unsupported payroll transition.' USING ERRCODE = '22023';
  END IF;

  SELECT worker_id INTO v_worker_id FROM public.payroll WHERE id = p_payroll_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payroll voucher not found.' USING ERRCODE = 'P0002'; END IF;

  -- Serialize payments and manual deductions for the same worker, then lock
  -- the voucher and every eligible advance in a deterministic order.
  PERFORM 1 FROM public.workers WHERE id = v_worker_id FOR UPDATE;
  SELECT * INTO v_before FROM public.payroll WHERE id = p_payroll_id FOR UPDATE;
  IF NOT FOUND OR v_before.worker_id <> v_worker_id THEN
    RAISE EXCEPTION 'Payroll voucher changed. Refresh and retry.' USING ERRCODE = '40001';
  END IF;

  IF v_before.status = p_status THEN
    RETURN jsonb_build_object('outcome', 'already_' || p_status, 'payroll', to_jsonb(v_before), 'advances', v_changed);
  END IF;
  IF p_status = 'approved' AND v_before.status NOT IN ('draft', 'reviewed') THEN
    RAISE EXCEPTION 'Only draft or reviewed vouchers can be approved.' USING ERRCODE = '22023';
  END IF;
  IF p_status = 'paid' AND v_before.status <> 'approved' THEN
    RAISE EXCEPTION 'Only approved vouchers can be marked paid.' USING ERRCODE = '22023';
  END IF;

  SELECT email INTO v_email FROM public.users WHERE id = auth.uid();
  IF p_status = 'paid' AND v_before.bale_deduction > 0 THEN
    PERFORM 1 FROM public.advances
      WHERE worker_id = v_worker_id AND status IN ('active', 'partially_deducted')
      ORDER BY id FOR UPDATE;
    SELECT COALESCE(SUM(GREATEST(amount - amount_deducted, 0)), 0)
      INTO v_available FROM public.advances
      WHERE worker_id = v_worker_id AND status IN ('active', 'partially_deducted');
    IF v_available < v_before.bale_deduction THEN
      RAISE EXCEPTION 'Available Bale balance is less than the voucher deduction. Review the voucher and advances before recording payment.' USING ERRCODE = '22023';
    END IF;
    v_remaining := v_before.bale_deduction;
    FOR v_advance IN SELECT * FROM public.advances
      WHERE worker_id = v_worker_id AND status IN ('active', 'partially_deducted')
      ORDER BY date, id
    LOOP
      EXIT WHEN v_remaining <= 0;
      v_deduct := LEAST(v_remaining, GREATEST(v_advance.amount - v_advance.amount_deducted, 0));
      IF v_deduct <= 0 THEN CONTINUE; END IF;
      UPDATE public.advances SET amount_deducted = amount_deducted + v_deduct,
        status = CASE WHEN amount_deducted + v_deduct >= amount THEN 'fully_deducted' ELSE 'partially_deducted' END
        WHERE id = v_advance.id RETURNING * INTO v_updated;
      INSERT INTO public.audit_log (actor_id, actor_email, action, table_name, record_id, before_row, after_row)
        VALUES (auth.uid(), v_email, 'update', 'advances', v_advance.id, to_jsonb(v_advance), to_jsonb(v_updated));
      v_changed := v_changed || jsonb_build_array(to_jsonb(v_updated));
      v_remaining := v_remaining - v_deduct;
    END LOOP;
  END IF;

  UPDATE public.payroll SET status = p_status WHERE id = p_payroll_id RETURNING * INTO v_after;
  INSERT INTO public.audit_log (actor_id, actor_email, action, table_name, record_id, before_row, after_row)
    VALUES (auth.uid(), v_email, 'update', 'payroll', v_before.id, to_jsonb(v_before), to_jsonb(v_after));
  RETURN jsonb_build_object('outcome', 'updated', 'payroll', to_jsonb(v_after), 'advances', v_changed);
END;
$$;

CREATE OR REPLACE FUNCTION public.record_advance_deduction_atomic(p_advance_id uuid, p_amount numeric)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_worker_id uuid;
  v_before public.advances%ROWTYPE;
  v_after public.advances%ROWTYPE;
  v_email text;
BEGIN
  IF public.is_founder() IS NOT TRUE THEN RAISE EXCEPTION 'Founder access is required.' USING ERRCODE = '42501'; END IF;
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount <> round(p_amount, 2) THEN
    RAISE EXCEPTION 'Enter a positive deduction with at most two decimal places.' USING ERRCODE = '22023';
  END IF;
  SELECT worker_id INTO v_worker_id FROM public.advances WHERE id = p_advance_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Advance not found.' USING ERRCODE = 'P0002'; END IF;
  PERFORM 1 FROM public.workers WHERE id = v_worker_id FOR UPDATE;
  SELECT * INTO v_before FROM public.advances WHERE id = p_advance_id FOR UPDATE;
  IF NOT FOUND OR v_before.worker_id <> v_worker_id THEN
    RAISE EXCEPTION 'Advance changed. Refresh and retry.' USING ERRCODE = '40001';
  END IF;
  IF v_before.status NOT IN ('active', 'partially_deducted') OR p_amount > v_before.amount - v_before.amount_deducted THEN
    RAISE EXCEPTION 'The deduction exceeds the current active balance. Refresh and review the advance.' USING ERRCODE = '22023';
  END IF;
  UPDATE public.advances SET amount_deducted = amount_deducted + p_amount,
    status = CASE WHEN amount_deducted + p_amount >= amount THEN 'fully_deducted' ELSE 'partially_deducted' END
    WHERE id = p_advance_id RETURNING * INTO v_after;
  SELECT email INTO v_email FROM public.users WHERE id = auth.uid();
  INSERT INTO public.audit_log (actor_id, actor_email, action, table_name, record_id, before_row, after_row)
    VALUES (auth.uid(), v_email, 'update', 'advances', v_before.id, to_jsonb(v_before), to_jsonb(v_after));
  RETURN to_jsonb(v_after);
END;
$$;

CREATE OR REPLACE FUNCTION public.set_advance_status_atomic(p_advance_id uuid, p_status text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_worker_id uuid;
  v_before public.advances%ROWTYPE;
  v_after public.advances%ROWTYPE;
  v_email text;
BEGIN
  IF public.is_founder() IS NOT TRUE THEN RAISE EXCEPTION 'Founder access is required.' USING ERRCODE = '42501'; END IF;
  IF p_status IS NULL OR p_status NOT IN ('active', 'partially_deducted', 'fully_deducted', 'cancelled') THEN
    RAISE EXCEPTION 'Invalid advance status.' USING ERRCODE = '22023';
  END IF;
  SELECT worker_id INTO v_worker_id FROM public.advances WHERE id = p_advance_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Advance not found.' USING ERRCODE = 'P0002'; END IF;
  PERFORM 1 FROM public.workers WHERE id = v_worker_id FOR UPDATE;
  SELECT * INTO v_before FROM public.advances WHERE id = p_advance_id FOR UPDATE;
  IF NOT FOUND OR v_before.worker_id <> v_worker_id THEN
    RAISE EXCEPTION 'Advance changed. Refresh and retry.' USING ERRCODE = '40001';
  END IF;
  IF (p_status = 'active' AND v_before.amount_deducted <> 0)
     OR (p_status = 'partially_deducted' AND (v_before.amount_deducted <= 0 OR v_before.amount_deducted >= v_before.amount))
     OR (p_status = 'fully_deducted' AND v_before.amount_deducted <> v_before.amount) THEN
    RAISE EXCEPTION 'Advance status does not match its current balance.' USING ERRCODE = '22023';
  END IF;
  UPDATE public.advances SET status = p_status WHERE id = p_advance_id RETURNING * INTO v_after;
  SELECT email INTO v_email FROM public.users WHERE id = auth.uid();
  INSERT INTO public.audit_log (actor_id, actor_email, action, table_name, record_id, before_row, after_row)
    VALUES (auth.uid(), v_email, 'update', 'advances', v_before.id, to_jsonb(v_before), to_jsonb(v_after));
  RETURN to_jsonb(v_after);
END;
$$;

REVOKE ALL ON FUNCTION public.set_payroll_status_atomic(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.record_advance_deduction_atomic(uuid, numeric) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_advance_status_atomic(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_payroll_status_atomic(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_advance_deduction_atomic(uuid, numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_advance_status_atomic(uuid, text) TO authenticated;
