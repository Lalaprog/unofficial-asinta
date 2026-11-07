-- STAGED ONLY. Apply after coordination + review, before wiring ANY sender.
-- Serializes all app SMS for a client (including client-only messages and
-- different invoices), while email remains independently locked per invoice.
-- Legacy messages, other applications and old app deployments still need a
-- separate history/rollout review. Never auto-expire a client lock.
ALTER TABLE public.reminder_delivery_attempts ALTER COLUMN invoice_id DROP NOT NULL;
ALTER TABLE public.reminder_delivery_attempts ADD COLUMN client_id uuid;
CREATE INDEX reminder_attempts_sms_client ON public.reminder_delivery_attempts (client_id,updated_at DESC) WHERE channel='sms';
ALTER TABLE public.sms_logs ADD COLUMN client_id uuid;
CREATE INDEX sms_logs_client_time ON public.sms_logs(client_id,sent_at DESC);
CREATE TABLE public.reminder_sms_client_locks (
  client_id uuid PRIMARY KEY REFERENCES public.clients(id) ON DELETE RESTRICT,
  active_attempt_id uuid REFERENCES public.reminder_delivery_attempts(attempt_id) ON DELETE SET NULL
);
ALTER TABLE public.reminder_sms_client_locks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.reminder_sms_client_locks FROM PUBLIC,anon,authenticated,service_role;

-- Preserve the original invoice lock code internally, but never leave a
-- publicly callable way around the client-level lock.
ALTER FUNCTION public.reserve_reminder_delivery(uuid,text,text,uuid) RENAME TO reserve_reminder_invoice_internal;
ALTER FUNCTION public.finish_reminder_delivery(uuid,text,uuid,text) RENAME TO finish_reminder_invoice_internal;
ALTER FUNCTION public.review_reminder_delivery(uuid,uuid,text,uuid,text,text,boolean) RENAME TO review_reminder_invoice_internal;
REVOKE ALL ON FUNCTION public.reserve_reminder_invoice_internal(uuid,text,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.finish_reminder_invoice_internal(uuid,text,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.review_reminder_invoice_internal(uuid,uuid,text,uuid,text,text,boolean) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.reserve_reminder_delivery(p_invoice_id uuid,p_channel text,p_source text,p_attempt_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_client uuid;v_active uuid;v_result text;
BEGIN
  IF p_channel IS DISTINCT FROM 'sms' THEN RETURN public.reserve_reminder_invoice_internal(p_invoice_id,p_channel,p_source,p_attempt_id); END IF;
  IF p_invoice_id IS NULL OR p_attempt_id IS NULL OR p_source IS NULL OR p_source NOT IN ('manual','automatic') THEN RETURN 'invalid'; END IF;
  SELECT client_id INTO v_client FROM public.invoices WHERE id=p_invoice_id FOR SHARE;
  IF v_client IS NULL THEN RETURN 'invalid'; END IF;
  INSERT INTO public.reminder_sms_client_locks(client_id) VALUES(v_client) ON CONFLICT DO NOTHING;
  SELECT active_attempt_id INTO v_active FROM public.reminder_sms_client_locks WHERE client_id=v_client FOR UPDATE;
  IF v_active IS NOT NULL THEN RETURN 'busy'; END IF;
  v_result:=public.reserve_reminder_invoice_internal(p_invoice_id,p_channel,p_source,p_attempt_id);
  IF v_result='reserved' THEN
    UPDATE public.reminder_delivery_attempts SET client_id=v_client WHERE attempt_id=p_attempt_id;
    UPDATE public.reminder_sms_client_locks SET active_attempt_id=p_attempt_id WHERE client_id=v_client;
  ELSE DELETE FROM public.reminder_sms_client_locks WHERE client_id=v_client AND active_attempt_id IS NULL;
  END IF;
  RETURN v_result;
END;
$$;

CREATE FUNCTION public.reserve_client_sms_delivery(p_client_id uuid,p_attempt_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_active uuid;v_created uuid;
BEGIN
  IF p_client_id IS NULL OR p_attempt_id IS NULL THEN RETURN 'invalid'; END IF;
  INSERT INTO public.reminder_sms_client_locks(client_id) VALUES(p_client_id) ON CONFLICT DO NOTHING;
  SELECT active_attempt_id INTO v_active FROM public.reminder_sms_client_locks WHERE client_id=p_client_id FOR UPDATE;
  IF v_active IS NOT NULL THEN RETURN 'busy'; END IF;
  INSERT INTO public.reminder_delivery_attempts(attempt_id,invoice_id,client_id,channel,source,state)
    VALUES(p_attempt_id,NULL,p_client_id,'sms','manual','reserved') ON CONFLICT (attempt_id) DO NOTHING RETURNING attempt_id INTO v_created;
  IF v_created IS NULL THEN
    DELETE FROM public.reminder_sms_client_locks WHERE client_id=p_client_id AND active_attempt_id IS NULL;
    RETURN 'duplicate';
  END IF;
  UPDATE public.reminder_sms_client_locks SET active_attempt_id=p_attempt_id WHERE client_id=p_client_id;
  RETURN 'reserved';
END;
$$;

CREATE FUNCTION public.finish_reminder_delivery(p_invoice_id uuid,p_channel text,p_attempt_id uuid,p_outcome text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_client uuid;v_active uuid;v_result boolean;
BEGIN
  IF p_channel IS DISTINCT FROM 'sms' THEN
    v_result:=public.finish_reminder_invoice_internal(p_invoice_id,p_channel,p_attempt_id,p_outcome);
    IF v_result AND p_outcome='cancelled' THEN DELETE FROM public.reminder_delivery_slots WHERE attempt_id=p_attempt_id; END IF;
    RETURN v_result;
  END IF;
  SELECT client_id INTO v_client FROM public.reminder_delivery_attempts WHERE attempt_id=p_attempt_id AND invoice_id=p_invoice_id AND channel='sms';
  IF v_client IS NULL THEN RETURN false; END IF;
  SELECT active_attempt_id INTO v_active FROM public.reminder_sms_client_locks WHERE client_id=v_client FOR UPDATE;
  IF v_active IS DISTINCT FROM p_attempt_id THEN RETURN false; END IF;
  v_result:=public.finish_reminder_invoice_internal(p_invoice_id,p_channel,p_attempt_id,p_outcome);
  IF v_result AND p_outcome='cancelled' THEN DELETE FROM public.reminder_delivery_slots WHERE attempt_id=p_attempt_id; END IF;
  IF v_result AND p_outcome<>'unconfirmed' THEN DELETE FROM public.reminder_sms_client_locks WHERE client_id=v_client; END IF;
  RETURN v_result;
END;
$$;

CREATE FUNCTION public.finish_client_sms_delivery(p_client_id uuid,p_attempt_id uuid,p_outcome text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_active uuid;v_updated uuid;
BEGIN
  IF p_client_id IS NULL OR p_attempt_id IS NULL OR p_outcome IS NULL OR p_outcome NOT IN ('accepted','rejected','cancelled','unconfirmed') THEN RETURN false; END IF;
  SELECT active_attempt_id INTO v_active FROM public.reminder_sms_client_locks WHERE client_id=p_client_id FOR UPDATE;
  IF v_active IS DISTINCT FROM p_attempt_id THEN RETURN false; END IF;
  UPDATE public.reminder_delivery_attempts SET state=p_outcome,updated_at=clock_timestamp()
    WHERE attempt_id=p_attempt_id AND invoice_id IS NULL AND client_id=p_client_id AND channel='sms' AND state='reserved'
    RETURNING attempt_id INTO v_updated;
  IF v_updated IS NULL THEN RETURN false; END IF;
  IF p_outcome<>'unconfirmed' THEN DELETE FROM public.reminder_sms_client_locks WHERE client_id=p_client_id; END IF;
  RETURN true;
END;
$$;

CREATE FUNCTION public.review_reminder_delivery(p_actor uuid,p_invoice_id uuid,p_channel text,p_attempt_id uuid,p_outcome text,p_evidence text,p_confirm_no_sender_running boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_client uuid;v_active uuid;v_result boolean;
BEGIN
  IF p_channel IS DISTINCT FROM 'sms' THEN
    v_result:=public.review_reminder_invoice_internal(p_actor,p_invoice_id,p_channel,p_attempt_id,p_outcome,p_evidence,p_confirm_no_sender_running);
    IF v_result AND p_outcome='cancelled' THEN DELETE FROM public.reminder_delivery_slots WHERE attempt_id=p_attempt_id; END IF;
    RETURN v_result;
  END IF;
  SELECT client_id INTO v_client FROM public.reminder_delivery_attempts WHERE attempt_id=p_attempt_id AND invoice_id=p_invoice_id AND channel='sms';
  IF v_client IS NULL THEN RETURN false; END IF;
  -- Same order as reservation and completion: client, then invoice.
  -- Serialize Founder mutations first, as the internal review does.
  PERFORM app_private.lock_founder_guard();
  SELECT active_attempt_id INTO v_active FROM public.reminder_sms_client_locks WHERE client_id=v_client FOR UPDATE;
  IF v_active IS DISTINCT FROM p_attempt_id THEN RETURN false; END IF;
  v_result:=public.review_reminder_invoice_internal(p_actor,p_invoice_id,p_channel,p_attempt_id,p_outcome,p_evidence,p_confirm_no_sender_running);
  IF v_result AND p_outcome='cancelled' THEN DELETE FROM public.reminder_delivery_slots WHERE attempt_id=p_attempt_id; END IF;
  IF v_result THEN DELETE FROM public.reminder_sms_client_locks WHERE client_id=v_client; END IF;
  RETURN v_result;
END;
$$;

CREATE FUNCTION public.review_client_sms_delivery(p_actor uuid,p_client_id uuid,p_attempt_id uuid,p_outcome text,p_evidence text,p_confirm_no_sender_running boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_active uuid;v_state text;
BEGIN
  IF p_actor IS NULL OR p_client_id IS NULL OR p_attempt_id IS NULL OR p_outcome IS NULL OR p_outcome NOT IN ('accepted','rejected','cancelled') OR
     p_evidence IS NULL OR char_length(btrim(p_evidence)) NOT BETWEEN 20 AND 500 OR p_confirm_no_sender_running IS DISTINCT FROM true THEN RETURN false; END IF;
  PERFORM app_private.lock_founder_guard();
  IF NOT EXISTS (SELECT 1 FROM public.users WHERE id=p_actor AND role='founder') THEN RETURN false; END IF;
  SELECT active_attempt_id INTO v_active FROM public.reminder_sms_client_locks WHERE client_id=p_client_id FOR UPDATE;
  IF v_active IS DISTINCT FROM p_attempt_id THEN RETURN false; END IF;
  SELECT state INTO v_state FROM public.reminder_delivery_attempts WHERE attempt_id=p_attempt_id AND client_id=p_client_id AND invoice_id IS NULL AND channel='sms' FOR UPDATE;
  IF v_state IS NULL OR v_state NOT IN ('reserved','unconfirmed') THEN RETURN false; END IF;
  INSERT INTO public.reminder_delivery_reviews(attempt_id,reviewer_id,previous_state,outcome,evidence) VALUES(p_attempt_id,p_actor,v_state,p_outcome,btrim(p_evidence));
  UPDATE public.reminder_delivery_attempts SET state=p_outcome,updated_at=clock_timestamp() WHERE attempt_id=p_attempt_id;
  DELETE FROM public.reminder_sms_client_locks WHERE client_id=p_client_id;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.reserve_reminder_delivery(uuid,text,text,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.reserve_client_sms_delivery(uuid,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.finish_reminder_delivery(uuid,text,uuid,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.finish_client_sms_delivery(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.review_reminder_delivery(uuid,uuid,text,uuid,text,text,boolean) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.review_client_sms_delivery(uuid,uuid,uuid,text,text,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_reminder_delivery(uuid,text,text,uuid),public.reserve_client_sms_delivery(uuid,uuid),public.finish_reminder_delivery(uuid,text,uuid,text),public.finish_client_sms_delivery(uuid,uuid,text),public.review_reminder_delivery(uuid,uuid,text,uuid,text,text,boolean),public.review_client_sms_delivery(uuid,uuid,uuid,text,text,boolean) TO service_role;

-- Extend the existing conservative invoice history to include all recorded SMS
-- for the client. Legacy unlinked SMS cannot be reliably attributed after a
-- phone change or invoice deletion, so they are conservatively considered for
-- every client until reviewed. This can pause more reminders than necessary.
ALTER FUNCTION public.read_reminder_contact_history(uuid,text,uuid) RENAME TO read_reminder_invoice_history_internal;
REVOKE ALL ON FUNCTION public.read_reminder_invoice_history_internal(uuid,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.read_reminder_contact_history(p_invoice_id uuid,p_channel text,p_own_attempt uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_base jsonb;v_client uuid;v_client_history jsonb;
BEGIN
  v_base:=public.read_reminder_invoice_history_internal(p_invoice_id,p_channel,p_own_attempt);
  IF v_base IS NULL OR p_channel IS DISTINCT FROM 'sms' THEN RETURN v_base; END IF;
  SELECT client_id INTO v_client FROM public.invoices WHERE id=p_invoice_id;
  IF v_client IS NULL THEN RETURN NULL; END IF;
  v_client_history:=public.read_client_sms_history(v_client,p_own_attempt);
  IF v_client_history IS NULL THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('lastContactAt',greatest((v_base->>'lastContactAt')::timestamptz,(v_client_history->>'lastContactAt')::timestamptz),
    'unresolvedAttempt',(v_base->>'unresolvedAttempt')::boolean OR (v_client_history->>'unresolvedAttempt')::boolean);
END;
$$;
REVOKE ALL ON FUNCTION public.read_reminder_contact_history(uuid,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.read_reminder_contact_history(uuid,text,uuid) TO service_role;

-- Also works for clients with no invoices, for Founder-initiated client SMS.
CREATE FUNCTION public.read_client_sms_history(p_client_id uuid,p_own_attempt uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_latest timestamptz;v_unknown boolean;v_time timestamptz;v_more boolean;
BEGIN
  IF p_client_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.clients WHERE id=p_client_id) THEN RETURN NULL; END IF;
  SELECT max(a.updated_at) FILTER (WHERE a.state='accepted'),coalesce(bool_or(a.state='unconfirmed' OR
    (a.state='reserved' AND (a.attempt_id=p_own_attempt AND EXISTS (SELECT 1 FROM public.reminder_sms_client_locks l
      WHERE l.client_id=p_client_id AND l.active_attempt_id=a.attempt_id)) IS NOT TRUE)),false)
    INTO v_latest,v_unknown FROM public.reminder_delivery_attempts a WHERE a.client_id=p_client_id AND a.channel='sms';
  SELECT greatest(max(greatest(s.sent_at,s.updated_at)) FILTER (WHERE s.status IN ('sent','delivered') AND s.simulated IS FALSE),max(lr.reviewed_at) FILTER (WHERE lr.outcome='accepted')),
    coalesce(bool_or(s.simulated IS NOT TRUE AND (
      (s.status='pending' AND (a.state='reserved' AND a.attempt_id=p_own_attempt AND EXISTS
        (SELECT 1 FROM public.reminder_sms_client_locks l WHERE l.client_id=p_client_id AND l.active_attempt_id=a.attempt_id)) IS NOT TRUE
        AND (a.state='cancelled' OR EXISTS (SELECT 1 FROM public.reminder_delivery_reviews r WHERE r.attempt_id=a.attempt_id AND r.outcome=a.state) OR lr.record_id IS NOT NULL) IS NOT TRUE)
      OR (s.status='failed' AND (a.state IN ('rejected','cancelled') OR EXISTS (SELECT 1 FROM public.reminder_delivery_reviews r WHERE r.attempt_id=a.attempt_id AND r.outcome=a.state) OR lr.record_id IS NOT NULL) IS NOT TRUE)
      OR (s.status IN ('sent','delivered') AND s.sent_at IS NULL AND lr.record_id IS NULL)
    )),false) INTO v_time,v_more FROM public.sms_logs s LEFT JOIN public.invoices i ON i.id=s.invoice_id
    LEFT JOIN public.reminder_delivery_attempts a ON a.attempt_id=s.reminder_attempt_id AND a.channel='sms' AND a.client_id=p_client_id
      AND a.invoice_id IS NOT DISTINCT FROM s.invoice_id AND (s.client_id IS NULL OR s.client_id=a.client_id)
    LEFT JOIN public.reminder_legacy_reviews lr ON lr.kind='sms_log' AND lr.record_id=s.id AND lr.observed_status=s.status AND s.reminder_attempt_id IS NULL
    WHERE s.client_id=p_client_id OR i.client_id=p_client_id OR a.client_id=p_client_id OR
      (s.client_id IS NULL AND i.client_id IS NULL AND a.client_id IS NULL);
  v_latest:=greatest(v_latest,v_time);v_unknown:=v_unknown OR v_more;
  SELECT greatest(max(d.sent_at) FILTER (WHERE d.status='sent'),max(lr.reviewed_at) FILTER (WHERE lr.outcome='accepted')),coalesce(bool_or((d.status IN ('pending','failed') OR (d.status='sent' AND d.sent_at IS NULL)) AND lr.record_id IS NULL),false)
    INTO v_time,v_more FROM public.reminder_dispatches d JOIN public.invoices i ON i.id=d.invoice_id
    LEFT JOIN public.reminder_legacy_reviews lr ON lr.kind='dispatch' AND lr.record_id=d.id AND lr.observed_status=d.status WHERE i.client_id=p_client_id AND d.channel='sms';
  RETURN jsonb_build_object('lastContactAt',greatest(v_latest,v_time),'unresolvedAttempt',v_unknown OR v_more);
END;
$$;
REVOKE ALL ON FUNCTION public.read_client_sms_history(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.read_client_sms_history(uuid,uuid) TO service_role;

-- Additional per-recipient protection across different client records and
-- invoices. This stage is still unhosted and must be installed before traffic.
-- The key is the exact normalized destination (no provider-specific alias
-- guessing); stale or unparseable destinations fail closed.
ALTER TABLE public.reminder_delivery_attempts ADD COLUMN recipient_key text;
CREATE INDEX reminder_attempts_recipient_time ON public.reminder_delivery_attempts(channel,recipient_key,updated_at DESC);
CREATE TABLE public.reminder_recipient_locks (
  channel text NOT NULL CHECK(channel IN ('email','sms')),
  recipient_key text NOT NULL,
  active_attempt_id uuid NOT NULL REFERENCES public.reminder_delivery_attempts(attempt_id) ON DELETE RESTRICT,
  PRIMARY KEY(channel,recipient_key)
);
ALTER TABLE public.reminder_recipient_locks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.reminder_recipient_locks FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION app_private.reminder_recipient_key(p_channel text,p_value text) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE v text;
BEGIN
  IF p_channel='email' THEN
    v:=pg_catalog.lower(pg_catalog.btrim(p_value));
    -- This is deliberately at least as restrictive as the app's recipient
    -- validation. Case-folding errs on the side of coordination, not duplicates.
    IF v IS NULL OR pg_catalog.length(v)>254 OR v !~ '^[a-z0-9.!#$%&''*+/=?^_`{|}~-]+@[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$' THEN RETURN NULL; END IF;
    RETURN v;
  ELSIF p_channel='sms' THEN
    v:=pg_catalog.regexp_replace(p_value,'[[:space:]().-]','','g');
    IF v ~ '^\+639[0-9]{9}$' THEN RETURN v; END IF;
    IF v ~ '^639[0-9]{9}$' THEN RETURN '+' || v; END IF;
    IF v ~ '^09[0-9]{9}$' THEN RETURN '+63' || pg_catalog.substr(v,2); END IF;
    IF v ~ '^9[0-9]{9}$' THEN RETURN '+63' || v; END IF;
    RETURN NULL;
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION app_private.reminder_recipient_key(text,text) FROM PUBLIC,anon,authenticated,service_role;

-- Wrap the client/invoice locks. A temporary sentinel is not needed: the
-- recipient lock row is inserted after an attempt is created, but both actions
-- are protected by the same transaction-scoped advisory lock. Advisory locks
-- are keyed from channel + normalized destination, and collisions only cause
-- extra serialization. We never rely on a timeout for an active recipient.
ALTER FUNCTION public.reserve_reminder_delivery(uuid,text,text,uuid) RENAME TO reserve_reminder_client_internal;
ALTER FUNCTION public.reserve_client_sms_delivery(uuid,uuid) RENAME TO reserve_client_sms_internal;
ALTER FUNCTION public.finish_reminder_delivery(uuid,text,uuid,text) RENAME TO finish_reminder_client_internal;
ALTER FUNCTION public.finish_client_sms_delivery(uuid,uuid,text) RENAME TO finish_client_sms_internal;
ALTER FUNCTION public.review_reminder_delivery(uuid,uuid,text,uuid,text,text,boolean) RENAME TO review_reminder_client_internal;
ALTER FUNCTION public.review_client_sms_delivery(uuid,uuid,uuid,text,text,boolean) RENAME TO review_client_sms_internal;
REVOKE ALL ON FUNCTION public.reserve_reminder_client_internal(uuid,text,text,uuid),public.reserve_client_sms_internal(uuid,uuid),public.finish_reminder_client_internal(uuid,text,uuid,text),public.finish_client_sms_internal(uuid,uuid,text),public.review_reminder_client_internal(uuid,uuid,text,uuid,text,text,boolean),public.review_client_sms_internal(uuid,uuid,uuid,text,text,boolean) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.reserve_reminder_delivery(p_invoice_id uuid,p_channel text,p_source text,p_attempt_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_key text;v_result text;
BEGIN
  IF p_channel IS NULL OR p_channel NOT IN ('email','sms') OR p_invoice_id IS NULL OR p_attempt_id IS NULL THEN RETURN 'invalid'; END IF;
  SELECT app_private.reminder_recipient_key(p_channel,CASE WHEN p_channel='email' THEN c.email ELSE c.phone END)
    INTO v_key FROM public.invoices i JOIN public.clients c ON c.id=i.client_id WHERE i.id=p_invoice_id FOR SHARE OF i,c;
  IF v_key IS NULL THEN RETURN 'invalid'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_channel||':'||v_key,719835));
  IF EXISTS(SELECT 1 FROM public.reminder_recipient_locks WHERE channel=p_channel AND recipient_key=v_key) THEN RETURN 'busy'; END IF;
  v_result:=public.reserve_reminder_client_internal(p_invoice_id,p_channel,p_source,p_attempt_id);
  IF v_result='reserved' THEN
    UPDATE public.reminder_delivery_attempts SET recipient_key=v_key WHERE attempt_id=p_attempt_id;
    INSERT INTO public.reminder_recipient_locks(channel,recipient_key,active_attempt_id) VALUES(p_channel,v_key,p_attempt_id);
  END IF;
  RETURN v_result;
END;
$$;
CREATE FUNCTION public.reserve_client_sms_delivery(p_client_id uuid,p_attempt_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_key text;v_result text;
BEGIN
  IF p_client_id IS NULL OR p_attempt_id IS NULL THEN RETURN 'invalid'; END IF;
  SELECT app_private.reminder_recipient_key('sms',phone) INTO v_key FROM public.clients WHERE id=p_client_id FOR SHARE;
  IF v_key IS NULL THEN RETURN 'invalid'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('sms:'||v_key,719835));
  IF EXISTS(SELECT 1 FROM public.reminder_recipient_locks WHERE channel='sms' AND recipient_key=v_key) THEN RETURN 'busy'; END IF;
  v_result:=public.reserve_client_sms_internal(p_client_id,p_attempt_id);
  IF v_result='reserved' THEN
    UPDATE public.reminder_delivery_attempts SET recipient_key=v_key WHERE attempt_id=p_attempt_id;
    INSERT INTO public.reminder_recipient_locks(channel,recipient_key,active_attempt_id) VALUES('sms',v_key,p_attempt_id);
  END IF;
  RETURN v_result;
END;
$$;

-- All completion/review operations acquire the recipient lock first, then the
-- client/invoice locks used internally. A failed transaction retains the
-- lock; a committed cancellation/rejection/acceptance releases it atomically.
-- A lost response after commit can leave the caller unsure even though it released.
CREATE FUNCTION public.finish_reminder_delivery(p_invoice_id uuid,p_channel text,p_attempt_id uuid,p_outcome text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_key text;v_active uuid;v_result boolean;
BEGIN
  SELECT recipient_key INTO v_key FROM public.reminder_delivery_attempts WHERE attempt_id=p_attempt_id AND invoice_id=p_invoice_id AND channel=p_channel;
  IF v_key IS NULL THEN RETURN false; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_channel||':'||v_key,719835));
  SELECT active_attempt_id INTO v_active FROM public.reminder_recipient_locks WHERE channel=p_channel AND recipient_key=v_key FOR UPDATE;
  IF v_active IS DISTINCT FROM p_attempt_id THEN RETURN false; END IF;
  v_result:=public.finish_reminder_client_internal(p_invoice_id,p_channel,p_attempt_id,p_outcome);
  IF v_result AND p_outcome<>'unconfirmed' THEN DELETE FROM public.reminder_recipient_locks WHERE channel=p_channel AND recipient_key=v_key AND active_attempt_id=p_attempt_id; END IF;
  RETURN v_result;
END;
$$;
CREATE FUNCTION public.finish_client_sms_delivery(p_client_id uuid,p_attempt_id uuid,p_outcome text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_key text;v_active uuid;v_result boolean;
BEGIN
  SELECT recipient_key INTO v_key FROM public.reminder_delivery_attempts WHERE attempt_id=p_attempt_id AND invoice_id IS NULL AND client_id=p_client_id AND channel='sms';
  IF v_key IS NULL THEN RETURN false; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('sms:'||v_key,719835));
  SELECT active_attempt_id INTO v_active FROM public.reminder_recipient_locks WHERE channel='sms' AND recipient_key=v_key FOR UPDATE;
  IF v_active IS DISTINCT FROM p_attempt_id THEN RETURN false; END IF;
  v_result:=public.finish_client_sms_internal(p_client_id,p_attempt_id,p_outcome);
  IF v_result AND p_outcome<>'unconfirmed' THEN DELETE FROM public.reminder_recipient_locks WHERE channel='sms' AND recipient_key=v_key AND active_attempt_id=p_attempt_id; END IF;
  RETURN v_result;
END;
$$;
CREATE FUNCTION public.review_reminder_delivery(p_actor uuid,p_invoice_id uuid,p_channel text,p_attempt_id uuid,p_outcome text,p_evidence text,p_confirm_no_sender_running boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_key text;v_active uuid;v_result boolean;
BEGIN
  SELECT recipient_key INTO v_key FROM public.reminder_delivery_attempts WHERE attempt_id=p_attempt_id AND invoice_id=p_invoice_id AND channel=p_channel;
  IF v_key IS NULL THEN RETURN false; END IF;
  PERFORM app_private.lock_founder_guard();
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_channel||':'||v_key,719835));
  SELECT active_attempt_id INTO v_active FROM public.reminder_recipient_locks WHERE channel=p_channel AND recipient_key=v_key FOR UPDATE;
  IF v_active IS DISTINCT FROM p_attempt_id THEN RETURN false; END IF;
  v_result:=public.review_reminder_client_internal(p_actor,p_invoice_id,p_channel,p_attempt_id,p_outcome,p_evidence,p_confirm_no_sender_running);
  IF v_result THEN DELETE FROM public.reminder_recipient_locks WHERE channel=p_channel AND recipient_key=v_key AND active_attempt_id=p_attempt_id; END IF;
  RETURN v_result;
END;
$$;
CREATE FUNCTION public.review_client_sms_delivery(p_actor uuid,p_client_id uuid,p_attempt_id uuid,p_outcome text,p_evidence text,p_confirm_no_sender_running boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_key text;v_active uuid;v_result boolean;
BEGIN
  SELECT recipient_key INTO v_key FROM public.reminder_delivery_attempts WHERE attempt_id=p_attempt_id AND invoice_id IS NULL AND client_id=p_client_id AND channel='sms';
  IF v_key IS NULL THEN RETURN false; END IF;
  PERFORM app_private.lock_founder_guard();
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('sms:'||v_key,719835));
  SELECT active_attempt_id INTO v_active FROM public.reminder_recipient_locks WHERE channel='sms' AND recipient_key=v_key FOR UPDATE;
  IF v_active IS DISTINCT FROM p_attempt_id THEN RETURN false; END IF;
  v_result:=public.review_client_sms_internal(p_actor,p_client_id,p_attempt_id,p_outcome,p_evidence,p_confirm_no_sender_running);
  IF v_result THEN DELETE FROM public.reminder_recipient_locks WHERE channel='sms' AND recipient_key=v_key AND active_attempt_id=p_attempt_id; END IF;
  RETURN v_result;
END;
$$;
CREATE FUNCTION public.reminder_recipient_matches(p_attempt_id uuid,p_channel text,p_recipient text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT coalesce(EXISTS(SELECT 1 FROM public.reminder_delivery_attempts a JOIN public.reminder_recipient_locks l
    ON l.active_attempt_id=a.attempt_id AND l.channel=a.channel AND l.recipient_key=a.recipient_key
    WHERE a.attempt_id=p_attempt_id AND a.channel=p_channel AND a.state='reserved'
      AND a.recipient_key=app_private.reminder_recipient_key(p_channel,p_recipient)
      AND a.recipient_key=(SELECT app_private.reminder_recipient_key(p_channel,CASE WHEN p_channel='email' THEN c.email ELSE c.phone END) FROM public.clients c WHERE c.id=coalesce(a.client_id,(SELECT i.client_id FROM public.invoices i WHERE i.id=a.invoice_id)))),false);
$$;
REVOKE ALL ON FUNCTION public.reserve_reminder_delivery(uuid,text,text,uuid),public.reserve_client_sms_delivery(uuid,uuid),public.finish_reminder_delivery(uuid,text,uuid,text),public.finish_client_sms_delivery(uuid,uuid,text),public.review_reminder_delivery(uuid,uuid,text,uuid,text,text,boolean),public.review_client_sms_delivery(uuid,uuid,uuid,text,text,boolean),public.reminder_recipient_matches(uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_reminder_delivery(uuid,text,text,uuid),public.reserve_client_sms_delivery(uuid,uuid),public.finish_reminder_delivery(uuid,text,uuid,text),public.finish_client_sms_delivery(uuid,uuid,text),public.review_reminder_delivery(uuid,uuid,text,uuid,text,text,boolean),public.review_client_sms_delivery(uuid,uuid,uuid,text,text,boolean),public.reminder_recipient_matches(uuid,text,text) TO service_role;

-- Destination history is independent of invoice/client identity. Legacy rows
-- with no trustworthy destination are treated globally, rather than silently
-- assuming today's client contact was the historic recipient.
CREATE FUNCTION app_private.reminder_recipient_history(p_channel text,p_key text,p_own_attempt uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_latest timestamptz;v_unresolved boolean;v_time timestamptz;v_more boolean;
BEGIN
  IF p_key IS NULL OR p_channel NOT IN ('email','sms') THEN RETURN NULL; END IF;
  SELECT max(a.updated_at) FILTER(WHERE a.state='accepted'), coalesce(bool_or(a.state='unconfirmed' OR
    (a.state='reserved' AND (a.attempt_id=p_own_attempt AND EXISTS(SELECT 1 FROM public.reminder_recipient_locks l
      WHERE l.channel=p_channel AND l.recipient_key=p_key AND l.active_attempt_id=a.attempt_id)) IS NOT TRUE)),false)
    INTO v_latest,v_unresolved FROM public.reminder_delivery_attempts a WHERE a.channel=p_channel AND (a.recipient_key=p_key OR a.recipient_key IS NULL);
  IF p_channel='email' THEN
    SELECT greatest(max(e.sent_at) FILTER(WHERE e.status IN ('accepted','delivered','bounced')),max(lr.reviewed_at) FILTER(WHERE lr.outcome='accepted')),
      coalesce(bool_or(
        (e.status='pending' AND (a.state='reserved' AND a.attempt_id=p_own_attempt AND EXISTS(SELECT 1 FROM public.reminder_recipient_locks l WHERE l.channel=p_channel AND l.recipient_key=p_key AND l.active_attempt_id=a.attempt_id)) IS NOT TRUE
          AND (a.state='cancelled' OR EXISTS(SELECT 1 FROM public.reminder_delivery_reviews r WHERE r.attempt_id=a.attempt_id AND r.outcome=a.state) OR lr.record_id IS NOT NULL) IS NOT TRUE)
        OR (e.status='failed' AND (a.state IN ('rejected','cancelled') OR EXISTS(SELECT 1 FROM public.reminder_delivery_reviews r WHERE r.attempt_id=a.attempt_id AND r.outcome=a.state) OR lr.record_id IS NOT NULL) IS NOT TRUE)
        OR (e.status IN ('accepted','delivered','bounced') AND e.sent_at IS NULL AND lr.record_id IS NULL)
      ),false) INTO v_time,v_more FROM public.email_logs e
      LEFT JOIN public.reminder_delivery_attempts a ON a.attempt_id=e.reminder_attempt_id AND a.channel='email' AND a.invoice_id=e.invoice_id AND a.recipient_key=app_private.reminder_recipient_key('email',e.recipient)
      LEFT JOIN public.reminder_legacy_reviews lr ON lr.kind='email_log' AND lr.record_id=e.id AND lr.observed_status=e.status AND e.reminder_attempt_id IS NULL
      WHERE app_private.reminder_recipient_key('email',e.recipient)=p_key OR app_private.reminder_recipient_key('email',e.recipient) IS NULL;
  ELSE
    SELECT greatest(max(greatest(s.sent_at,s.updated_at)) FILTER(WHERE s.status IN ('sent','delivered') AND s.simulated IS FALSE),max(lr.reviewed_at) FILTER(WHERE lr.outcome='accepted')),
      coalesce(bool_or(s.simulated IS NOT TRUE AND (
        (s.status='pending' AND (a.state='reserved' AND a.attempt_id=p_own_attempt AND EXISTS(SELECT 1 FROM public.reminder_recipient_locks l WHERE l.channel=p_channel AND l.recipient_key=p_key AND l.active_attempt_id=a.attempt_id)) IS NOT TRUE
          AND (a.state='cancelled' OR EXISTS(SELECT 1 FROM public.reminder_delivery_reviews r WHERE r.attempt_id=a.attempt_id AND r.outcome=a.state) OR lr.record_id IS NOT NULL) IS NOT TRUE)
        OR (s.status='failed' AND (a.state IN ('rejected','cancelled') OR EXISTS(SELECT 1 FROM public.reminder_delivery_reviews r WHERE r.attempt_id=a.attempt_id AND r.outcome=a.state) OR lr.record_id IS NOT NULL) IS NOT TRUE)
        OR (s.status IN ('sent','delivered') AND s.sent_at IS NULL AND lr.record_id IS NULL)
      )),false) INTO v_time,v_more FROM public.sms_logs s
      LEFT JOIN public.reminder_delivery_attempts a ON a.attempt_id=s.reminder_attempt_id AND a.channel='sms' AND a.invoice_id IS NOT DISTINCT FROM s.invoice_id AND a.recipient_key=app_private.reminder_recipient_key('sms',s.phone)
      LEFT JOIN public.reminder_legacy_reviews lr ON lr.kind='sms_log' AND lr.record_id=s.id AND lr.observed_status=s.status AND s.reminder_attempt_id IS NULL
      WHERE app_private.reminder_recipient_key('sms',s.phone)=p_key OR app_private.reminder_recipient_key('sms',s.phone) IS NULL;
  END IF;
  v_latest:=greatest(v_latest,v_time);v_unresolved:=v_unresolved OR v_more;
  -- Dispatch rows have no recorded destination. Treat ambiguous ones as global
  -- blockers and accepted timestamps as global cooldowns until they age out.
  SELECT greatest(max(d.sent_at) FILTER(WHERE d.status='sent'),max(lr.reviewed_at) FILTER(WHERE lr.outcome='accepted')),
    coalesce(bool_or((d.status IN ('pending','failed') OR (d.status='sent' AND d.sent_at IS NULL)) AND lr.record_id IS NULL),false)
    INTO v_time,v_more FROM public.reminder_dispatches d
    LEFT JOIN public.reminder_legacy_reviews lr ON lr.kind='dispatch' AND lr.record_id=d.id AND lr.observed_status=d.status WHERE d.channel=p_channel;
  RETURN pg_catalog.jsonb_build_object('lastContactAt',greatest(v_latest,v_time),'unresolvedAttempt',v_unresolved OR v_more);
END;
$$;
REVOKE ALL ON FUNCTION app_private.reminder_recipient_history(text,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
ALTER FUNCTION public.read_client_sms_history(uuid,uuid) RENAME TO read_client_sms_history_internal;
ALTER FUNCTION public.read_reminder_contact_history(uuid,text,uuid) RENAME TO read_reminder_client_history_internal;
REVOKE ALL ON FUNCTION public.read_client_sms_history_internal(uuid,uuid),public.read_reminder_client_history_internal(uuid,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.read_client_sms_history(p_client_id uuid,p_own_attempt uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_base jsonb;v_extra jsonb;v_key text;
BEGIN
  v_base:=public.read_client_sms_history_internal(p_client_id,p_own_attempt);
  SELECT app_private.reminder_recipient_key('sms',phone) INTO v_key FROM public.clients WHERE id=p_client_id;
  v_key:=coalesce((SELECT a.recipient_key FROM public.reminder_delivery_attempts a WHERE a.attempt_id=p_own_attempt AND a.channel='sms'),v_key);
  v_extra:=app_private.reminder_recipient_history('sms',v_key,p_own_attempt);
  IF v_base IS NULL OR v_extra IS NULL THEN RETURN NULL; END IF;
  RETURN pg_catalog.jsonb_build_object('lastContactAt',greatest((v_base->>'lastContactAt')::timestamptz,(v_extra->>'lastContactAt')::timestamptz),
    'unresolvedAttempt',(v_base->>'unresolvedAttempt')::boolean OR (v_extra->>'unresolvedAttempt')::boolean);
END;
$$;
CREATE FUNCTION public.read_reminder_contact_history(p_invoice_id uuid,p_channel text,p_own_attempt uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_base jsonb;v_extra jsonb;v_key text;
BEGIN
  v_base:=public.read_reminder_client_history_internal(p_invoice_id,p_channel,p_own_attempt);
  SELECT app_private.reminder_recipient_key(p_channel,CASE WHEN p_channel='email' THEN c.email ELSE c.phone END) INTO v_key
    FROM public.invoices i JOIN public.clients c ON c.id=i.client_id WHERE i.id=p_invoice_id;
  v_key:=coalesce((SELECT a.recipient_key FROM public.reminder_delivery_attempts a WHERE a.attempt_id=p_own_attempt AND a.channel=p_channel),v_key);
  v_extra:=app_private.reminder_recipient_history(p_channel,v_key,p_own_attempt);
  IF v_base IS NULL OR v_extra IS NULL THEN RETURN NULL; END IF;
  RETURN pg_catalog.jsonb_build_object('lastContactAt',greatest((v_base->>'lastContactAt')::timestamptz,(v_extra->>'lastContactAt')::timestamptz),
    'unresolvedAttempt',(v_base->>'unresolvedAttempt')::boolean OR (v_extra->>'unresolvedAttempt')::boolean);
END;
$$;
REVOKE ALL ON FUNCTION public.read_client_sms_history(uuid,uuid),public.read_reminder_contact_history(uuid,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.read_client_sms_history(uuid,uuid),public.read_reminder_contact_history(uuid,text,uuid) TO service_role;
