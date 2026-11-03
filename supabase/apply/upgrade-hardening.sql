-- ===========================================================================
-- BALE — security, AI & advance-workflow updates (already-migrated project)
-- ===========================================================================
--
-- The 2026-10-06 security/AI hardening plus the 2026-10-13 Bale request
-- workflow and follow-up: private receipts + audit log, vendor memory,
-- Founder-reviewed advances, durable per-user notifications, and atomic
-- same-site batch approval, transactional payroll, and Founder protection. Requires the
-- base BALE schema and communications
-- migration to already be present.
--
-- GENERATED FILE — do not edit. Regenerate with `npm run build:apply-sql`.
-- Generated: 2026-11-03T10:18:28.625Z
--
-- Source files (in execution order) and their SHA-256:
--   20261006000000_security_hardening.sql  5990a60a9251e5ff…
--   20261006000001_ai_draft_support.sql  b8bbb367efea29a3…
--   20261013000000_advance_requests.sql  a539492809adf02d…
--   20261013000001_advance_request_notifications.sql  ecf58c0cbbc69469…
--   20261102000000_atomic_payroll_payments.sql  99be1b5b2db06673…
--   20261102000001_founder_guard.sql  2b72e38d4cf3a170…
--   20261103000000_pending_attendance_queue.sql  941b665a4941df1b…
--   20261103000001_attendance_history.sql  f62ce527f101c972…
--
-- After running: execute supabase/apply/verify-live.sql and confirm every
-- row reports PASS. Procedure: docs/MIGRATION_RUNBOOK.md.
--
-- Wrapped in a single transaction: any failure rolls the whole thing back
-- rather than leaving the project half-migrated.
-- ===========================================================================

begin;

-- @@ source: 20261006000000_security_hardening.sql

-- BALE — Security hardening (2026-10-06)
--
-- Two confirmed findings, both reachable in production until this migration:
--
--   1. The `receipts` Storage bucket was created with `public = true`. Storage
--      policies restricted UPLOAD and LIST to Founders, but a public bucket
--      bypasses auth on READ — anyone holding the URL could fetch a receipt
--      photo. Receipts routinely show supplier names, amounts, TINs, and
--      sometimes signatures or card fragments.
--      Fix: private bucket + short-lived signed URLs. expenses.receipt_url now
--      stores the STORAGE PATH, not a URL (see lib/supabase/receipts.ts).
--
--   2. Financial mutations left no trail. There is now an append-only
--      `audit_log` with Founder-only read access and NO update/delete policy,
--      so a row cannot be edited or erased through any RLS-respecting client.
--
-- Applying this migration is idempotent and safe to re-run.

-- ---------------------------------------------------------------------------
-- 1. Receipts bucket: public → private
-- ---------------------------------------------------------------------------

update storage.buckets
set public = false
where id = 'receipts' and public is distinct from false;

-- Policies are unchanged: Founders already hold select/insert/update/delete on
-- this bucket via public.is_founder(). `createSignedUrl()` requires the SELECT
-- policy, which is why signed URLs keep working after the bucket is private.

-- ---------------------------------------------------------------------------
-- 2. Backfill: public/signed receipt URLs → storage paths
--
-- Rows written before this migration hold one of:
--   https://<ref>.supabase.co/storage/v1/object/public/receipts/<path>
--   https://<ref>.supabase.co/storage/v1/object/sign/receipts/<path>?token=…
-- The app now resolves a signed URL from the path at render time, so any
-- absolute URL left in place would be both broken and permanently public.
--
-- Note: the query string is stripped BEFORE the prefix, because a signed URL's
-- token would otherwise travel with the path.
-- ---------------------------------------------------------------------------

update public.expenses
set receipt_url = split_part(receipt_url, '?', 1)
where receipt_url ~ '^https?://' and receipt_url like '%?%';

update public.expenses
set receipt_url = regexp_replace(
      receipt_url,
      '^.*/storage/v1/object/(public|sign|authenticated)/receipts/',
      ''
    )
where receipt_url ~ '/storage/v1/object/(public|sign|authenticated)/receipts/';

-- Anything that is still an absolute URL is not a storage path and cannot be
-- signed. Leaving it would make the UI claim a receipt is available when it is
-- not, so it is cleared and the Founder re-attaches the photo.
update public.expenses
set receipt_url = null
where receipt_url ~ '^https?://';

-- ---------------------------------------------------------------------------
-- 3. audit_log — append-only trail for financial mutations
-- ---------------------------------------------------------------------------

create table if not exists public.audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Nullable: a system/migration action has no human actor.
    actor_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    actor_email TEXT,
    -- insert | update | delete
    action TEXT NOT NULL CHECK (action IN ('insert', 'update', 'delete')),
    table_name TEXT NOT NULL,
    record_id UUID,
    -- Full row snapshots. BEFORE is null on insert, AFTER is null on delete.
    before_row JSONB,
    after_row JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

create index if not exists idx_audit_log_record
  on public.audit_log (table_name, record_id, created_at DESC);
create index if not exists idx_audit_log_created_at
  on public.audit_log (created_at DESC);
create index if not exists idx_audit_log_actor
  on public.audit_log (actor_id, created_at DESC);

alter table public.audit_log enable row level security;

-- Founders read the trail…
drop policy if exists "Founders can read the audit log" on public.audit_log;
create policy "Founders can read the audit log"
  on public.audit_log for select
  to authenticated
  using (public.is_founder());

-- …and record their own actions. `actor_id = auth.uid()` prevents a Founder
-- from writing an entry that blames someone else.
drop policy if exists "Founders can append to the audit log" on public.audit_log;
create policy "Founders can append to the audit log"
  on public.audit_log for insert
  to authenticated
  with check (public.is_founder() and actor_id = auth.uid());

-- Deliberately NO update and NO delete policy: with RLS enabled, any
-- UPDATE/DELETE matching zero policies is denied. The trail cannot be rewritten
-- by whoever happens to hold a Founder session.

-- ---------------------------------------------------------------------------
-- 3. Scope every existing policy to `authenticated`
--
-- The original policies omitted the TO clause, which defaults the policy to
-- PUBLIC — the anon role included. Their USING expressions already require a
-- real user (`public.is_founder()` / `auth.uid()`), so anon could not pass
-- them; this change removes the possibility that a future policy is written in
-- the same shape with a condition anon CAN satisfy. Semantics for signed-in
-- users are unchanged, which is why this is a mechanical drop-and-recreate.
-- ---------------------------------------------------------------------------

drop policy if exists "Founders have full access to users" on public.users;
create policy "Founders have full access to users"
  on public.users FOR ALL to authenticated
  using (public.is_founder());

drop policy if exists "Supervisors can read their own profile" on public.users;
create policy "Supervisors can read their own profile"
  on public.users FOR SELECT to authenticated
  using (auth.uid() = id);

drop policy if exists "Founders have full access to projects" on public.projects;
create policy "Founders have full access to projects"
  on public.projects FOR ALL to authenticated
  using (public.is_founder());

drop policy if exists "Supervisors can view assigned projects only" on public.projects;
create policy "Supervisors can view assigned projects only"
  on public.projects FOR SELECT to authenticated
  using (public.is_supervisor_assigned(id));

drop policy if exists "Founders manage project supervisor assignments" on public.project_supervisors;
create policy "Founders manage project supervisor assignments"
  on public.project_supervisors FOR ALL to authenticated
  using (public.is_founder());

drop policy if exists "Supervisors can view their own project assignments" on public.project_supervisors;
create policy "Supervisors can view their own project assignments"
  on public.project_supervisors FOR SELECT to authenticated
  using (supervisor_id = auth.uid());

drop policy if exists "Founders full access to invoices" on public.invoices;
create policy "Founders full access to invoices"
  on public.invoices FOR ALL to authenticated
  using (public.is_founder());

drop policy if exists "Founders full access to clients" on public.clients;
create policy "Founders full access to clients"
  on public.clients FOR ALL to authenticated
  using (public.is_founder());

drop policy if exists "Founders full access to expenses" on public.expenses;
create policy "Founders full access to expenses"
  on public.expenses FOR ALL to authenticated
  using (public.is_founder());

drop policy if exists "Founders full access to advances" on public.advances;
create policy "Founders full access to advances"
  on public.advances FOR ALL to authenticated
  using (public.is_founder());

drop policy if exists "Founders full access to workers" on public.workers;
create policy "Founders full access to workers"
  on public.workers FOR ALL to authenticated
  using (public.is_founder());

drop policy if exists "Supervisors can view active workers" on public.workers;
create policy "Supervisors can view active workers"
  on public.workers FOR SELECT to authenticated
  using (auth.uid() IS NOT NULL AND active = TRUE);

drop policy if exists "Founders full access to attendance" on public.attendance;
create policy "Founders full access to attendance"
  on public.attendance FOR ALL to authenticated
  using (public.is_founder());

drop policy if exists "Supervisors can read attendance for assigned projects" on public.attendance;
create policy "Supervisors can read attendance for assigned projects"
  on public.attendance FOR SELECT to authenticated
  using (public.is_supervisor_assigned(project_id));

drop policy if exists "Supervisors can insert attendance for assigned projects" on public.attendance;
create policy "Supervisors can insert attendance for assigned projects"
  on public.attendance FOR INSERT to authenticated
  with check (public.is_supervisor_assigned(project_id));

drop policy if exists "Supervisors can update attendance for assigned projects" on public.attendance;
create policy "Supervisors can update attendance for assigned projects"
  on public.attendance FOR UPDATE to authenticated
  using (public.is_supervisor_assigned(project_id));

drop policy if exists "Founders full access to payroll" on public.payroll;
create policy "Founders full access to payroll"
  on public.payroll FOR ALL to authenticated
  using (public.is_founder());

drop policy if exists "Founders full access to tools" on public.tools;
create policy "Founders full access to tools"
  on public.tools FOR ALL to authenticated
  using (public.is_founder());

drop policy if exists "Supervisors can view tools on assigned projects" on public.tools;
create policy "Supervisors can view tools on assigned projects"
  on public.tools FOR SELECT to authenticated
  using (project_id IS NOT NULL AND public.is_supervisor_assigned(project_id));

drop policy if exists "Founders full access to sms_logs" on public.sms_logs;
create policy "Founders full access to sms_logs"
  on public.sms_logs FOR ALL to authenticated
  using (public.is_founder());

drop policy if exists "Founders full access to email_templates" on public.email_templates;
create policy "Founders full access to email_templates"
  on public.email_templates FOR ALL to authenticated
  using (public.is_founder());

drop policy if exists "Founders full access to email_logs" on public.email_logs;
create policy "Founders full access to email_logs"
  on public.email_logs FOR ALL to authenticated
  using (public.is_founder());

drop policy if exists "Founders full access to reminder_dispatches" on public.reminder_dispatches;
create policy "Founders full access to reminder_dispatches"
  on public.reminder_dispatches FOR ALL to authenticated
  using (public.is_founder());

-- Storage policies already specify `to authenticated`; nothing to change there.

-- ---------------------------------------------------------------------------
-- 4. Function hardening
--
-- The RLS helpers are SECURITY DEFINER (they must be, to read public.users
-- inside a policy). Pinning search_path stops a caller from shadowing an
-- unqualified name with an object in a schema they control.
-- ---------------------------------------------------------------------------

create or replace function public.current_user_role()
returns text as $$
  select role from public.users where id = auth.uid();
$$ language sql stable security definer set search_path = public, pg_temp;

create or replace function public.is_founder()
returns boolean as $$
  select exists (
    select 1 from public.users where id = auth.uid() and role = 'founder'
  );
$$ language sql stable security definer set search_path = public, pg_temp;

create or replace function public.is_supervisor_assigned(proj_id uuid)
returns boolean as $$
  select exists (
    select 1 from public.project_supervisors
    where supervisor_id = auth.uid() and project_id = proj_id
  );
$$ language sql stable security definer set search_path = public, pg_temp;


-- @@ source: 20261006000001_ai_draft_support.sql

-- BALE — AI draft support (2026-10-06)
--
-- Track A (vendor memory) and the schema decision that was left open in
-- ROADMAP.md: the decorative `ai_approval_suggestion` column.
--
-- Vendor memory is deliberately COUNT-BASED and inspectable:
--   * keyed by a normalised vendor token (see lib/ai/vendorMemory.ts)
--   * stores how many times a Founder ACCEPTED the suggested category and how
--     many times they OVERRODE it
--   * the suggestion reads "accepted 14 of 15 times" — a measured rate, not an
--     asserted confidence percentage
-- There are no embeddings and no vector similarity anywhere, by design: the
-- moment it becomes a black box the property the design depends on (a Founder
-- can explain and reverse any suggestion) is lost.

-- ---------------------------------------------------------------------------
-- 1. expenses.vendor
--
-- Vendor memory needs the supplier ON the expense row: without it there is
-- nothing to key "this supplier is always materials" on, and duplicate detection
-- ("same supplier + same amount within N days") has no supplier to compare.
-- The AI draft prefills it; the Founder can edit or clear it, and it is never
-- used as a financial value.
-- ---------------------------------------------------------------------------

alter table public.expenses add column if not exists vendor TEXT;

create index if not exists idx_expenses_vendor
  on public.expenses (lower(vendor));
create index if not exists idx_expenses_amount_date
  on public.expenses (amount, expense_date);

-- ---------------------------------------------------------------------------
-- 2. vendor_memory
-- ---------------------------------------------------------------------------

create table if not exists public.vendor_memory (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Normalised lookup key, e.g. "jmc hardware".
    vendor_token TEXT NOT NULL UNIQUE,
    -- What the Founder actually typed, for display in the UI.
    vendor_label TEXT NOT NULL,
    -- Most recently confirmed category (last write wins — simple and reversible).
    category TEXT NOT NULL CHECK (category IN ('materials', 'labor', 'equipment', 'permits', 'transportation', 'other')),
    -- Times the Founder kept the suggested category…
    accepted_count INTEGER NOT NULL DEFAULT 0 CHECK (accepted_count >= 0),
    -- …and times they changed it. Both counters are shown, so the rate is honest.
    override_count INTEGER NOT NULL DEFAULT 0 CHECK (override_count >= 0),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

create index if not exists idx_vendor_memory_last_seen
  on public.vendor_memory (last_seen_at DESC);

alter table public.vendor_memory enable row level security;

drop policy if exists "Founders full access to vendor_memory" on public.vendor_memory;
create policy "Founders full access to vendor_memory"
  on public.vendor_memory for all
  to authenticated
  using (public.is_founder())
  with check (public.is_founder());

-- ---------------------------------------------------------------------------
-- 3. Atomic outcome recorder
--
-- One round trip, no read-modify-write race between two Founder sessions.
-- The counters are the ONLY thing this function changes, so a bad prediction
-- can be corrected by hand from the Supabase table editor and the memory
-- remains fully reversible.
-- ---------------------------------------------------------------------------

create or replace function public.record_vendor_outcome(
    p_vendor_token TEXT,
    p_vendor_label TEXT,
    p_suggested_category TEXT,
    p_final_category TEXT
) RETURNS public.vendor_memory
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
    v_token TEXT := lower(trim(coalesce(p_vendor_token, '')));
    v_label TEXT := trim(coalesce(p_vendor_label, ''));
    v_accepted INTEGER := 0;
    v_override INTEGER := 0;
    v_row public.vendor_memory;
BEGIN
    -- RLS would already block this, but an explicit check gives a readable
    -- error instead of "new row violates row-level security policy".
    IF NOT public.is_founder() THEN
        RAISE EXCEPTION 'Only Founder accounts may record vendor outcomes';
    END IF;

    IF v_token = '' THEN
        RAISE EXCEPTION 'A normalised vendor token is required';
    END IF;

    IF p_final_category IS NULL OR p_final_category NOT IN
        ('materials', 'labor', 'equipment', 'permits', 'transportation', 'other') THEN
        RAISE EXCEPTION 'Unsupported final category: %', p_final_category;
    END IF;

    -- Accepted = the suggestion (if any) matched what the Founder kept.
    IF p_suggested_category IS NOT NULL AND p_suggested_category = p_final_category THEN
        v_accepted := 1;
    ELSE
        v_override := 1;
    END IF;

    INSERT INTO public.vendor_memory AS vm (
        vendor_token, vendor_label, category, accepted_count, override_count, last_seen_at
    )
    VALUES (
        v_token,
        coalesce(nullif(v_label, ''), v_token),
        p_final_category,
        v_accepted,
        v_override,
        NOW()
    )
    ON CONFLICT (vendor_token) DO UPDATE
    SET
        vendor_label   = coalesce(nullif(excluded.vendor_label, ''), vm.vendor_label),
        category       = excluded.category,
        accepted_count = vm.accepted_count + excluded.accepted_count,
        override_count = vm.override_count + excluded.override_count,
        last_seen_at   = NOW()
    RETURNING * INTO v_row;

    RETURN v_row;
END;
$$;

revoke all on function public.record_vendor_outcome(TEXT, TEXT, TEXT, TEXT) from public;
grant execute on function public.record_vendor_outcome(TEXT, TEXT, TEXT, TEXT) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Retire the decorative `expenses.ai_approval_suggestion` column
--
-- The column held a routing string that nothing enforced and nothing read
-- (every writer of an expense is already a Founder, so there was no approver to
-- route to). It is no longer written by the app.
--
-- The historical values are not simply discarded: each non-null value is
-- archived into audit_log first, attributed to a system actor, so the trail
-- records that the column existed and what it contained. Then it is dropped.
-- ---------------------------------------------------------------------------

do $$
begin
    if exists (
        select 1 from information_schema.columns
        where table_schema = 'public'
          and table_name = 'expenses'
          and column_name = 'ai_approval_suggestion'
    ) then
        insert into public.audit_log (actor_id, actor_email, action, table_name, record_id, before_row, after_row)
        select
            null,
            'migration:20261006000001',
            'update',
            'expenses',
            e.id,
            jsonb_build_object('ai_approval_suggestion', e.ai_approval_suggestion),
            jsonb_build_object('ai_approval_suggestion', null, 'dropped_by', '20261006000001_ai_draft_support.sql')
        from public.expenses e
        where e.ai_approval_suggestion is not null;

        alter table public.expenses drop column ai_approval_suggestion;
    end if;
end $$;

-- `ai_confirmed` is intentionally KEPT. It now means "the Founder applied the
-- suggestion that was on screen", which is real information; it used to be
-- hardcoded true on every row and stored nothing.


-- @@ source: 20261013000000_advance_requests.sql

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


-- @@ source: 20261013000001_advance_request_notifications.sql

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


-- @@ source: 20261102000000_atomic_payroll_payments.sql

-- Payroll payment and Bale deductions must commit together. Existing paid
-- vouchers are left untouched; reconcile historical inconsistencies separately.
-- All application mutations of advance balances now use the functions below.

CREATE OR REPLACE FUNCTION public.guard_payroll_finalized_fields()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF auth.uid() IS NOT NULL AND NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'New payroll vouchers must start as drafts.' USING ERRCODE = '22023';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status IN ('approved', 'paid') AND
     (NEW.worker_id, NEW.period_start, NEW.period_end, NEW.gross_pay,
      NEW.bale_deduction, NEW.other_deductions, NEW.net_pay, NEW.days_worked,
      NEW.hours_worked, NEW.notes)
     IS DISTINCT FROM
     (OLD.worker_id, OLD.period_start, OLD.period_end, OLD.gross_pay,
      OLD.bale_deduction, OLD.other_deductions, OLD.net_pay, OLD.days_worked,
      OLD.hours_worked, OLD.notes) THEN
    RAISE EXCEPTION 'Approved or paid payroll vouchers cannot be recalculated.' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS guard_payroll_finalized_fields ON public.payroll;
CREATE TRIGGER guard_payroll_finalized_fields BEFORE INSERT OR UPDATE ON public.payroll
FOR EACH ROW EXECUTE FUNCTION public.guard_payroll_finalized_fields();

-- Do not let an old client update balances first and fail to update payroll
-- afterwards, or bypass the transactional status transition. The generator
-- still needs the explicitly listed draft voucher columns.
REVOKE UPDATE ON public.advances FROM PUBLIC, anon, authenticated;
REVOKE UPDATE ON public.payroll FROM PUBLIC, anon, authenticated;
GRANT UPDATE (worker_id, period_start, period_end, gross_pay, bale_deduction,
              other_deductions, net_pay, days_worked, hours_worked, notes)
  ON public.payroll TO authenticated;

CREATE OR REPLACE FUNCTION public.set_payroll_status_atomic(p_payroll_id uuid, p_status text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_worker_id uuid;
  v_before public.payroll%ROWTYPE;
  v_after public.payroll%ROWTYPE;
  v_advance public.advances%ROWTYPE;
  v_updated public.advances%ROWTYPE;
  v_available numeric;
  v_remaining numeric;
  v_deduct numeric;
  v_changed jsonb := '[]'::jsonb;
  v_email text;
BEGIN
  IF public.is_founder() IS NOT TRUE THEN
    RAISE EXCEPTION 'Founder access is required.' USING ERRCODE = '42501';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('approved', 'paid') THEN
    RAISE EXCEPTION 'Unsupported payroll transition.' USING ERRCODE = '22023';
  END IF;

  SELECT worker_id INTO v_worker_id FROM public.payroll WHERE id = p_payroll_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payroll voucher not found.' USING ERRCODE = 'P0002'; END IF;

  -- Serialize payments and manual deductions for the same worker, then lock
  -- the voucher and every eligible advance in a deterministic order.
  PERFORM 1 FROM public.workers WHERE id = v_worker_id FOR UPDATE;
  SELECT * INTO v_before FROM public.payroll WHERE id = p_payroll_id FOR UPDATE;
  IF NOT FOUND OR v_before.worker_id <> v_worker_id THEN
    RAISE EXCEPTION 'Payroll voucher changed. Refresh and retry.' USING ERRCODE = '40001';
  END IF;

  IF v_before.status = p_status THEN
    RETURN jsonb_build_object('outcome', 'already_' || p_status, 'payroll', to_jsonb(v_before), 'advances', v_changed);
  END IF;
  IF p_status = 'approved' AND v_before.status NOT IN ('draft', 'reviewed') THEN
    RAISE EXCEPTION 'Only draft or reviewed vouchers can be approved.' USING ERRCODE = '22023';
  END IF;
  IF p_status = 'paid' AND v_before.status <> 'approved' THEN
    RAISE EXCEPTION 'Only approved vouchers can be marked paid.' USING ERRCODE = '22023';
  END IF;

  SELECT email INTO v_email FROM public.users WHERE id = auth.uid();
  IF p_status = 'paid' AND v_before.bale_deduction > 0 THEN
    PERFORM 1 FROM public.advances
      WHERE worker_id = v_worker_id AND status IN ('active', 'partially_deducted')
      ORDER BY id FOR UPDATE;
    SELECT COALESCE(SUM(GREATEST(amount - amount_deducted, 0)), 0)
      INTO v_available FROM public.advances
      WHERE worker_id = v_worker_id AND status IN ('active', 'partially_deducted');
    IF v_available < v_before.bale_deduction THEN
      RAISE EXCEPTION 'Available Bale balance is less than the voucher deduction. Review the voucher and advances before recording payment.' USING ERRCODE = '22023';
    END IF;
    v_remaining := v_before.bale_deduction;
    FOR v_advance IN SELECT * FROM public.advances
      WHERE worker_id = v_worker_id AND status IN ('active', 'partially_deducted')
      ORDER BY date, id
    LOOP
      EXIT WHEN v_remaining <= 0;
      v_deduct := LEAST(v_remaining, GREATEST(v_advance.amount - v_advance.amount_deducted, 0));
      IF v_deduct <= 0 THEN CONTINUE; END IF;
      UPDATE public.advances SET amount_deducted = amount_deducted + v_deduct,
        status = CASE WHEN amount_deducted + v_deduct >= amount THEN 'fully_deducted' ELSE 'partially_deducted' END
        WHERE id = v_advance.id RETURNING * INTO v_updated;
      INSERT INTO public.audit_log (actor_id, actor_email, action, table_name, record_id, before_row, after_row)
        VALUES (auth.uid(), v_email, 'update', 'advances', v_advance.id, to_jsonb(v_advance), to_jsonb(v_updated));
      v_changed := v_changed || jsonb_build_array(to_jsonb(v_updated));
      v_remaining := v_remaining - v_deduct;
    END LOOP;
  END IF;

  UPDATE public.payroll SET status = p_status WHERE id = p_payroll_id RETURNING * INTO v_after;
  INSERT INTO public.audit_log (actor_id, actor_email, action, table_name, record_id, before_row, after_row)
    VALUES (auth.uid(), v_email, 'update', 'payroll', v_before.id, to_jsonb(v_before), to_jsonb(v_after));
  RETURN jsonb_build_object('outcome', 'updated', 'payroll', to_jsonb(v_after), 'advances', v_changed);
END;
$$;

CREATE OR REPLACE FUNCTION public.record_advance_deduction_atomic(p_advance_id uuid, p_amount numeric)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_worker_id uuid;
  v_before public.advances%ROWTYPE;
  v_after public.advances%ROWTYPE;
  v_email text;
BEGIN
  IF public.is_founder() IS NOT TRUE THEN RAISE EXCEPTION 'Founder access is required.' USING ERRCODE = '42501'; END IF;
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount <> round(p_amount, 2) THEN
    RAISE EXCEPTION 'Enter a positive deduction with at most two decimal places.' USING ERRCODE = '22023';
  END IF;
  SELECT worker_id INTO v_worker_id FROM public.advances WHERE id = p_advance_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Advance not found.' USING ERRCODE = 'P0002'; END IF;
  PERFORM 1 FROM public.workers WHERE id = v_worker_id FOR UPDATE;
  SELECT * INTO v_before FROM public.advances WHERE id = p_advance_id FOR UPDATE;
  IF NOT FOUND OR v_before.worker_id <> v_worker_id THEN
    RAISE EXCEPTION 'Advance changed. Refresh and retry.' USING ERRCODE = '40001';
  END IF;
  IF v_before.status NOT IN ('active', 'partially_deducted') OR p_amount > v_before.amount - v_before.amount_deducted THEN
    RAISE EXCEPTION 'The deduction exceeds the current active balance. Refresh and review the advance.' USING ERRCODE = '22023';
  END IF;
  UPDATE public.advances SET amount_deducted = amount_deducted + p_amount,
    status = CASE WHEN amount_deducted + p_amount >= amount THEN 'fully_deducted' ELSE 'partially_deducted' END
    WHERE id = p_advance_id RETURNING * INTO v_after;
  SELECT email INTO v_email FROM public.users WHERE id = auth.uid();
  INSERT INTO public.audit_log (actor_id, actor_email, action, table_name, record_id, before_row, after_row)
    VALUES (auth.uid(), v_email, 'update', 'advances', v_before.id, to_jsonb(v_before), to_jsonb(v_after));
  RETURN to_jsonb(v_after);
END;
$$;

CREATE OR REPLACE FUNCTION public.set_advance_status_atomic(p_advance_id uuid, p_status text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_worker_id uuid;
  v_before public.advances%ROWTYPE;
  v_after public.advances%ROWTYPE;
  v_email text;
BEGIN
  IF public.is_founder() IS NOT TRUE THEN RAISE EXCEPTION 'Founder access is required.' USING ERRCODE = '42501'; END IF;
  IF p_status IS NULL OR p_status NOT IN ('active', 'partially_deducted', 'fully_deducted', 'cancelled') THEN
    RAISE EXCEPTION 'Invalid advance status.' USING ERRCODE = '22023';
  END IF;
  SELECT worker_id INTO v_worker_id FROM public.advances WHERE id = p_advance_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Advance not found.' USING ERRCODE = 'P0002'; END IF;
  PERFORM 1 FROM public.workers WHERE id = v_worker_id FOR UPDATE;
  SELECT * INTO v_before FROM public.advances WHERE id = p_advance_id FOR UPDATE;
  IF NOT FOUND OR v_before.worker_id <> v_worker_id THEN
    RAISE EXCEPTION 'Advance changed. Refresh and retry.' USING ERRCODE = '40001';
  END IF;
  IF (p_status = 'active' AND v_before.amount_deducted <> 0)
     OR (p_status = 'partially_deducted' AND (v_before.amount_deducted <= 0 OR v_before.amount_deducted >= v_before.amount))
     OR (p_status = 'fully_deducted' AND v_before.amount_deducted <> v_before.amount) THEN
    RAISE EXCEPTION 'Advance status does not match its current balance.' USING ERRCODE = '22023';
  END IF;
  UPDATE public.advances SET status = p_status WHERE id = p_advance_id RETURNING * INTO v_after;
  SELECT email INTO v_email FROM public.users WHERE id = auth.uid();
  INSERT INTO public.audit_log (actor_id, actor_email, action, table_name, record_id, before_row, after_row)
    VALUES (auth.uid(), v_email, 'update', 'advances', v_before.id, to_jsonb(v_before), to_jsonb(v_after));
  RETURN to_jsonb(v_after);
END;
$$;

REVOKE ALL ON FUNCTION public.set_payroll_status_atomic(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.record_advance_deduction_atomic(uuid, numeric) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_advance_status_atomic(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_payroll_status_atomic(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_advance_deduction_atomic(uuid, numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_advance_status_atomic(uuid, text) TO authenticated;


-- @@ source: 20261102000001_founder_guard.sql

-- Serialize profile mutations and protect the last Founder, even for old
-- service-role clients using direct UPDATE/DELETE. Profile deletion and its
-- database cleanup are atomic; Supabase Auth removal remains a separate call.
CREATE SCHEMA IF NOT EXISTS app_private;
REVOKE ALL ON SCHEMA app_private FROM PUBLIC, anon, authenticated, service_role;
CREATE TABLE IF NOT EXISTS app_private.founder_guard (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  revision bigint NOT NULL DEFAULT 0
);
INSERT INTO app_private.founder_guard (singleton) VALUES (true) ON CONFLICT DO NOTHING;
REVOKE ALL ON app_private.founder_guard FROM PUBLIC, anon, authenticated, service_role;

-- Updating rather than merely locking the row also makes a concurrent stale
-- REPEATABLE READ transaction fail with serialization_failure rather than
-- letting it use a snapshot from before the previous change.
CREATE OR REPLACE FUNCTION app_private.lock_founder_guard()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  UPDATE app_private.founder_guard SET revision = revision + 1 WHERE singleton = true;
  IF NOT FOUND THEN RAISE EXCEPTION 'Founder guard is unavailable.' USING ERRCODE = '55000'; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION app_private.lock_user_mutations()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM app_private.lock_founder_guard();
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION app_private.check_founder_after_update()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM old_user_rows WHERE role = 'founder') AND
     NOT EXISTS (SELECT 1 FROM public.users WHERE role = 'founder') THEN
    RAISE EXCEPTION 'Cannot remove the last Founder account.' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION app_private.check_founder_after_delete()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM deleted_user_rows WHERE role = 'founder') AND
     NOT EXISTS (SELECT 1 FROM public.users WHERE role = 'founder') THEN
    RAISE EXCEPTION 'Cannot remove the last Founder account.' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION app_private.prevent_user_truncate()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'User profiles cannot be truncated.' USING ERRCODE = '23514';
END;
$$;

DROP TRIGGER IF EXISTS lock_user_mutations ON public.users;
CREATE TRIGGER lock_user_mutations BEFORE UPDATE OR DELETE ON public.users
FOR EACH STATEMENT EXECUTE FUNCTION app_private.lock_user_mutations();
DROP TRIGGER IF EXISTS check_founder_after_update ON public.users;
CREATE TRIGGER check_founder_after_update AFTER UPDATE ON public.users
REFERENCING OLD TABLE AS old_user_rows FOR EACH STATEMENT EXECUTE FUNCTION app_private.check_founder_after_update();
DROP TRIGGER IF EXISTS check_founder_after_delete ON public.users;
CREATE TRIGGER check_founder_after_delete AFTER DELETE ON public.users
REFERENCING OLD TABLE AS deleted_user_rows FOR EACH STATEMENT EXECUTE FUNCTION app_private.check_founder_after_delete();
DROP TRIGGER IF EXISTS prevent_user_truncate ON public.users;
CREATE TRIGGER prevent_user_truncate BEFORE TRUNCATE ON public.users
FOR EACH STATEMENT EXECUTE FUNCTION app_private.prevent_user_truncate();

-- Only the server-side service role may invoke these; the server authenticates
-- the caller and passes its user ID, which is re-checked under the guard.
CREATE OR REPLACE FUNCTION public.update_team_profile_guarded(p_actor uuid, p_target uuid, p_name text, p_role text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_target public.users%ROWTYPE; v_updated public.users%ROWTYPE;
BEGIN
  PERFORM app_private.lock_founder_guard();
  IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = p_actor AND role = 'founder') THEN
    RAISE EXCEPTION 'Founder access is required.' USING ERRCODE = '42501';
  END IF;
  IF p_target = p_actor AND p_role IS DISTINCT FROM 'founder' THEN
    RAISE EXCEPTION 'You cannot demote your own Founder account.' USING ERRCODE = '22023';
  END IF;
  IF p_name IS NULL OR length(btrim(p_name)) < 2 OR p_role IS NULL OR p_role NOT IN ('founder', 'supervisor') THEN
    RAISE EXCEPTION 'Invalid team profile.' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_target FROM public.users WHERE id = p_target FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Team account not found.' USING ERRCODE = 'P0002'; END IF;
  UPDATE public.users SET name = btrim(p_name), role = p_role WHERE id = p_target RETURNING * INTO v_updated;
  RETURN to_jsonb(v_updated);
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_team_profile_guarded(p_actor uuid, p_target uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_target public.users%ROWTYPE; v_actor_email text;
BEGIN
  PERFORM app_private.lock_founder_guard();
  SELECT email INTO v_actor_email FROM public.users WHERE id = p_actor AND role = 'founder';
  IF NOT FOUND THEN RAISE EXCEPTION 'Founder access is required.' USING ERRCODE = '42501'; END IF;
  IF p_target = p_actor THEN RAISE EXCEPTION 'You cannot delete your own Founder account.' USING ERRCODE = '22023'; END IF;
  SELECT * INTO v_target FROM public.users WHERE id = p_target FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Team account not found.' USING ERRCODE = 'P0002'; END IF;
  IF v_target.role = 'founder' AND (SELECT count(*) FROM public.users WHERE role = 'founder') <= 1 THEN
    RAISE EXCEPTION 'Cannot delete the last Founder account.' USING ERRCODE = '23514';
  END IF;

  UPDATE public.attendance SET recorded_by = NULL WHERE recorded_by = p_target;
  UPDATE public.expenses SET created_by = NULL WHERE created_by = p_target;
  UPDATE public.email_templates SET updated_by = NULL WHERE updated_by = p_target;
  UPDATE public.email_logs SET sent_by = NULL WHERE sent_by = p_target;
  DELETE FROM public.project_supervisors WHERE supervisor_id = p_target;
  UPDATE public.workers SET active = false WHERE id = p_target;
  DELETE FROM public.users WHERE id = p_target;
  INSERT INTO public.audit_log (actor_id, actor_email, action, table_name, record_id, before_row, after_row)
    VALUES (p_actor, v_actor_email, 'delete', 'users', p_target, to_jsonb(v_target), NULL);
  RETURN to_jsonb(v_target);
END;
$$;

REVOKE ALL ON FUNCTION public.update_team_profile_guarded(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.delete_team_profile_guarded(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_team_profile_guarded(uuid, uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.delete_team_profile_guarded(uuid, uuid) TO service_role;


-- @@ source: 20261103000000_pending_attendance_queue.sql

-- Founder review queue: do not rely on the shared client's capped attendance load.
-- Read-only and SECURITY INVOKER: existing RLS/grants remain in force. Deploy
-- this migration before the client using it; no existing attendance is changed.
create index if not exists attendance_pending_review_order_idx
  on public.attendance (date desc, id desc)
  where is_founder_override = false and status in ('present', 'half_day');

create or replace function public.pending_attendance_approvals(
  p_cursor_date date default null,
  p_cursor_id uuid default null,
  p_limit integer default 3
) returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  result jsonb;
begin
  if not coalesce(public.is_founder(), false) then
    raise exception 'Only Founders may view the supervisor approval queue' using errcode = '42501';
  end if;
  if (p_cursor_date is null) <> (p_cursor_id is null) then
    raise exception 'Both cursor values are required' using errcode = '22023';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 50 then
    raise exception 'Invalid page size' using errcode = '22023';
  end if;

  with pending as materialized (
    select a.*, w.name as worker_name, w.position as worker_position, p.name as project_name
    from public.attendance a
    left join public.workers w on w.id = a.worker_id
    left join public.projects p on p.id = a.project_id
    where a.is_founder_override = false
      and a.status in ('present', 'half_day')
      and (
        a.worker_id = a.recorded_by
        or strpos(coalesce(a.notes, ''), 'Pending Founder Review') > 0
        or strpos(coalesce(a.notes, ''), 'Founder Review:') > 0
        or strpos(lower(coalesce(w.position, '')), 'supervisor') > 0
        or exists (
          select 1 from public.users u
          where u.role = 'supervisor'
            and (u.id = w.id or lower(btrim(u.name)) = lower(btrim(w.name)))
        )
      )
  ), page as materialized (
    select * from pending
    where p_cursor_date is null or (date, id) < (p_cursor_date, p_cursor_id)
    order by date desc, id desc
    limit p_limit + 1
  ), visible as (
    select * from page order by date desc, id desc limit p_limit
  )
  select jsonb_build_object(
    'total', (select count(*) from pending),
    'has_more', (select count(*) > p_limit from page),
    'items', coalesce((select jsonb_agg(to_jsonb(visible) order by date desc, id desc) from visible), '[]'::jsonb)
  ) into result;
  return result;
end;
$$;

revoke all on function public.pending_attendance_approvals(date, uuid, integer) from public, anon;
grant execute on function public.pending_attendance_approvals(date, uuid, integer) to authenticated;


-- @@ source: 20261103000001_attendance_history.sql

-- Server-side attendance history. Both functions run as the caller: existing
-- attendance, worker, project and user RLS/grants still apply. No rows changed.
create index if not exists attendance_history_sheet_order_idx
  on public.attendance (date desc, project_id asc, id asc);

create or replace function public.attendance_history_matching(
  p_project_id uuid default null,
  p_status text default null,
  p_date date default null,
  p_search text default null
) returns table (
  id uuid, worker_id uuid, project_id uuid, date date, status text,
  hours_worked numeric, notes text, recorded_by uuid, is_founder_override boolean,
  submitted_at timestamptz, created_at timestamptz,
  worker_name text, worker_position text, project_name text, is_supervisor boolean
)
language sql stable security invoker set search_path = ''
as $$
  select a.id, a.worker_id, a.project_id, a.date, a.status, a.hours_worked,
    a.notes, a.recorded_by, a.is_founder_override, a.submitted_at, a.created_at,
    w.name, w.position, p.name,
    coalesce(a.worker_id = a.recorded_by, false)
      or strpos(coalesce(a.notes, ''), 'Pending Founder Review') > 0
      or strpos(coalesce(a.notes, ''), 'Founder Review:') > 0
      or strpos(lower(coalesce(w.position, '')), 'supervisor') > 0
      or exists (select 1 from public.users u where u.role = 'supervisor'
        and (u.id = w.id or lower(btrim(u.name)) = lower(btrim(w.name))))
  from public.attendance a
  left join public.workers w on w.id = a.worker_id
  left join public.projects p on p.id = a.project_id
  where (p_project_id is null or a.project_id = p_project_id)
    and (p_status is null or a.status = p_status)
    and (p_date is null or a.date = p_date)
    and (nullif(btrim(p_search), '') is null
      or strpos(lower(coalesce(w.name, '')), lower(btrim(p_search))) > 0
      or strpos(lower(coalesce(w.position, '')), lower(btrim(p_search))) > 0
      or strpos(lower(coalesce(p.name, '')), lower(btrim(p_search))) > 0
      or strpos(lower(coalesce(a.notes, '')), lower(btrim(p_search))) > 0)
$$;

-- A page contains at most p_limit groups or records. The extra row is only
-- used for has_more, so the PostgREST response limit cannot silently truncate it.
create or replace function public.attendance_history_page(
  p_mode text,
  p_project_id uuid default null,
  p_status text default null,
  p_date date default null,
  p_search text default null,
  p_cursor_date date default null,
  p_cursor_project_id uuid default null,
  p_cursor_id uuid default null,
  p_limit integer default 10
) returns jsonb
language plpgsql stable security invoker set search_path = ''
as $$
declare result jsonb;
begin
  if p_mode is null or p_mode not in ('sheets', 'records') then
    raise exception 'Invalid history page mode' using errcode = '22023';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 50 then
    raise exception 'Invalid history page size' using errcode = '22023';
  end if;
  if p_status is not null and p_status not in ('present','half_day','absent','leave') then
    raise exception 'Invalid attendance status' using errcode = '22023';
  end if;
  if length(coalesce(p_search, '')) > 200 then
    raise exception 'Search is too long' using errcode = '22023';
  end if;
  if p_mode = 'sheets' then
    if (p_cursor_date is null) <> (p_cursor_project_id is null) or p_cursor_id is not null then
      raise exception 'Invalid sheet cursor' using errcode = '22023';
    end if;
    with grouped as (
      select h.date, h.project_id, max(h.project_name) as project_name,
        count(*) as record_count,
        count(*) filter (where h.status = 'present') as present_count,
        count(*) filter (where h.status = 'half_day') as half_day_count,
        count(*) filter (where h.status = 'absent') as absent_count,
        count(*) filter (where h.status = 'leave') as leave_count,
        count(*) filter (where h.is_supervisor and not h.is_founder_override and h.status in ('present','half_day')) as pending_count
      from public.attendance_history_matching(p_project_id,p_status,p_date,p_search) h
      where p_cursor_date is null or h.date < p_cursor_date
        or (h.date = p_cursor_date and h.project_id > p_cursor_project_id)
      group by h.date,h.project_id
      order by h.date desc,h.project_id asc
      limit p_limit + 1
    ), visible as (
      select * from grouped order by date desc, project_id asc limit p_limit
    )
    select jsonb_build_object('has_more', (select count(*) > p_limit from grouped),
      'items', coalesce((select jsonb_agg(to_jsonb(v) order by v.date desc,v.project_id asc) from visible v), '[]'::jsonb)) into result;
  else
    if p_project_id is null or p_date is null or p_cursor_date is not null or p_cursor_project_id is not null then
      raise exception 'Record pages require a site and date' using errcode = '22023';
    end if;
    with records as (
      select h.* from public.attendance_history_matching(p_project_id,p_status,p_date,p_search) h
      where p_cursor_id is null or h.id > p_cursor_id
      order by h.id asc limit p_limit + 1
    ), visible as (
      select * from records order by id asc limit p_limit
    )
    select jsonb_build_object('has_more', (select count(*) > p_limit from records),
      'items', coalesce((select jsonb_agg(to_jsonb(v) order by v.id asc) from visible v), '[]'::jsonb)) into result;
  end if;
  return result;
end;
$$;

revoke all on function public.attendance_history_matching(uuid,text,date,text) from public, anon;
revoke all on function public.attendance_history_page(text,uuid,text,date,text,date,uuid,uuid,integer) from public, anon;
grant execute on function public.attendance_history_matching(uuid,text,date,text) to authenticated;
grant execute on function public.attendance_history_page(text,uuid,text,date,text,date,uuid,uuid,integer) to authenticated;

commit;
