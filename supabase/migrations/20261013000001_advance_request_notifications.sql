-- Durable, per-user Bale request notifications and site-scoped batch approval.
-- Notifications are emitted inside the request transaction so the submitting
-- Supervisor and Founder receive a consistent lifecycle event.

CREATE TABLE IF NOT EXISTS public.user_notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recipient_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL CHECK (
      event_type IN (
        'advance_request_submitted',
        'advance_request_approved',
        'advance_request_rejected',
        'advance_request_issued'
      )
    ),
    advance_request_id UUID REFERENCES public.advance_requests(id) ON DELETE SET NULL,
    worker_id UUID REFERENCES public.workers(id) ON DELETE SET NULL,
    project_id UUID REFERENCES public.projects(id) ON DELETE SET NULL,
    requested_amount NUMERIC(10, 2) NOT NULL CHECK (requested_amount > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    read_at TIMESTAMPTZ,
    CONSTRAINT user_notifications_event_once
      UNIQUE (recipient_id, advance_request_id, event_type)
);

CREATE INDEX IF NOT EXISTS idx_user_notifications_unread_recipient_created
  ON public.user_notifications(recipient_id, created_at DESC)
  WHERE read_at IS NULL;

ALTER TABLE public.user_notifications ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.user_notifications FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.user_notifications TO authenticated;
GRANT UPDATE (read_at) ON TABLE public.user_notifications TO authenticated;

DROP POLICY IF EXISTS "Recipients can read their own notifications" ON public.user_notifications;
CREATE POLICY "Recipients can read their own notifications"
  ON public.user_notifications FOR SELECT TO authenticated
  USING (recipient_id = auth.uid());

DROP POLICY IF EXISTS "Recipients can mark their own notifications read" ON public.user_notifications;
CREATE POLICY "Recipients can mark their own notifications read"
  ON public.user_notifications FOR UPDATE TO authenticated
  USING (recipient_id = auth.uid())
  WITH CHECK (recipient_id = auth.uid() AND read_at IS NOT NULL);

-- SECURITY DEFINER is limited to this trigger. Authenticated clients cannot
-- forge or target notification rows; only request events create them.
CREATE OR REPLACE FUNCTION public.notify_advance_request_event()
RETURNS TRIGGER AS $$
DECLARE
  v_event_type TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_event_type := 'advance_request_submitted';
  ELSIF OLD.status IS DISTINCT FROM NEW.status THEN
    v_event_type := CASE NEW.status
      WHEN 'approved_pending_payment' THEN 'advance_request_approved'
      WHEN 'rejected' THEN 'advance_request_rejected'
      WHEN 'issued' THEN 'advance_request_issued'
      ELSE NULL
    END;

    -- Once a request is reviewed, its old "new request" alert is no longer
    -- actionable for Founders. Keep its history, but clear its unread state.
    UPDATE public.user_notifications
    SET read_at = COALESCE(read_at, NOW())
    WHERE advance_request_id = NEW.id
      AND event_type = 'advance_request_submitted'
      AND read_at IS NULL;
  ELSE
    RETURN NEW;
  END IF;

  IF v_event_type IS NULL THEN
    RETURN NEW;
  END IF;

  IF v_event_type = 'advance_request_submitted' THEN
    INSERT INTO public.user_notifications (
      recipient_id, event_type, advance_request_id, worker_id, project_id, requested_amount
    )
    SELECT
      app_user.id,
      v_event_type,
      NEW.id,
      NEW.worker_id,
      NEW.project_id,
      NEW.requested_amount
    FROM public.users AS app_user
    WHERE app_user.role = 'founder'
    ON CONFLICT (recipient_id, advance_request_id, event_type) DO NOTHING;
  ELSE
    INSERT INTO public.user_notifications (
      recipient_id, event_type, advance_request_id, worker_id, project_id, requested_amount
    ) VALUES (
      NEW.submitted_by,
      v_event_type,
      NEW.id,
      NEW.worker_id,
      NEW.project_id,
      NEW.requested_amount
    )
    ON CONFLICT (recipient_id, advance_request_id, event_type) DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.notify_advance_request_event() FROM PUBLIC;

DROP TRIGGER IF EXISTS notify_advance_request_event ON public.advance_requests;
CREATE TRIGGER notify_advance_request_event
  AFTER INSERT OR UPDATE OF status ON public.advance_requests
  FOR EACH ROW EXECUTE FUNCTION public.notify_advance_request_event();

-- Backfill only requests that still require action. Resolved historical
-- approvals/rejections are deliberately not replayed as new notifications.
INSERT INTO public.user_notifications (
  recipient_id, event_type, advance_request_id, worker_id, project_id, requested_amount
)
SELECT
  app_user.id,
  'advance_request_submitted',
  request.id,
  request.worker_id,
  request.project_id,
  request.requested_amount
FROM public.advance_requests AS request
CROSS JOIN public.users AS app_user
WHERE request.status = 'pending_approval'
  AND app_user.role = 'founder'
ON CONFLICT (recipient_id, advance_request_id, event_type) DO NOTHING;

INSERT INTO public.user_notifications (
  recipient_id, event_type, advance_request_id, worker_id, project_id, requested_amount
)
SELECT
  request.submitted_by,
  'advance_request_approved',
  request.id,
  request.worker_id,
  request.project_id,
  request.requested_amount
FROM public.advance_requests AS request
WHERE request.status = 'approved_pending_payment'
ON CONFLICT (recipient_id, advance_request_id, event_type) DO NOTHING;

-- Founder-only atomic batch approval. All selected requests must exist, still
-- await approval, and belong to exactly one site; any failure rolls back all.
CREATE OR REPLACE FUNCTION public.approve_advance_requests(p_request_ids UUID[])
RETURNS SETOF public.advance_requests AS $$
DECLARE
  v_requested_count INTEGER;
  v_found_count INTEGER;
  v_project_count INTEGER;
BEGIN
  IF NOT public.is_founder() THEN
    RAISE EXCEPTION 'Founder access is required to approve bale requests.' USING ERRCODE = '42501';
  END IF;

  IF p_request_ids IS NULL OR cardinality(p_request_ids) = 0 THEN
    RAISE EXCEPTION 'Select at least one bale request.' USING ERRCODE = '22023';
  END IF;

  v_requested_count := cardinality(p_request_ids);
  IF v_requested_count > 50 THEN
    RAISE EXCEPTION 'Approve no more than 50 requests in one batch.' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM unnest(p_request_ids) AS selected(request_id)
    WHERE selected.request_id IS NULL
  ) OR v_requested_count <> (
    SELECT COUNT(DISTINCT selected.request_id)
    FROM unnest(p_request_ids) AS selected(request_id)
  ) THEN
    RAISE EXCEPTION 'The selected request list contains a duplicate or invalid ID.' USING ERRCODE = '22023';
  END IF;

  -- Lock in a stable order so overlapping batches do not deadlock.
  PERFORM request.id
  FROM public.advance_requests AS request
  WHERE request.id = ANY(p_request_ids)
  ORDER BY request.id
  FOR UPDATE;

  SELECT COUNT(*), COUNT(DISTINCT request.project_id)
  INTO v_found_count, v_project_count
  FROM public.advance_requests AS request
  WHERE request.id = ANY(p_request_ids);

  IF v_found_count <> v_requested_count THEN
    RAISE EXCEPTION 'One or more selected bale requests could not be found.' USING ERRCODE = 'P0002';
  END IF;

  IF v_project_count <> 1 THEN
    RAISE EXCEPTION 'Approve requests from one site at a time.' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.advance_requests AS request
    WHERE request.id = ANY(p_request_ids)
      AND request.status <> 'pending_approval'
  ) THEN
    RAISE EXCEPTION 'Every selected request must still be awaiting approval.' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  UPDATE public.advance_requests
  SET status = 'approved_pending_payment',
      approved_by = auth.uid(),
      approved_at = NOW(),
      updated_at = NOW()
  WHERE id = ANY(p_request_ids)
  RETURNING *;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.approve_advance_requests(UUID[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.approve_advance_requests(UUID[]) TO authenticated;

-- Publish the per-user event table to Supabase Realtime when the standard
-- publication exists. The app also performs a background sync as a fallback.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
    AND NOT EXISTS (
      SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime' AND puballtables
    )
    AND NOT EXISTS (
      SELECT 1
      FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = 'user_notifications'
    ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.user_notifications';
  END IF;
END;
$$;
