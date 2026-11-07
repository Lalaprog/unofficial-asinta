-- STAGED ONLY: requires the unhosted coordination migration. No route uses it.
-- A slot remains claimed even if a later recheck cancels or a response is lost.
-- The attempt's state records the eventual result; ambiguous outcomes require
-- human review. Do not apply without the full integration and recovery design.
CREATE TABLE public.reminder_delivery_slots (
  invoice_id uuid NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('email','sms')),
  scheduled_date date NOT NULL,
  reminder_type text NOT NULL CHECK (reminder_type IN ('upcoming','due_today','overdue','follow_up')),
  attempt_id uuid NOT NULL UNIQUE REFERENCES public.reminder_delivery_attempts(attempt_id) ON DELETE CASCADE,
  PRIMARY KEY(invoice_id,channel,scheduled_date)
);
ALTER TABLE public.reminder_delivery_slots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.reminder_delivery_slots FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.claim_automatic_reminder_slot(
  p_invoice_id uuid, p_channel text, p_attempt_id uuid, p_scheduled_date date, p_type text
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_active uuid; v_attempt uuid;
BEGIN
  IF p_invoice_id IS NULL OR p_channel IS NULL OR p_attempt_id IS NULL OR p_scheduled_date IS NULL OR p_type IS NULL
     OR p_channel NOT IN ('email','sms') OR p_type NOT IN ('upcoming','due_today','overdue','follow_up') THEN RETURN 'invalid'; END IF;
  SELECT active_attempt_id INTO v_active FROM public.reminder_delivery_locks
    WHERE invoice_id=p_invoice_id AND channel=p_channel FOR UPDATE;
  IF v_active IS DISTINCT FROM p_attempt_id THEN RETURN 'not_owner'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.reminder_delivery_attempts WHERE attempt_id=p_attempt_id
      AND invoice_id=p_invoice_id AND channel=p_channel AND source='automatic' AND state='reserved') THEN RETURN 'not_owner'; END IF;
  INSERT INTO public.reminder_delivery_slots(invoice_id,channel,scheduled_date,reminder_type,attempt_id)
    VALUES (p_invoice_id,p_channel,p_scheduled_date,p_type,p_attempt_id)
    ON CONFLICT DO NOTHING RETURNING attempt_id INTO v_attempt;
  IF v_attempt IS NULL THEN RETURN 'duplicate'; END IF;
  RETURN 'claimed';
END;
$$;
REVOKE ALL ON FUNCTION public.claim_automatic_reminder_slot(uuid,text,uuid,date,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_automatic_reminder_slot(uuid,text,uuid,date,text) TO service_role;
