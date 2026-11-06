-- One firm-wide SMS template. This adds no changes to existing tables or sending settings.
CREATE TABLE public.sms_template_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  message_template text NOT NULL CHECK (char_length(message_template) BETWEEN 1 AND 1000),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_by uuid REFERENCES public.users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.sms_template_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sms_template_settings FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.sms_template_settings TO authenticated;
GRANT ALL ON public.sms_template_settings TO service_role;
CREATE POLICY "Founders manage SMS template" ON public.sms_template_settings
  FOR ALL TO authenticated USING ((SELECT public.is_founder()))
  WITH CHECK ((SELECT public.is_founder()));
CREATE POLICY "mfa_session_required" ON public.sms_template_settings AS RESTRICTIVE
  FOR ALL TO authenticated USING ((SELECT public.session_assurance_satisfied()))
  WITH CHECK ((SELECT public.session_assurance_satisfied()));
