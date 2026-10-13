-- ===========================================================================
-- BALE — full install (empty project)
-- ===========================================================================
--
-- Every schema migration, in order, EXCLUDING the demo seed.
-- Use this on a project with no BALE tables yet. It is NOT idempotent:
-- policies in the base schema use plain CREATE POLICY, so a second run
-- will fail. Check with verify-live.sql before running.
--
-- GENERATED FILE — do not edit. Regenerate with `npm run build:apply-sql`.
-- Generated: 2026-10-13T03:32:45.011Z
--
-- Source files (in execution order) and their SHA-256:
--   20260913000000_bale_schema.sql  df054d9d265045b9…
--   20260913000001_bale_schema_additions.sql  6138de8fd2fb508d…
--   20260929000000_communications.sql  d266ebf5209376c1…
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

-- @@ source: 20260913000000_bale_schema.sql

-- BALE (Billing & Advance Ledger Engine)
-- Asinta Architects - Database Schema & Security Policies (Supabase PostgreSQL)

-- Enable UUID extension
-- UUID primary keys use gen_random_uuid(), built into PostgreSQL 13+
-- (and always available on Supabase) — no extension required.

-- 1. USERS TABLE
CREATE TABLE IF NOT EXISTS public.users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('founder', 'supervisor')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. WORKERS TABLE
CREATE TABLE IF NOT EXISTS public.workers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    contact_number TEXT NOT NULL,
    position TEXT NOT NULL,
    pay_rate NUMERIC(10, 2) NOT NULL CHECK (pay_rate >= 0),
    pay_rate_type TEXT NOT NULL CHECK (pay_rate_type IN ('daily', 'hourly')),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. CLIENTS TABLE
CREATE TABLE IF NOT EXISTS public.clients (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    contact_person TEXT NOT NULL,
    phone TEXT NOT NULL,
    email TEXT NOT NULL,
    address TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. PROJECTS TABLE
CREATE TABLE IF NOT EXISTS public.projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE RESTRICT,
    location TEXT NOT NULL,
    budget_estimate NUMERIC(14, 2) NOT NULL CHECK (budget_estimate >= 0),
    status TEXT NOT NULL CHECK (status IN ('planning', 'active', 'on_hold', 'completed', 'cancelled')),
    start_date DATE NOT NULL,
    target_completion_date DATE NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5. PROJECT_SUPERVISORS RELATIONSHIP TABLE
CREATE TABLE IF NOT EXISTS public.project_supervisors (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
    supervisor_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(project_id, supervisor_id)
);

-- 6. INVOICES TABLE
CREATE TABLE IF NOT EXISTS public.invoices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE RESTRICT,
    client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE RESTRICT,
    invoice_number TEXT UNIQUE NOT NULL,
    amount NUMERIC(14, 2) NOT NULL CHECK (amount >= 0),
    amount_paid NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (amount_paid >= 0),
    issue_date DATE NOT NULL,
    due_date DATE NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('draft', 'pending', 'partially_paid', 'paid', 'overdue', 'cancelled')),
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 7. EXPENSES TABLE
CREATE TABLE IF NOT EXISTS public.expenses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE RESTRICT,
    description TEXT NOT NULL,
    category TEXT NOT NULL CHECK (category IN ('materials', 'labor', 'equipment', 'permits', 'transportation', 'other')),
    amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
    expense_date DATE NOT NULL,
    receipt_url TEXT,
    notes TEXT,
    ai_category_suggestion TEXT,
    ai_bale_detection BOOLEAN DEFAULT FALSE,
    ai_approval_suggestion TEXT,
    ai_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
    created_by UUID REFERENCES public.users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 8. ADVANCES (BALE) TABLE
CREATE TABLE IF NOT EXISTS public.advances (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    worker_id UUID NOT NULL REFERENCES public.workers(id) ON DELETE RESTRICT,
    project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE RESTRICT,
    amount NUMERIC(10, 2) NOT NULL CHECK (amount > 0),
    amount_deducted NUMERIC(10, 2) NOT NULL DEFAULT 0 CHECK (amount_deducted >= 0),
    reason TEXT NOT NULL,
    date DATE NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'partially_deducted', 'fully_deducted', 'cancelled')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 9. ATTENDANCE TABLE
CREATE TABLE IF NOT EXISTS public.attendance (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    worker_id UUID NOT NULL REFERENCES public.workers(id) ON DELETE RESTRICT,
    project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE RESTRICT,
    date DATE NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('present', 'absent', 'half_day', 'leave')),
    hours_worked NUMERIC(4, 2) NOT NULL DEFAULT 8.0 CHECK (hours_worked >= 0 AND hours_worked <= 24),
    notes TEXT,
    recorded_by UUID REFERENCES public.users(id),
    is_founder_override BOOLEAN NOT NULL DEFAULT FALSE,
    submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(worker_id, project_id, date)
);

-- 10. PAYROLL TABLE
CREATE TABLE IF NOT EXISTS public.payroll (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    worker_id UUID NOT NULL REFERENCES public.workers(id) ON DELETE RESTRICT,
    period_start DATE NOT NULL,
    period_end DATE NOT NULL,
    gross_pay NUMERIC(10, 2) NOT NULL CHECK (gross_pay >= 0),
    bale_deduction NUMERIC(10, 2) NOT NULL DEFAULT 0 CHECK (bale_deduction >= 0),
    other_deductions NUMERIC(10, 2) NOT NULL DEFAULT 0 CHECK (other_deductions >= 0),
    net_pay NUMERIC(10, 2) NOT NULL CHECK (net_pay >= 0),
    status TEXT NOT NULL CHECK (status IN ('draft', 'reviewed', 'approved', 'paid')),
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 11. TOOLS TABLE
CREATE TABLE IF NOT EXISTS public.tools (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 0),
    condition TEXT NOT NULL CHECK (condition IN ('excellent', 'good', 'fair', 'needs_repair', 'damaged')),
    project_id UUID REFERENCES public.projects(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 12. SMS LOGS TABLE
CREATE TABLE IF NOT EXISTS public.sms_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id UUID REFERENCES public.invoices(id) ON DELETE SET NULL,
    recipient TEXT NOT NULL,
    phone TEXT NOT NULL,
    message TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('delivered', 'sent', 'pending', 'failed')),
    sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- INDEXES
CREATE INDEX IF NOT EXISTS idx_projects_client_id ON public.projects(client_id);
CREATE INDEX IF NOT EXISTS idx_projects_status ON public.projects(status);
CREATE INDEX IF NOT EXISTS idx_invoices_project_id ON public.invoices(project_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON public.invoices(status);
CREATE INDEX IF NOT EXISTS idx_invoices_due_date ON public.invoices(due_date);
CREATE INDEX IF NOT EXISTS idx_expenses_project_id ON public.expenses(project_id);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON public.expenses(expense_date);
CREATE INDEX IF NOT EXISTS idx_advances_worker_id ON public.advances(worker_id);
CREATE INDEX IF NOT EXISTS idx_attendance_project_date ON public.attendance(project_id, date);
CREATE INDEX IF NOT EXISTS idx_attendance_worker_date ON public.attendance(worker_id, date);
CREATE INDEX IF NOT EXISTS idx_project_supervisors_sup ON public.project_supervisors(supervisor_id);

-- ENABLE ROW LEVEL SECURITY
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_supervisors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.advances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tools ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sms_logs ENABLE ROW LEVEL SECURITY;

-- HELPER FUNCTIONS FOR RLS
CREATE OR REPLACE FUNCTION public.current_user_role()
RETURNS TEXT AS $$
  SELECT role FROM public.users WHERE id = auth.uid();
$$ LANGUAGE sql STABLE SECURITY DEFINER;

CREATE OR REPLACE FUNCTION public.is_founder()
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.users
    WHERE id = auth.uid() AND role = 'founder'
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

CREATE OR REPLACE FUNCTION public.is_supervisor_assigned(proj_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.project_supervisors
    WHERE supervisor_id = auth.uid() AND project_id = proj_id
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- RLS POLICIES

-- 1. Users policies
CREATE POLICY "Founders have full access to users" ON public.users
  FOR ALL TO authenticated USING (public.is_founder());
CREATE POLICY "Supervisors can read their own profile" ON public.users
  FOR SELECT TO authenticated USING (auth.uid() = id);

-- 2. Projects policies
CREATE POLICY "Founders have full access to projects" ON public.projects
  FOR ALL TO authenticated USING (public.is_founder());
CREATE POLICY "Supervisors can view assigned projects only" ON public.projects
  FOR SELECT TO authenticated USING (public.is_supervisor_assigned(id));

-- 3. Project Supervisors policies
CREATE POLICY "Founders manage project supervisor assignments" ON public.project_supervisors
  FOR ALL TO authenticated USING (public.is_founder());
CREATE POLICY "Supervisors can view their own project assignments" ON public.project_supervisors
  FOR SELECT TO authenticated USING (supervisor_id = auth.uid());

-- 4. Invoices policies (Founder ONLY)
CREATE POLICY "Founders full access to invoices" ON public.invoices
  FOR ALL TO authenticated USING (public.is_founder());

-- 5. Clients policies (Founder ONLY)
CREATE POLICY "Founders full access to clients" ON public.clients
  FOR ALL TO authenticated USING (public.is_founder());

-- 6. Expenses policies (Founder ONLY)
CREATE POLICY "Founders full access to expenses" ON public.expenses
  FOR ALL TO authenticated USING (public.is_founder());

-- 7. Advances (Bale) policies (Founder ONLY)
CREATE POLICY "Founders full access to advances" ON public.advances
  FOR ALL TO authenticated USING (public.is_founder());

-- 8. Workers policies
CREATE POLICY "Founders full access to workers" ON public.workers
  FOR ALL TO authenticated USING (public.is_founder());
CREATE POLICY "Supervisors can view active workers" ON public.workers
  FOR SELECT TO authenticated USING (auth.uid() IS NOT NULL AND active = TRUE);

-- 9. Attendance policies
CREATE POLICY "Founders full access to attendance" ON public.attendance
  FOR ALL TO authenticated USING (public.is_founder());
CREATE POLICY "Supervisors can read attendance for assigned projects" ON public.attendance
  FOR SELECT TO authenticated USING (public.is_supervisor_assigned(project_id));
CREATE POLICY "Supervisors can insert attendance for assigned projects" ON public.attendance
  FOR INSERT TO authenticated WITH CHECK (public.is_supervisor_assigned(project_id));
CREATE POLICY "Supervisors can update attendance for assigned projects" ON public.attendance
  FOR UPDATE TO authenticated USING (public.is_supervisor_assigned(project_id));

-- 10. Payroll policies (Founder ONLY)
CREATE POLICY "Founders full access to payroll" ON public.payroll
  FOR ALL TO authenticated USING (public.is_founder());

-- 11. Tools policies
CREATE POLICY "Founders full access to tools" ON public.tools
  FOR ALL TO authenticated USING (public.is_founder());
CREATE POLICY "Supervisors can view tools on assigned projects" ON public.tools
  FOR SELECT TO authenticated USING (project_id IS NOT NULL AND public.is_supervisor_assigned(project_id));

-- 12. SMS logs policies (Founder ONLY)
CREATE POLICY "Founders full access to sms_logs" ON public.sms_logs
  FOR ALL TO authenticated USING (public.is_founder());


-- @@ source: 20260913000001_bale_schema_additions.sql

-- BALE (Billing & Advance Ledger Engine)
-- Schema additions: payroll attendance columns + Supabase Storage bucket for
-- expense receipts.

-- 1. Payroll: persist the attendance summary each run is computed from so
--    payslips can display days / hours worked.
alter table public.payroll
  add column if not exists days_worked NUMERIC(5, 2),
  add column if not exists hours_worked NUMERIC(6, 2);

-- 2. Receipts storage bucket -------------------------------------------------
-- Expense receipt photos are uploaded directly from the client to this
-- bucket; the resulting public URL is stored on expenses.receipt_url.
-- Uploads are restricted to authenticated Founders by the storage policies
-- below (leveraging the same public.is_founder() helper used for table RLS).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'receipts',
  'receipts',
  true,
  5242880, -- 5 MB
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do nothing;

-- Founders may upload receipt photos.
drop policy if exists "Founders can upload expense receipts" on storage.objects;
create policy "Founders can upload expense receipts"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'receipts'
    and public.is_founder()
  );

-- Founders may read receipt objects through the storage API.
drop policy if exists "Founders can read expense receipts" on storage.objects;
create policy "Founders can read expense receipts"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'receipts'
    and public.is_founder()
  );

-- Founders may replace or remove receipt photos.
drop policy if exists "Founders can update expense receipts" on storage.objects;
create policy "Founders can update expense receipts"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'receipts'
    and public.is_founder()
  );

drop policy if exists "Founders can delete expense receipts" on storage.objects;
create policy "Founders can delete expense receipts"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'receipts'
    and public.is_founder()
  );


-- @@ source: 20260929000000_communications.sql

-- BALE (Billing & Advance Ledger Engine)
-- Communications feature set: email templates, email logs, reminder
-- dispatches, invoice-level reminder settings, and honest SMS log fields.
--
-- This migration is ADDITIVE ONLY. It never modifies or weakens the policies
-- created by earlier migrations.

-- ---------------------------------------------------------------------------
-- 1. EMAIL TEMPLATES
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.email_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    template_type TEXT UNIQUE NOT NULL CHECK (template_type IN (
      'initial_request',
      'upcoming_reminder',
      'due_today',
      'overdue',
      'payment_acknowledgment',
      'final_demand'
    )),
    subject_template TEXT NOT NULL,
    body_template TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    updated_by UUID REFERENCES public.users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_templates_type ON public.email_templates(template_type);
CREATE INDEX IF NOT EXISTS idx_email_templates_active ON public.email_templates(active);

-- ---------------------------------------------------------------------------
-- 2. EMAIL LOGS — immutable snapshots of every send attempt
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.email_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id UUID NOT NULL REFERENCES public.invoices(id) ON DELETE RESTRICT,
    recipient TEXT NOT NULL,
    subject TEXT NOT NULL,
    body_text TEXT NOT NULL,
    body_html TEXT NOT NULL,
    template_type TEXT NOT NULL CHECK (template_type IN (
      'initial_request',
      'upcoming_reminder',
      'due_today',
      'overdue',
      'payment_acknowledgment',
      'final_demand'
    )),
    template_version INTEGER NOT NULL DEFAULT 1,
    -- 'accepted' means the SMTP server accepted the message. 'delivered' is
    -- reserved for explicit provider delivery confirmations only.
    status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'failed', 'delivered', 'bounced')),
    provider_message_id TEXT,
    error_message TEXT,
    sent_by UUID REFERENCES public.users(id),
    sent_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    idempotency_key TEXT UNIQUE NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_email_logs_invoice_id ON public.email_logs(invoice_id);
CREATE INDEX IF NOT EXISTS idx_email_logs_status ON public.email_logs(status);
CREATE INDEX IF NOT EXISTS idx_email_logs_template_type ON public.email_logs(template_type);
CREATE INDEX IF NOT EXISTS idx_email_logs_sent_at ON public.email_logs(sent_at);
CREATE INDEX IF NOT EXISTS idx_email_logs_created_at ON public.email_logs(created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_logs_idempotency_key ON public.email_logs(idempotency_key);

-- ---------------------------------------------------------------------------
-- 3. REMINDER DISPATCHES — idempotency ledger for scheduled reminders
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.reminder_dispatches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id UUID NOT NULL REFERENCES public.invoices(id) ON DELETE RESTRICT,
    channel TEXT NOT NULL CHECK (channel IN ('sms', 'email')),
    reminder_type TEXT NOT NULL CHECK (reminder_type IN ('upcoming', 'due_today', 'overdue', 'follow_up')),
    scheduled_date DATE NOT NULL,
    idempotency_key TEXT UNIQUE NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
    provider_message_id TEXT,
    error_message TEXT,
    sent_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reminder_dispatches_invoice_id ON public.reminder_dispatches(invoice_id);
CREATE INDEX IF NOT EXISTS idx_reminder_dispatches_status ON public.reminder_dispatches(status);
CREATE INDEX IF NOT EXISTS idx_reminder_dispatches_scheduled ON public.reminder_dispatches(scheduled_date);
CREATE INDEX IF NOT EXISTS idx_reminder_dispatches_created ON public.reminder_dispatches(created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reminder_dispatches_idem ON public.reminder_dispatches(idempotency_key);

-- ---------------------------------------------------------------------------
-- 4. INVOICE-LEVEL REMINDER SETTINGS (defaults are OFF)
-- ---------------------------------------------------------------------------
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS automatic_reminders_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS reminders_paused_until TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_invoices_auto_reminders ON public.invoices(automatic_reminders_enabled);

-- ---------------------------------------------------------------------------
-- 5. HONEST SMS LOG FIELDS (additive — historical rows keep working)
-- ---------------------------------------------------------------------------
ALTER TABLE public.sms_logs
  ADD COLUMN IF NOT EXISTS provider_message_id TEXT,
  ADD COLUMN IF NOT EXISTS error_message TEXT,
  ADD COLUMN IF NOT EXISTS simulated BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS provider_status TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_sms_logs_invoice_id ON public.sms_logs(invoice_id);
CREATE INDEX IF NOT EXISTS idx_sms_logs_status ON public.sms_logs(status);
CREATE INDEX IF NOT EXISTS idx_sms_logs_sent_at ON public.sms_logs(sent_at);

-- ---------------------------------------------------------------------------
-- 6. ROW LEVEL SECURITY — Founder-only billing communications.
--    Supervisors have NO access. The service-role key (used only by the
--    server-side cron route) bypasses RLS by design and never reaches the
--    browser.
-- ---------------------------------------------------------------------------
ALTER TABLE public.email_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reminder_dispatches ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Founders full access to email_templates" ON public.email_templates;
CREATE POLICY "Founders full access to email_templates" ON public.email_templates
  FOR ALL TO authenticated USING (public.is_founder());

DROP POLICY IF EXISTS "Founders full access to email_logs" ON public.email_logs;
CREATE POLICY "Founders full access to email_logs" ON public.email_logs
  FOR ALL TO authenticated USING (public.is_founder());

DROP POLICY IF EXISTS "Founders full access to reminder_dispatches" ON public.reminder_dispatches;
CREATE POLICY "Founders full access to reminder_dispatches" ON public.reminder_dispatches
  FOR ALL TO authenticated USING (public.is_founder());

-- ---------------------------------------------------------------------------
-- 7. SEED THE DEFAULT "INITIAL REQUEST FOR PAYMENT" TEMPLATE (idempotent)
-- ---------------------------------------------------------------------------
INSERT INTO public.email_templates (template_type, subject_template, body_template, version, active)
VALUES (
  'initial_request',
  'Request for Payment – {{project_name}} – {{invoice_number}}',
  E'Dear {{client_contact_name}},\n\nGood day.\n\nPlease find below the Request for Payment from Asinta Architects for the project {{project_name}}.\n\nInvoice Number: {{invoice_number}}\nInvoice Date: {{issue_date}}\nTotal Invoice Amount: {{invoice_amount}}\nPayments Received: {{amount_paid}}\nOutstanding Balance: {{outstanding_balance}}\nPayment Due Date: {{due_date}}\n\n{{invoice_notes}}\n\nWe kindly request that payment be settled on or before the stated due date. If payment has already been made, please disregard this request and send us the payment confirmation for proper recording.\n\nFor questions or clarifications regarding this billing, you may reply to this email or contact Asinta Architects directly.\n\nThank you for your continued trust and support.\n\nGod bless.\n\nSincerely,\n\nAsinta Architects\n{{firm_email}}\n{{firm_contact_number}}\n\nThis email was generated through the BALE management system.',
  1,
  TRUE
)
ON CONFLICT (template_type) DO NOTHING;


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
