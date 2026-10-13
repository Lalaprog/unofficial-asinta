-- Supervisor-submitted worker advance requests with Founder review.
-- Requests are kept separate from `advances`: an approved request is not an
-- issued balance until a Founder confirms that the money was disbursed.

CREATE TABLE IF NOT EXISTS public.advance_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    worker_id UUID NOT NULL REFERENCES public.workers(id) ON DELETE RESTRICT,
    project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE RESTRICT,
    requested_amount NUMERIC(10, 2) NOT NULL CHECK (requested_amount > 0),
    submitted_by UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    status TEXT NOT NULL DEFAULT 'pending_approval'
      CHECK (status IN ('pending_approval', 'approved_pending_payment', 'rejected', 'issued')),
    approved_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    approved_at TIMESTAMPTZ,
    rejected_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    rejected_at TIMESTAMPTZ,
    issued_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    issued_at TIMESTAMPTZ,
    issued_advance_id UUID UNIQUE REFERENCES public.advances(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT advance_request_approval_fields CHECK (
      (status <> 'approved_pending_payment' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL))
    ),
    CONSTRAINT advance_request_rejection_fields CHECK (
      (status <> 'rejected' OR (rejected_by IS NOT NULL AND rejected_at IS NOT NULL))
    ),
    CONSTRAINT advance_request_issue_fields CHECK (
      (status <> 'issued' OR (issued_by IS NOT NULL AND issued_at IS NOT NULL AND issued_advance_id IS NOT NULL))
    )
);

CREATE INDEX IF NOT EXISTS idx_advance_requests_status_created
  ON public.advance_requests(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_advance_requests_project_created
  ON public.advance_requests(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_advance_requests_submitter
  ON public.advance_requests(submitted_by, created_at DESC);

ALTER TABLE public.advance_requests ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON public.advance_requests TO authenticated;
REVOKE UPDATE, DELETE ON public.advance_requests FROM authenticated;

DROP POLICY IF EXISTS "Founders can read advance requests" ON public.advance_requests;
CREATE POLICY "Founders can read advance requests"
  ON public.advance_requests FOR SELECT TO authenticated
  USING (public.is_founder());

DROP POLICY IF EXISTS "Supervisors can read their submitted advance requests" ON public.advance_requests;
CREATE POLICY "Supervisors can read their submitted advance requests"
  ON public.advance_requests FOR SELECT TO authenticated
  USING (submitted_by = auth.uid());

DROP POLICY IF EXISTS "Supervisors can submit requests for assigned projects" ON public.advance_requests;
CREATE POLICY "Supervisors can submit requests for assigned projects"
  ON public.advance_requests FOR INSERT TO authenticated
  WITH CHECK (
    public.current_user_role() = 'supervisor'
    AND submitted_by = auth.uid()
    AND status = 'pending_approval'
    AND approved_by IS NULL
    AND approved_at IS NULL
    AND rejected_by IS NULL
    AND rejected_at IS NULL
    AND issued_by IS NULL
    AND issued_at IS NULL
    AND issued_advance_id IS NULL
    AND public.is_supervisor_assigned(project_id)
    AND EXISTS (
      SELECT 1 FROM public.workers
      WHERE workers.id = advance_requests.worker_id
        AND workers.active = TRUE
    )
  );

-- Requests are financial records. Capture their initial submission and every
-- later status change in the existing append-only audit log. SECURITY DEFINER
-- is limited to this trigger so Supervisors do not need direct audit_log access.
CREATE OR REPLACE FUNCTION public.audit_advance_request_change()
RETURNS TRIGGER AS $$
DECLARE
  v_actor UUID;
  v_actor_email TEXT;
  v_action TEXT;
  v_before JSONB;
  v_after JSONB;
  v_record_id UUID;
BEGIN
  v_actor := COALESCE(auth.uid(), NEW.submitted_by, OLD.submitted_by);
  SELECT email INTO v_actor_email FROM public.users WHERE id = v_actor;

  IF TG_OP = 'INSERT' THEN
    v_action := 'insert';
    v_before := NULL;
    v_after := to_jsonb(NEW);
    v_record_id := NEW.id;
  ELSE
    v_action := 'update';
    v_before := to_jsonb(OLD);
    v_after := to_jsonb(NEW);
    v_record_id := NEW.id;
  END IF;

  INSERT INTO public.audit_log (
    actor_id, actor_email, action, table_name, record_id, before_row, after_row
  ) VALUES (
    v_actor, v_actor_email, v_action, 'advance_requests', v_record_id, v_before, v_after
  );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS audit_advance_request_change ON public.advance_requests;
CREATE TRIGGER audit_advance_request_change
  AFTER INSERT OR UPDATE ON public.advance_requests
  FOR EACH ROW EXECUTE FUNCTION public.audit_advance_request_change();

-- Only Founders may approve/reject a request. Direct table updates are not
-- granted by RLS, so the status transition and audit record stay together.
CREATE OR REPLACE FUNCTION public.review_advance_request(
  p_request_id UUID,
  p_decision TEXT
)
RETURNS public.advance_requests AS $$
DECLARE
  v_request public.advance_requests%ROWTYPE;
BEGIN
  IF NOT public.is_founder() THEN
    RAISE EXCEPTION 'Founder access is required to review bale requests.' USING ERRCODE = '42501';
  END IF;

  IF p_decision NOT IN ('approve', 'reject') THEN
    RAISE EXCEPTION 'Decision must be approve or reject.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_request
  FROM public.advance_requests
  WHERE id = p_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Bale request not found.' USING ERRCODE = 'P0002';
  END IF;

  IF v_request.status <> 'pending_approval' THEN
    RAISE EXCEPTION 'Only requests awaiting approval can be reviewed.' USING ERRCODE = '22023';
  END IF;

  IF p_decision = 'approve' THEN
    UPDATE public.advance_requests
    SET status = 'approved_pending_payment',
        approved_by = auth.uid(),
        approved_at = NOW(),
        updated_at = NOW()
    WHERE id = p_request_id
    RETURNING * INTO v_request;
  ELSE
    UPDATE public.advance_requests
    SET status = 'rejected',
        rejected_by = auth.uid(),
        rejected_at = NOW(),
        updated_at = NOW()
    WHERE id = p_request_id
    RETURNING * INTO v_request;
  END IF;

  RETURN v_request;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- Marking an approved request as issued is atomic: the issued advance ledger
-- row and the request status/link are committed together. The existing ledger
-- has a required reason column, so it receives a neutral system label; the
-- Supervisor is never asked to enter a reason.
CREATE OR REPLACE FUNCTION public.issue_advance_request(p_request_id UUID)
RETURNS UUID AS $$
DECLARE
  v_request public.advance_requests%ROWTYPE;
  v_advance public.advances%ROWTYPE;
  v_actor_email TEXT;
BEGIN
  IF NOT public.is_founder() THEN
    RAISE EXCEPTION 'Founder access is required to issue a bale request.' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_request
  FROM public.advance_requests
  WHERE id = p_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Bale request not found.' USING ERRCODE = 'P0002';
  END IF;

  IF v_request.status <> 'approved_pending_payment' THEN
    RAISE EXCEPTION 'Only approved requests awaiting payment can be issued.' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.advances (
    worker_id, project_id, amount, amount_deducted, reason, date, status
  ) VALUES (
    v_request.worker_id,
    v_request.project_id,
    v_request.requested_amount,
    0,
    'Approved Bale request',
    (NOW() AT TIME ZONE 'Asia/Manila')::DATE,
    'active'
  )
  RETURNING * INTO v_advance;

  UPDATE public.advance_requests
  SET status = 'issued',
      issued_by = auth.uid(),
      issued_at = NOW(),
      issued_advance_id = v_advance.id,
      updated_at = NOW()
  WHERE id = p_request_id
  RETURNING * INTO v_request;

  SELECT email INTO v_actor_email FROM public.users WHERE id = auth.uid();
  INSERT INTO public.audit_log (
    actor_id, actor_email, action, table_name, record_id, before_row, after_row
  ) VALUES (
    auth.uid(), v_actor_email, 'insert', 'advances', v_advance.id, NULL, to_jsonb(v_advance)
  );

  RETURN v_advance.id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.review_advance_request(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.issue_advance_request(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.review_advance_request(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.issue_advance_request(UUID) TO authenticated;
