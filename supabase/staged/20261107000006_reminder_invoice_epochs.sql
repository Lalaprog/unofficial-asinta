-- STAGED ONLY. Do not apply to the hosted database without reviewing the
-- complete reminder dispatcher, history, recovery and rollout together.
-- These timestamps are eligibility metadata, not authorization to send.
-- Historical activation/schedule times cannot be reconstructed reliably:
-- seed existing rows at migration time, conservatively excluding old slots.
ALTER TABLE public.invoices
  ADD COLUMN reminder_invoice_effective_since timestamptz,
  ADD COLUMN reminder_schedule_effective_since timestamptz;

UPDATE public.invoices SET
  reminder_invoice_effective_since = CASE
    WHEN automatic_reminders_enabled IS TRUE
      AND status IN ('pending','partially_paid','overdue')
      AND amount IS NOT NULL AND amount_paid IS NOT NULL
      AND amount >= 0 AND amount_paid >= 0 AND amount > amount_paid
    THEN clock_timestamp() ELSE NULL END,
  reminder_schedule_effective_since = clock_timestamp();

CREATE FUNCTION public.stamp_invoice_reminder_epochs() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_new_eligible boolean;
  v_old_eligible boolean := false;
  v_now timestamptz := clock_timestamp();
BEGIN
  v_new_eligible := COALESCE(NEW.automatic_reminders_enabled IS TRUE
    AND NEW.status IN ('pending','partially_paid','overdue')
    AND NEW.amount >= 0 AND NEW.amount_paid >= 0 AND NEW.amount > NEW.amount_paid, false);
  IF TG_OP = 'UPDATE' THEN
    v_old_eligible := COALESCE(OLD.automatic_reminders_enabled IS TRUE
      AND OLD.status IN ('pending','partially_paid','overdue')
      AND OLD.amount >= 0 AND OLD.amount_paid >= 0 AND OLD.amount > OLD.amount_paid, false);
  END IF;
  IF v_new_eligible THEN
    IF TG_OP = 'INSERT' OR NOT v_old_eligible OR OLD.reminder_invoice_effective_since IS NULL
       OR NEW.reminders_paused_until IS DISTINCT FROM OLD.reminders_paused_until THEN
      NEW.reminder_invoice_effective_since := v_now;
    ELSE
      NEW.reminder_invoice_effective_since := OLD.reminder_invoice_effective_since;
    END IF;
  ELSE
    NEW.reminder_invoice_effective_since := NULL;
  END IF;
  IF TG_OP = 'INSERT' OR NEW.due_date IS DISTINCT FROM OLD.due_date OR OLD.reminder_schedule_effective_since IS NULL THEN
    NEW.reminder_schedule_effective_since := v_now;
  ELSE
    NEW.reminder_schedule_effective_since := OLD.reminder_schedule_effective_since;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER invoice_reminder_epochs BEFORE INSERT OR UPDATE ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.stamp_invoice_reminder_epochs();
REVOKE ALL ON FUNCTION public.stamp_invoice_reminder_epochs() FROM PUBLIC, anon, authenticated;
