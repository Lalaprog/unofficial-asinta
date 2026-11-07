-- Capture when each channel becomes effectively enabled (master AND channel).
-- The rollout constraint is deliberately unchanged: sending remains locked OFF.
ALTER TABLE public.reminder_settings
  ADD COLUMN email_effective_since timestamptz,
  ADD COLUMN sms_effective_since timestamptz,
  ADD CONSTRAINT reminder_email_epoch_consistent CHECK ((email_effective_since IS NOT NULL) = (master_enabled AND email_enabled)),
  ADD CONSTRAINT reminder_sms_epoch_consistent CHECK ((sms_effective_since IS NOT NULL) = (master_enabled AND sms_enabled));

CREATE OR REPLACE FUNCTION public.stamp_reminder_settings() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  NEW.singleton := OLD.singleton;
  NEW.revision := OLD.revision + 1;
  NEW.updated_at := now();
  NEW.updated_by := auth.uid();
  -- Ignore all caller-supplied epochs, even on direct table updates.
  IF NEW.master_enabled AND NEW.email_enabled THEN
    NEW.email_effective_since := CASE WHEN OLD.master_enabled AND OLD.email_enabled THEN OLD.email_effective_since ELSE clock_timestamp() END;
  ELSE NEW.email_effective_since := NULL; END IF;
  IF NEW.master_enabled AND NEW.sms_enabled THEN
    NEW.sms_effective_since := CASE WHEN OLD.master_enabled AND OLD.sms_enabled THEN OLD.sms_effective_since ELSE clock_timestamp() END;
  ELSE NEW.sms_effective_since := NULL; END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.stamp_reminder_settings() FROM PUBLIC, anon, authenticated;
