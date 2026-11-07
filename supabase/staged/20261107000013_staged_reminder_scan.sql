-- STAGED ONLY. Fair, bounded scanner: callers process one invoice at a time;
-- a cursor prevents large lists from permanently starving later invoices.
-- Claiming a candidate is not permission to send. A lost response only delays
-- this invoice until the cursor wraps; normal eligibility/locks still apply.
CREATE TABLE public.reminder_scan_cursor(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),last_invoice_id uuid);
INSERT INTO public.reminder_scan_cursor(singleton,last_invoice_id) VALUES(true,NULL);
ALTER TABLE public.reminder_scan_cursor ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.reminder_scan_cursor FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.next_reminder_scan_invoice() RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_last uuid;v_next uuid;
BEGIN
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'REMINDER_SCAN_REQUIRES_READ_COMMITTED' USING ERRCODE='P1002'; END IF;
  SELECT last_invoice_id INTO v_last FROM public.reminder_scan_cursor WHERE singleton=true FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Reminder scan cursor unavailable' USING ERRCODE='55000'; END IF;
  SELECT id INTO v_next FROM public.invoices WHERE automatic_reminders_enabled IS TRUE AND status IN ('pending','partially_paid','overdue') AND (v_last IS NULL OR id>v_last) ORDER BY id LIMIT 1;
  IF v_next IS NULL AND v_last IS NOT NULL THEN
    SELECT id INTO v_next FROM public.invoices WHERE automatic_reminders_enabled IS TRUE AND status IN ('pending','partially_paid','overdue') ORDER BY id LIMIT 1;
  END IF;
  UPDATE public.reminder_scan_cursor SET last_invoice_id=v_next WHERE singleton=true;
  RETURN v_next;
END;
$$;
REVOKE ALL ON FUNCTION public.next_reminder_scan_invoice() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.next_reminder_scan_invoice() TO service_role;
