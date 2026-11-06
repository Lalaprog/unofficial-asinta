-- One private, explicitly saved expense draft per Founder. Drafts are never
-- included in expenses or any financial total. No existing policy is changed.
CREATE TABLE public.expense_drafts (
  owner_id uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  draft_id uuid NOT NULL UNIQUE,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  payload jsonb NOT NULL CHECK (pg_catalog.jsonb_typeof(payload) = 'object' AND pg_catalog.octet_length(payload::text) <= 100000),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.expense_drafts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.expense_drafts FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.expense_drafts TO authenticated;
GRANT ALL ON public.expense_drafts TO service_role;
CREATE POLICY "Founders manage their own expense draft" ON public.expense_drafts
  FOR ALL TO authenticated
  USING (owner_id = (SELECT auth.uid()) AND (SELECT public.is_founder()))
  WITH CHECK (owner_id = (SELECT auth.uid()) AND (SELECT public.is_founder()));
CREATE POLICY "mfa_session_required" ON public.expense_drafts AS RESTRICTIVE
  FOR ALL TO authenticated
  USING ((SELECT public.session_assurance_satisfied()))
  WITH CHECK ((SELECT public.session_assurance_satisfied()));
