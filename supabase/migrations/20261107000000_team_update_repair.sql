-- Targeted repair for installations missing the guarded team-profile update.
-- The deletion RPC is intentionally NOT installed by this repair: later schema
-- additions need a fresh deletion dependency review. No existing rows are changed.
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


REVOKE ALL ON FUNCTION public.update_team_profile_guarded(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_team_profile_guarded(uuid, uuid, text, text) TO service_role;
