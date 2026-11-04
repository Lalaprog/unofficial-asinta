export const founder = '00000000-0000-0000-0000-000000000001';
export const supervisor = '00000000-0000-0000-0000-000000000002';
export const invoice = '00000000-0000-0000-0000-000000000003';
export const otherInvoice = '00000000-0000-0000-0000-000000000004';
export const request = '00000000-0000-4000-8000-000000000005';
export const secondRequest = '00000000-0000-4000-8000-000000000006';
export const invoiceFixture = `
  CREATE ROLE anon; CREATE ROLE authenticated;
  CREATE SCHEMA auth;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
    SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  CREATE TABLE public.users(id uuid PRIMARY KEY, email text, role text);
  CREATE FUNCTION public.is_founder() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
    SELECT EXISTS(SELECT 1 FROM public.users WHERE id=auth.uid() AND role='founder')
  $$;
  CREATE TABLE public.invoices (
    id uuid PRIMARY KEY, project_id uuid, client_id uuid, invoice_number text UNIQUE,
    amount numeric(14,2) NOT NULL CHECK(amount >= 0), amount_paid numeric(14,2) NOT NULL DEFAULT 0 CHECK(amount_paid >= 0),
    issue_date date, due_date date, status text NOT NULL CHECK(status IN ('draft','pending','partially_paid','paid','overdue','cancelled')),
    notes text, created_at timestamptz DEFAULT now(), automatic_reminders_enabled boolean NOT NULL DEFAULT false,
    reminders_paused_until timestamptz
  );
  CREATE TABLE public.audit_log(id uuid DEFAULT gen_random_uuid(), actor_id uuid, actor_email text, action text,
    table_name text, record_id uuid, before_row jsonb, after_row jsonb, created_at timestamptz DEFAULT now());
  ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;
  CREATE POLICY founder_invoice ON public.invoices FOR ALL TO authenticated USING (public.is_founder()) WITH CHECK (public.is_founder());
  GRANT USAGE ON SCHEMA public, auth TO authenticated, anon;
  GRANT SELECT, INSERT, UPDATE, DELETE ON public.invoices TO authenticated;
  -- Pre-existing column grants must also be revoked by the migration.
  GRANT UPDATE(amount_paid, status) ON public.invoices TO authenticated;
  INSERT INTO public.users VALUES ('${founder}', 'founder@example.test', 'founder'), ('${supervisor}', 'supervisor@example.test', 'supervisor');
  INSERT INTO public.invoices(id, invoice_number, amount, amount_paid, status) VALUES
    ('${invoice}','INV-1',100,0,'pending'), ('${otherInvoice}','INV-2',100,0,'pending');
`;
export const paymentSQL = 'SELECT public.record_invoice_payment_atomic($1,$2,$3,$4,$5,$6) AS result';
