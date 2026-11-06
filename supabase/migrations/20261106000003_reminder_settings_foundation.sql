-- Safe foundation only: automatic sending cannot be switched on until a later,
-- separately reviewed migration removes the temporary rollout constraint.
CREATE TABLE public.reminder_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  master_enabled boolean NOT NULL DEFAULT false,
  email_enabled boolean NOT NULL DEFAULT false,
  sms_enabled boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES public.users(id),
  CONSTRAINT reminder_settings_rollout_locked CHECK (master_enabled = false)
);

INSERT INTO public.reminder_settings (singleton) VALUES (true);
ALTER TABLE public.reminder_settings ENABLE ROW LEVEL SECURITY;
-- Supabase projects may have broad default grants: explicitly remove them.
REVOKE ALL ON public.reminder_settings FROM PUBLIC, anon, authenticated;
GRANT SELECT, UPDATE ON public.reminder_settings TO authenticated;
GRANT SELECT, UPDATE ON public.reminder_settings TO service_role;
CREATE POLICY "Founders manage reminder settings" ON public.reminder_settings
  FOR ALL TO authenticated USING ((SELECT public.is_founder()))
  WITH CHECK ((SELECT public.is_founder()));
CREATE POLICY "mfa_session_required" ON public.reminder_settings AS RESTRICTIVE
  FOR ALL TO authenticated USING ((SELECT public.session_assurance_satisfied()))
  WITH CHECK ((SELECT public.session_assurance_satisfied()));

-- Revisions and change timestamps are server-controlled even for direct RLS
-- clients. The API uses revision in its UPDATE predicate to reject stale tabs.
CREATE FUNCTION public.stamp_reminder_settings() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  NEW.singleton := OLD.singleton;
  NEW.revision := OLD.revision + 1;
  NEW.updated_at := now();
  NEW.updated_by := auth.uid();
  RETURN NEW;
END;
$$;
CREATE TRIGGER reminder_settings_stamp BEFORE UPDATE ON public.reminder_settings
  FOR EACH ROW EXECUTE FUNCTION public.stamp_reminder_settings();
REVOKE ALL ON FUNCTION public.stamp_reminder_settings() FROM PUBLIC, anon, authenticated;
