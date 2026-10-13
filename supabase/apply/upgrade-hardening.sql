-- ===========================================================================
-- BALE — security, AI & advance-request updates (already-migrated project)
-- ===========================================================================
--
-- The 2026-10-06 security/AI hardening plus the 2026-10-13 Bale request
-- workflow: private receipts + audit log, vendor memory, and Founder-reviewed
-- advance requests kept separate from issued advances. Requires the base
-- BALE schema and communications migration to already be present.
--
-- GENERATED FILE — do not edit. Regenerate with `npm run build:apply-sql`.
-- Generated: 2026-10-13T03:32:45.015Z
--
-- Source files (in execution order) and their SHA-256:
--   20261006000000_security_hardening.sql  5990a60a9251e5ff…
--   20261006000001_ai_draft_support.sql  b8bbb367efea29a3…
--   20261013000000_advance_requests.sql  a539492809adf02d…
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

commit;
