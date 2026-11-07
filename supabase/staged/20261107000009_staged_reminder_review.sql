-- STAGED ONLY: not hosted, not connected to UI or delivery. Never resolve a
-- lock just because it is old. A Founder must independently confirm both that
-- no sender can still be running AND the provider outcome; a mistaken review
-- can cause a duplicate message. This does not prove final delivery.
CREATE TABLE public.reminder_delivery_reviews (
  attempt_id uuid PRIMARY KEY REFERENCES public.reminder_delivery_attempts(attempt_id) ON DELETE RESTRICT,
  reviewer_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  reviewed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  previous_state text NOT NULL CHECK (previous_state IN ('reserved','unconfirmed')),
  outcome text NOT NULL CHECK (outcome IN ('accepted','rejected','cancelled')),
  evidence text NOT NULL CHECK (char_length(btrim(evidence)) BETWEEN 20 AND 500)
);
ALTER TABLE public.reminder_delivery_reviews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.reminder_delivery_reviews FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.review_reminder_delivery(
  p_actor uuid, p_invoice_id uuid, p_channel text, p_attempt_id uuid,
  p_outcome text, p_evidence text, p_confirm_no_sender_running boolean
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_active uuid; v_state text;
BEGIN
  IF p_actor IS NULL OR p_invoice_id IS NULL OR p_channel IS NULL OR p_attempt_id IS NULL
    OR p_channel NOT IN ('email','sms') OR p_outcome IS NULL OR p_outcome NOT IN ('accepted','rejected','cancelled')
    OR p_confirm_no_sender_running IS DISTINCT FROM true OR p_evidence IS NULL
    OR char_length(btrim(p_evidence)) NOT BETWEEN 20 AND 500 THEN RETURN false; END IF;
  -- Serialize with team mutations. The application must separately verify
  -- identity and MFA before using this service-role-only function.
  PERFORM app_private.lock_founder_guard();
  IF NOT EXISTS (SELECT 1 FROM public.users WHERE id=p_actor AND role='founder') THEN RETURN false; END IF;
  SELECT active_attempt_id INTO v_active FROM public.reminder_delivery_locks
    WHERE invoice_id=p_invoice_id AND channel=p_channel FOR UPDATE;
  IF v_active IS DISTINCT FROM p_attempt_id THEN RETURN false; END IF;
  SELECT state INTO v_state FROM public.reminder_delivery_attempts
    WHERE attempt_id=p_attempt_id AND invoice_id=p_invoice_id AND channel=p_channel FOR UPDATE;
  IF v_state IS NULL OR v_state NOT IN ('reserved','unconfirmed') THEN RETURN false; END IF;
  INSERT INTO public.reminder_delivery_reviews(attempt_id,reviewer_id,previous_state,outcome,evidence)
    VALUES(p_attempt_id,p_actor,v_state,p_outcome,btrim(p_evidence));
  UPDATE public.reminder_delivery_attempts SET state=p_outcome,updated_at=clock_timestamp()
    WHERE attempt_id=p_attempt_id;
  DELETE FROM public.reminder_delivery_locks
    WHERE invoice_id=p_invoice_id AND channel=p_channel;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.review_reminder_delivery(uuid,uuid,text,uuid,text,text,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.review_reminder_delivery(uuid,uuid,text,uuid,text,text,boolean) TO service_role;
