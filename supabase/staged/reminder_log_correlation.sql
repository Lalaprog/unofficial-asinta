-- STAGED ONLY: apply after the coordination table, before history aggregation.
-- A provider log associated with a coordinator attempt can be interpreted in
-- context. Old logs remain unlinked and conservatively treated as ambiguous.
ALTER TABLE public.email_logs ADD COLUMN reminder_attempt_id uuid REFERENCES public.reminder_delivery_attempts(attempt_id) ON DELETE SET NULL;
ALTER TABLE public.sms_logs ADD COLUMN reminder_attempt_id uuid REFERENCES public.reminder_delivery_attempts(attempt_id) ON DELETE SET NULL;
CREATE UNIQUE INDEX email_log_reminder_attempt_unique ON public.email_logs(reminder_attempt_id) WHERE reminder_attempt_id IS NOT NULL;
CREATE UNIQUE INDEX sms_log_reminder_attempt_unique ON public.sms_logs(reminder_attempt_id) WHERE reminder_attempt_id IS NOT NULL;
