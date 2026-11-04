-- Coordinate with the application deployment: old clients cannot update invoice
-- financial fields after this migration. Existing invoices are not rewritten.
-- Retain operation IDs even if an invoice is later deleted, so a retry never
-- turns a previously committed operation into a new payment.
CREATE TABLE IF NOT EXISTS public.invoice_payment_operations (
  request_id uuid PRIMARY KEY,
  invoice_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  expected_total numeric(14,2) NOT NULL,
  expected_paid numeric(14,2) NOT NULL,
  expected_status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.invoice_payment_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.invoice_payment_operations FROM PUBLIC, anon, authenticated;
-- The function owner alone writes/reads this internal idempotency ledger.

-- Revoke both table and possible pre-existing column privileges. Keep the
-- existing non-financial invoice edits used by the app; financial amount and
-- status edits require a separately designed, audited workflow.
REVOKE UPDATE ON public.invoices FROM PUBLIC, anon, authenticated;
REVOKE UPDATE (id, project_id, client_id, invoice_number, amount, amount_paid,
  issue_date, due_date, status, notes, created_at, automatic_reminders_enabled,
  reminders_paused_until) ON public.invoices FROM PUBLIC, anon, authenticated;
GRANT UPDATE (project_id, client_id, invoice_number, issue_date, due_date, notes,
  automatic_reminders_enabled, reminders_paused_until) ON public.invoices TO authenticated;

-- A normal application client must not manufacture an already-paid invoice to
-- bypass the payment/audit path. Privileged imports are outside this workflow.
CREATE OR REPLACE FUNCTION public.guard_invoice_payment_insert()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') AND
     (NEW.amount_paid <> 0 OR NEW.status IN ('paid', 'partially_paid')) THEN
    RAISE EXCEPTION 'New invoices must not contain a recorded payment.' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS guard_invoice_payment_insert ON public.invoices;
CREATE TRIGGER guard_invoice_payment_insert BEFORE INSERT ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.guard_invoice_payment_insert();

CREATE OR REPLACE FUNCTION public.record_invoice_payment_atomic(
  p_request_id uuid, p_invoice_id uuid, p_amount numeric,
  p_expected_total numeric, p_expected_paid numeric, p_expected_status text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_before public.invoices%ROWTYPE;
  v_after public.invoices%ROWTYPE;
  v_operation public.invoice_payment_operations%ROWTYPE;
  v_email text;
BEGIN
  IF auth.uid() IS NULL OR public.is_founder() IS NOT TRUE THEN
    RAISE EXCEPTION 'Founder access is required.' USING ERRCODE = '42501';
  END IF;
  IF p_request_id IS NULL OR p_invoice_id IS NULL OR p_amount IS NULL OR
     p_expected_total IS NULL OR p_expected_paid IS NULL OR p_expected_status IS NULL OR
     p_amount::text IN ('NaN', 'Infinity', '-Infinity') OR p_amount <= 0 OR
     p_amount > 999999999999.99 OR p_amount <> round(p_amount, 2) THEN
    RETURN jsonb_build_object('outcome', 'invalid');
  END IF;

  -- Serialize same-key retries even if a caller supplies another invoice ID.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 0));
  SELECT * INTO v_operation FROM public.invoice_payment_operations WHERE request_id = p_request_id;
  IF FOUND THEN
    IF (v_operation.invoice_id, v_operation.amount, v_operation.expected_total,
        v_operation.expected_paid, v_operation.expected_status)
       IS DISTINCT FROM (p_invoice_id, p_amount, p_expected_total, p_expected_paid, p_expected_status) THEN
      RETURN jsonb_build_object('outcome', 'request_mismatch');
    END IF;
    SELECT * INTO v_after FROM public.invoices WHERE id = p_invoice_id;
    RETURN jsonb_build_object('outcome', 'already_recorded', 'invoice',
      CASE WHEN FOUND THEN to_jsonb(v_after) ELSE NULL END);
  END IF;

  SELECT * INTO v_before FROM public.invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'not_found'); END IF;
  -- Reject a stale view, even if another payment left enough balance. The user
  -- must review whether that payment was the same real-world receipt.
  IF (v_before.amount, v_before.amount_paid, v_before.status)
      IS DISTINCT FROM (p_expected_total, p_expected_paid, p_expected_status) THEN
    RETURN jsonb_build_object('outcome', 'stale', 'invoice', to_jsonb(v_before));
  END IF;
  IF v_before.status IN ('paid', 'cancelled') OR v_before.amount_paid >= v_before.amount OR
     p_amount > v_before.amount - v_before.amount_paid THEN
    RETURN jsonb_build_object('outcome', 'invalid_balance', 'invoice', to_jsonb(v_before));
  END IF;

  UPDATE public.invoices SET amount_paid = amount_paid + p_amount,
    status = CASE WHEN amount_paid + p_amount = amount THEN 'paid' ELSE 'partially_paid' END
    WHERE id = p_invoice_id RETURNING * INTO v_after;
  SELECT email INTO v_email FROM public.users WHERE id = auth.uid();
  INSERT INTO public.audit_log (actor_id, actor_email, action, table_name, record_id, before_row, after_row)
    VALUES (auth.uid(), v_email, 'update', 'invoices', v_before.id, to_jsonb(v_before), to_jsonb(v_after));
  INSERT INTO public.invoice_payment_operations
    (request_id, invoice_id, actor_id, amount, expected_total, expected_paid, expected_status)
    VALUES (p_request_id, p_invoice_id, auth.uid(), p_amount, p_expected_total, p_expected_paid, p_expected_status);
  RETURN jsonb_build_object('outcome', 'recorded', 'invoice', to_jsonb(v_after));
END;
$$;
REVOKE ALL ON FUNCTION public.record_invoice_payment_atomic(uuid, uuid, numeric, numeric, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_invoice_payment_atomic(uuid, uuid, numeric, numeric, numeric, text) TO authenticated;
