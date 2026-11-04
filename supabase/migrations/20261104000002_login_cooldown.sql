-- Additive prerequisite for the app's shared, per-account-and-network password
-- cooldown. The app must not depend on this until it is installed and checked.
-- This does not limit direct requests to Supabase Auth; provider protections
-- remain necessary. No passwords, email addresses or IP addresses are stored.
CREATE TABLE IF NOT EXISTS public.login_cooldown_buckets (
  bucket_key text PRIMARY KEY CHECK (bucket_key ~ '^[0-9a-f]{64}$'),
  failures integer NOT NULL DEFAULT 0 CHECK (failures BETWEEN 0 AND 5),
  last_failure_at timestamptz,
  locked_until timestamptz,
  touched_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.login_cooldown_reservations (
  token uuid PRIMARY KEY,
  bucket_key text NOT NULL REFERENCES public.login_cooldown_buckets(bucket_key) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS login_cooldown_reservations_bucket_idx ON public.login_cooldown_reservations(bucket_key);
ALTER TABLE public.login_cooldown_buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.login_cooldown_reservations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.login_cooldown_buckets, public.login_cooldown_reservations FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.reserve_login_attempt(p_bucket text, p_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE b public.login_cooldown_buckets%ROWTYPE; v_now timestamptz := clock_timestamp(); v_pending integer;
BEGIN
  IF p_bucket IS NULL OR p_bucket !~ '^[0-9a-f]{64}$' OR p_token IS NULL THEN RAISE EXCEPTION 'Invalid login guard input'; END IF;
  IF random() < 0.01 AND pg_try_advisory_xact_lock(hashtextextended('asinta_login_guard_cleanup', 0)) THEN
    DELETE FROM public.login_cooldown_buckets WHERE bucket_key IN (
      SELECT bucket_key FROM public.login_cooldown_buckets
      WHERE touched_at < v_now - interval '1 day'
      ORDER BY touched_at LIMIT 100 FOR UPDATE SKIP LOCKED
    );
  END IF;
  INSERT INTO public.login_cooldown_buckets(bucket_key,touched_at) VALUES (p_bucket,v_now) ON CONFLICT (bucket_key) DO NOTHING;
  SELECT * INTO b FROM public.login_cooldown_buckets WHERE bucket_key=p_bucket FOR UPDATE;
  v_now := clock_timestamp();
  DELETE FROM public.login_cooldown_reservations WHERE bucket_key=p_bucket AND expires_at <= v_now;
  IF b.locked_until IS NOT NULL AND b.locked_until > v_now THEN
    UPDATE public.login_cooldown_buckets SET touched_at=v_now WHERE bucket_key=p_bucket;
    RETURN jsonb_build_object('allowed',false,'retry_after',greatest(1,ceil(extract(epoch FROM b.locked_until-v_now))::integer));
  END IF;
  IF b.locked_until IS NOT NULL OR (b.last_failure_at IS NOT NULL AND b.last_failure_at <= v_now - interval '15 minutes') THEN
    UPDATE public.login_cooldown_buckets SET failures=0,last_failure_at=NULL,locked_until=NULL WHERE bucket_key=p_bucket;
    b.failures := 0;
  END IF;
  SELECT count(*) INTO v_pending FROM public.login_cooldown_reservations WHERE bucket_key=p_bucket;
  IF b.failures + v_pending >= 5 THEN
    RETURN jsonb_build_object('allowed',false,'retry_after',2);
  END IF;
  INSERT INTO public.login_cooldown_reservations(token,bucket_key,expires_at) VALUES(p_token,p_bucket,v_now+interval '2 minutes');
  UPDATE public.login_cooldown_buckets SET touched_at=v_now WHERE bucket_key=p_bucket;
  RETURN jsonb_build_object('allowed',true,'retry_after',0);
END $$;

CREATE OR REPLACE FUNCTION public.finish_login_attempt(p_bucket text,p_token uuid,p_outcome text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE b public.login_cooldown_buckets%ROWTYPE; v_now timestamptz := clock_timestamp(); v_deleted integer;
BEGIN
  IF p_bucket IS NULL OR p_bucket !~ '^[0-9a-f]{64}$' OR p_token IS NULL OR p_outcome IS NULL OR p_outcome NOT IN ('failure','success','unknown') THEN RAISE EXCEPTION 'Invalid login guard input'; END IF;
  SELECT * INTO b FROM public.login_cooldown_buckets WHERE bucket_key=p_bucket FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('confirmed',false); END IF;
  v_now := clock_timestamp();
  DELETE FROM public.login_cooldown_reservations WHERE bucket_key=p_bucket AND token=p_token AND expires_at>v_now;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  IF v_deleted=0 THEN RETURN jsonb_build_object('confirmed',false); END IF;
  IF p_outcome='failure' THEN
    UPDATE public.login_cooldown_buckets SET failures=least(failures+1,5),last_failure_at=v_now,locked_until=CASE WHEN failures+1>=5 THEN v_now+interval '5 minutes' ELSE locked_until END,touched_at=v_now WHERE bucket_key=p_bucket RETURNING * INTO b;
  ELSIF p_outcome='success' THEN
    UPDATE public.login_cooldown_buckets SET failures=0,last_failure_at=NULL,locked_until=NULL,touched_at=v_now WHERE bucket_key=p_bucket RETURNING * INTO b;
  ELSE
    UPDATE public.login_cooldown_buckets SET touched_at=v_now WHERE bucket_key=p_bucket;
  END IF;
  RETURN jsonb_build_object('confirmed',true,'retry_after',CASE WHEN b.locked_until>v_now THEN greatest(1,ceil(extract(epoch FROM b.locked_until-v_now))::integer) ELSE 0 END);
END $$;
REVOKE ALL ON FUNCTION public.reserve_login_attempt(text,uuid), public.finish_login_attempt(text,uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_login_attempt(text,uuid), public.finish_login_attempt(text,uuid,text) TO service_role;
