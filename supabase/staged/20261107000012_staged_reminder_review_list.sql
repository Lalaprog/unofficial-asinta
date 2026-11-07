-- STAGED ONLY. Service-role access after Founder and assurance checks. Lists
-- currently held coordinated reservations, including client-only SMS. Legacy
-- logs are not included; they require a separate reconciliation workflow.
CREATE FUNCTION public.list_reminder_delivery_reviews_needed(p_actor uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_rows jsonb;v_count bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.users WHERE id=p_actor AND role='founder') THEN RETURN NULL; END IF;
  WITH active AS (
    SELECT a.attempt_id,a.invoice_id,a.client_id,a.channel,a.source,a.state,a.created_at
      FROM public.reminder_delivery_attempts a JOIN public.reminder_delivery_locks l ON l.active_attempt_id=a.attempt_id
      WHERE a.state IN ('reserved','unconfirmed')
    UNION ALL
    SELECT a.attempt_id,a.invoice_id,a.client_id,a.channel,a.source,a.state,a.created_at
      FROM public.reminder_delivery_attempts a JOIN public.reminder_sms_client_locks l ON l.active_attempt_id=a.attempt_id
      WHERE a.invoice_id IS NULL AND a.state IN ('reserved','unconfirmed')
  ), numbered AS (
    SELECT a.*,i.invoice_number,c.name AS client_name,count(*) over() AS total
      FROM active a LEFT JOIN public.invoices i ON i.id=a.invoice_id
      LEFT JOIN public.clients c ON c.id=coalesce(a.client_id,i.client_id)
      ORDER BY a.created_at,a.attempt_id LIMIT 100
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object('attemptId',attempt_id,'invoiceId',invoice_id,'clientId',client_id,
    'channel',channel,'source',source,'state',state,'createdAt',created_at,'invoiceNumber',invoice_number,'clientName',client_name)
    ORDER BY created_at,attempt_id),'[]'::jsonb),coalesce(max(total),0) INTO v_rows,v_count FROM numbered;
  RETURN jsonb_build_object('attempts',v_rows,'hasMore',v_count>100);
END;
$$;
REVOKE ALL ON FUNCTION public.list_reminder_delivery_reviews_needed(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.list_reminder_delivery_reviews_needed(uuid) TO service_role;

CREATE FUNCTION public.list_legacy_reminder_reviews_needed(p_actor uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_rows jsonb;v_count bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.users WHERE id=p_actor AND role='founder') THEN RETURN NULL; END IF;
  WITH ambiguous AS (
    SELECT 'email_log'::text kind,e.id record_id,e.invoice_id,'email'::text channel,e.status,e.created_at,e.recipient contact
      FROM public.email_logs e WHERE e.reminder_attempt_id IS NULL AND (e.status IN ('pending','failed') OR (e.status IN ('accepted','delivered','bounced') AND e.sent_at IS NULL))
    UNION ALL
    SELECT 'sms_log',s.id,s.invoice_id,'sms',s.status,s.sent_at,s.phone
      FROM public.sms_logs s WHERE s.reminder_attempt_id IS NULL AND s.simulated IS NOT TRUE AND (s.status IN ('pending','failed') OR (s.status IN ('sent','delivered') AND s.sent_at IS NULL))
    UNION ALL
    SELECT 'dispatch',d.id,d.invoice_id,d.channel,d.status,d.created_at,NULL::text
      FROM public.reminder_dispatches d WHERE d.status IN ('pending','failed') OR (d.status='sent' AND d.sent_at IS NULL)
  ), unreviewed AS (
    SELECT a.*,i.invoice_number,c.name client_name,count(*) over() total
      FROM ambiguous a LEFT JOIN public.invoices i ON i.id=a.invoice_id LEFT JOIN public.clients c ON c.id=i.client_id
      WHERE NOT EXISTS (SELECT 1 FROM public.reminder_legacy_reviews r WHERE r.kind=a.kind AND r.record_id=a.record_id AND r.observed_status=a.status)
      ORDER BY a.created_at NULLS FIRST,a.kind,a.record_id LIMIT 100
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object('kind',kind,'recordId',record_id,'invoiceId',invoice_id,'channel',channel,'state',status,
    'createdAt',created_at,'contact',contact,'invoiceNumber',invoice_number,'clientName',client_name) ORDER BY created_at NULLS FIRST,kind,record_id),'[]'::jsonb),coalesce(max(total),0)
    INTO v_rows,v_count FROM unreviewed;
  RETURN jsonb_build_object('records',v_rows,'hasMore',v_count>100);
END;
$$;
REVOKE ALL ON FUNCTION public.list_legacy_reminder_reviews_needed(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.list_legacy_reminder_reviews_needed(uuid) TO service_role;
