-- STAGED FOUNDATION: not used by manual sending or the cron yet. Do not unlock
-- automatic reminders or apply this migration to a hosted database without a
-- separately reviewed integration, recovery workflow and deployment plan.
--
-- A provider call cannot be inside a database transaction. These reservations
-- therefore deliberately have no lease timeout: a crashed worker or an
-- ambiguous provider result leaves the channel blocked, not silently replayed.
CREATE TABLE public.reminder_delivery_attempts (
  attempt_id uuid PRIMARY KEY,
  invoice_id uuid NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('email', 'sms')),
  source text NOT NULL CHECK (source IN ('manual', 'automatic')),
  state text NOT NULL CHECK (state IN ('reserved', 'unconfirmed', 'accepted', 'rejected', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX reminder_delivery_attempts_invoice_channel_time
  ON public.reminder_delivery_attempts (invoice_id, channel, created_at DESC);

CREATE TABLE public.reminder_delivery_locks (
  invoice_id uuid NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('email', 'sms')),
  active_attempt_id uuid REFERENCES public.reminder_delivery_attempts(attempt_id) ON DELETE SET NULL,
  PRIMARY KEY (invoice_id, channel)
);
ALTER TABLE public.reminder_delivery_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reminder_delivery_locks ENABLE ROW LEVEL SECURITY;
-- Do not rely on project-specific default grants; calls go through the RPCs.
REVOKE ALL ON public.reminder_delivery_attempts FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.reminder_delivery_locks FROM PUBLIC, anon, authenticated, service_role;

-- Serialize reservation for this invoice/channel. Replaying ANY existing
-- attempt_id never grants ownership a second time, even after it completes.
CREATE FUNCTION public.reserve_reminder_delivery(
  p_invoice_id uuid, p_channel text, p_source text, p_attempt_id uuid
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_active uuid; v_created uuid;
BEGIN
  IF p_invoice_id IS NULL OR p_attempt_id IS NULL OR p_channel IS NULL OR p_source IS NULL OR
     p_channel NOT IN ('email','sms') OR p_source NOT IN ('manual','automatic') THEN
    RETURN 'invalid';
  END IF;
  INSERT INTO public.reminder_delivery_locks (invoice_id, channel)
    VALUES (p_invoice_id, p_channel) ON CONFLICT (invoice_id, channel) DO NOTHING;
  SELECT active_attempt_id INTO v_active FROM public.reminder_delivery_locks
    WHERE invoice_id = p_invoice_id AND channel = p_channel FOR UPDATE;
  IF v_active IS NOT NULL THEN RETURN 'busy'; END IF;
  INSERT INTO public.reminder_delivery_attempts (attempt_id, invoice_id, channel, source, state)
    VALUES (p_attempt_id, p_invoice_id, p_channel, p_source, 'reserved')
    ON CONFLICT (attempt_id) DO NOTHING RETURNING attempt_id INTO v_created;
  IF v_created IS NULL THEN RETURN 'duplicate'; END IF;
  UPDATE public.reminder_delivery_locks SET active_attempt_id = p_attempt_id
    WHERE invoice_id = p_invoice_id AND channel = p_channel;
  RETURN 'reserved';
END;
$$;

-- Only the current owner can complete a reserved attempt. Callers may use
-- 'cancelled' ONLY before provider dispatch, and 'rejected' ONLY for a known
-- rejection. An ambiguous outcome retains the lock indefinitely. This first
-- version intentionally has no automated recovery/unlock path.
CREATE FUNCTION public.finish_reminder_delivery(
  p_invoice_id uuid, p_channel text, p_attempt_id uuid, p_outcome text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_active uuid; v_updated uuid;
BEGIN
  IF p_invoice_id IS NULL OR p_attempt_id IS NULL OR p_channel IS NULL OR p_outcome IS NULL OR
     p_channel NOT IN ('email','sms') OR p_outcome NOT IN ('accepted','rejected','cancelled','unconfirmed') THEN
    RETURN false;
  END IF;
  SELECT active_attempt_id INTO v_active FROM public.reminder_delivery_locks
    WHERE invoice_id = p_invoice_id AND channel = p_channel FOR UPDATE;
  IF v_active IS DISTINCT FROM p_attempt_id THEN RETURN false; END IF;
  UPDATE public.reminder_delivery_attempts SET state = p_outcome, updated_at = clock_timestamp()
    WHERE attempt_id = p_attempt_id AND invoice_id = p_invoice_id AND channel = p_channel AND state = 'reserved'
    RETURNING attempt_id INTO v_updated;
  IF v_updated IS NULL THEN RETURN false; END IF;
  IF p_outcome <> 'unconfirmed' THEN
    UPDATE public.reminder_delivery_locks SET active_attempt_id = NULL
      WHERE invoice_id = p_invoice_id AND channel = p_channel;
  END IF;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.reserve_reminder_delivery(uuid, text, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finish_reminder_delivery(uuid, text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_reminder_delivery(uuid, text, text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_reminder_delivery(uuid, text, uuid, text) TO service_role;
