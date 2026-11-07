-- STAGED ONLY: a bounded-by-database aggregate, not permission to send. Manual
-- and scheduled paths must share reservations before this can be authoritative.
-- In particular, SMS sent only by client ID is not associated with an invoice;
-- older failed/pending rows can be ambiguous and deliberately block catch-up.
-- A historical reconciliation workflow is still required before live rollout.
CREATE FUNCTION public.read_reminder_contact_history(p_invoice_id uuid, p_channel text, p_own_attempt uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_latest timestamptz; v_unresolved boolean; v_legacy_latest timestamptz; v_legacy_unknown boolean;
BEGIN
  IF p_invoice_id IS NULL OR p_channel IS NULL OR p_channel NOT IN ('email','sms')
    OR NOT EXISTS (SELECT 1 FROM public.invoices WHERE id=p_invoice_id) THEN RETURN NULL; END IF;
  SELECT max(updated_at) FILTER (WHERE state='accepted'),
         coalesce(bool_or(a.state = 'unconfirmed' OR (a.state = 'reserved' AND (
           a.attempt_id = p_own_attempt AND EXISTS (SELECT 1 FROM public.reminder_delivery_locks l
             WHERE l.invoice_id=p_invoice_id AND l.channel=p_channel AND l.active_attempt_id=a.attempt_id)
         ) IS NOT TRUE)),false)
    INTO v_latest,v_unresolved FROM public.reminder_delivery_attempts a
    WHERE a.invoice_id=p_invoice_id AND a.channel=p_channel;
  IF p_channel='email' THEN
    SELECT greatest(max(e.sent_at) FILTER (WHERE e.status IN ('accepted','delivered','bounced')),max(lr.reviewed_at) FILTER (WHERE lr.outcome='accepted')),
           coalesce(bool_or(
             (e.status='pending' AND (a.state='reserved' AND a.attempt_id=p_own_attempt AND EXISTS
               (SELECT 1 FROM public.reminder_delivery_locks l WHERE l.invoice_id=p_invoice_id AND l.channel=p_channel AND l.active_attempt_id=a.attempt_id)) IS NOT TRUE
               AND (a.state='cancelled' OR EXISTS (SELECT 1 FROM public.reminder_delivery_reviews r WHERE r.attempt_id=a.attempt_id AND r.outcome=a.state) OR lr.record_id IS NOT NULL) IS NOT TRUE)
             OR (e.status='failed' AND (a.state IN ('rejected','cancelled') OR EXISTS (SELECT 1 FROM public.reminder_delivery_reviews r WHERE r.attempt_id=a.attempt_id AND r.outcome=a.state) OR lr.record_id IS NOT NULL) IS NOT TRUE)
             OR (e.status IN ('accepted','delivered','bounced') AND e.sent_at IS NULL AND lr.record_id IS NULL)
           ),false)
      INTO v_legacy_latest,v_legacy_unknown FROM public.email_logs e
      LEFT JOIN public.reminder_delivery_attempts a ON a.attempt_id=e.reminder_attempt_id AND a.invoice_id=e.invoice_id AND a.channel='email'
      LEFT JOIN public.reminder_legacy_reviews lr ON lr.kind='email_log' AND lr.record_id=e.id AND lr.observed_status=e.status AND e.reminder_attempt_id IS NULL
      WHERE e.invoice_id=p_invoice_id;
  ELSE
    SELECT greatest(max(greatest(s.sent_at,s.updated_at)) FILTER (WHERE s.status IN ('sent','delivered') AND s.simulated IS FALSE),max(lr.reviewed_at) FILTER (WHERE lr.outcome='accepted')),
           coalesce(bool_or(s.simulated IS NOT TRUE AND (
             (s.status='pending' AND (a.state='reserved' AND a.attempt_id=p_own_attempt AND EXISTS
               (SELECT 1 FROM public.reminder_delivery_locks l WHERE l.invoice_id=p_invoice_id AND l.channel=p_channel AND l.active_attempt_id=a.attempt_id)) IS NOT TRUE
               AND (a.state='cancelled' OR EXISTS (SELECT 1 FROM public.reminder_delivery_reviews r WHERE r.attempt_id=a.attempt_id AND r.outcome=a.state) OR lr.record_id IS NOT NULL) IS NOT TRUE)
             OR (s.status='failed' AND (a.state IN ('rejected','cancelled') OR EXISTS (SELECT 1 FROM public.reminder_delivery_reviews r WHERE r.attempt_id=a.attempt_id AND r.outcome=a.state) OR lr.record_id IS NOT NULL) IS NOT TRUE)
             OR (s.status IN ('sent','delivered') AND s.sent_at IS NULL AND lr.record_id IS NULL)
           )),false)
      INTO v_legacy_latest,v_legacy_unknown FROM public.sms_logs s
      LEFT JOIN public.reminder_delivery_attempts a ON a.attempt_id=s.reminder_attempt_id AND a.invoice_id=s.invoice_id AND a.channel='sms'
      LEFT JOIN public.reminder_legacy_reviews lr ON lr.kind='sms_log' AND lr.record_id=s.id AND lr.observed_status=s.status AND s.reminder_attempt_id IS NULL
      WHERE s.invoice_id=p_invoice_id;
  END IF;
  v_latest := greatest(v_latest,v_legacy_latest);
  v_unresolved := v_unresolved OR v_legacy_unknown;
  SELECT greatest(max(d.sent_at) FILTER (WHERE d.status='sent'),max(lr.reviewed_at) FILTER (WHERE lr.outcome='accepted')),
         coalesce(bool_or((d.status IN ('pending','failed') OR (d.status='sent' AND d.sent_at IS NULL)) AND lr.record_id IS NULL),false)
    INTO v_legacy_latest,v_legacy_unknown FROM public.reminder_dispatches d
    LEFT JOIN public.reminder_legacy_reviews lr ON lr.kind='dispatch' AND lr.record_id=d.id AND lr.observed_status=d.status
    WHERE d.invoice_id=p_invoice_id AND d.channel=p_channel;
  RETURN jsonb_build_object('lastContactAt',greatest(v_latest,v_legacy_latest),
    'unresolvedAttempt',v_unresolved OR v_legacy_unknown);
END;
$$;
REVOKE ALL ON FUNCTION public.read_reminder_contact_history(uuid,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.read_reminder_contact_history(uuid,text,uuid) TO service_role;
