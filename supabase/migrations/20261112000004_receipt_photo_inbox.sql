-- Receipt inbox entries are not expenses. Preserve existing receipts and policies.
-- A pending entry records the identity before upload so an interrupted upload
-- can be recovered; ready requires the object to exist. No browser deletion.
CREATE TABLE public.receipt_photo_inbox (
  id uuid PRIMARY KEY,
  saved_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  object_path text NOT NULL UNIQUE CHECK(length(object_path) <= 180),
  file_name text NOT NULL CHECK(length(btrim(file_name)) BETWEEN 1 AND 200),
  mime_type text NOT NULL CHECK(mime_type IN ('image/jpeg','image/png','image/webp')),
  file_size integer NOT NULL CHECK(file_size BETWEEN 1 AND 5242880),
  sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','ready')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (saved_by IS NULL OR object_path = saved_by::text || '/inbox/' || id::text ||
    CASE mime_type WHEN 'image/jpeg' THEN '.jpg' WHEN 'image/png' THEN '.png' ELSE '.webp' END)
);
CREATE INDEX receipt_photo_inbox_order_idx ON public.receipt_photo_inbox(created_at DESC,id DESC);
ALTER TABLE public.receipt_photo_inbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.receipt_photo_inbox FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.receipt_photo_inbox TO authenticated;
GRANT INSERT(id,saved_by,object_path,file_name,mime_type,file_size,sha256) ON public.receipt_photo_inbox TO authenticated;
GRANT UPDATE(status) ON public.receipt_photo_inbox TO authenticated;
GRANT ALL ON public.receipt_photo_inbox TO service_role;
CREATE POLICY "Founders view receipt inbox" ON public.receipt_photo_inbox FOR SELECT TO authenticated USING ((SELECT public.is_founder()));
CREATE POLICY "Founders start their receipt uploads" ON public.receipt_photo_inbox FOR INSERT TO authenticated WITH CHECK (saved_by=(SELECT auth.uid()) AND (SELECT public.is_founder()) AND status='pending');
CREATE POLICY "Founders finish their receipt uploads" ON public.receipt_photo_inbox FOR UPDATE TO authenticated USING (saved_by=(SELECT auth.uid()) AND (SELECT public.is_founder())) WITH CHECK (saved_by=(SELECT auth.uid()) AND (SELECT public.is_founder()));
CREATE POLICY "mfa_session_required" ON public.receipt_photo_inbox AS RESTRICTIVE FOR ALL TO authenticated USING ((SELECT public.session_assurance_satisfied())) WITH CHECK ((SELECT public.session_assurance_satisfied()));

CREATE FUNCTION public.receipt_inbox_ready_guard() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
  IF OLD.status <> 'pending' OR NEW.status <> 'ready' THEN RAISE EXCEPTION 'Invalid receipt state' USING ERRCODE='22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id='receipts' AND o.name=OLD.object_path) THEN
    RAISE EXCEPTION 'Receipt object not found' USING ERRCODE='22023';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.receipt_inbox_ready_guard() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER receipt_inbox_ready_guard BEFORE UPDATE OF status ON public.receipt_photo_inbox FOR EACH ROW EXECUTE FUNCTION public.receipt_inbox_ready_guard();

CREATE FUNCTION public.receipt_photo_inbox_page(p_cursor_at timestamptz DEFAULT NULL,p_cursor_id uuid DEFAULT NULL,p_limit integer DEFAULT 20)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $$
DECLARE v_result jsonb;
BEGIN
  IF NOT coalesce(public.is_founder(),false) THEN RAISE EXCEPTION 'Founder access required' USING ERRCODE='42501'; END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 OR (p_cursor_at IS NULL) <> (p_cursor_id IS NULL) THEN RAISE EXCEPTION 'Invalid cursor' USING ERRCODE='22023'; END IF;
  WITH entries AS MATERIALIZED (
    SELECT id,saved_by,object_path,file_name,mime_type,file_size,sha256,status,created_at
    FROM public.receipt_photo_inbox WHERE p_cursor_at IS NULL OR (created_at,id)<(p_cursor_at,p_cursor_id)
    ORDER BY created_at DESC,id DESC LIMIT p_limit+1
  ), page AS (SELECT * FROM entries ORDER BY created_at DESC,id DESC LIMIT p_limit)
  SELECT jsonb_build_object('items',coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.created_at DESC,x.id DESC) FROM page x),'[]'::jsonb),
    'has_more',(SELECT count(*)>p_limit FROM entries)) INTO v_result;
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.receipt_photo_inbox_page(timestamptz,uuid,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.receipt_photo_inbox_page(timestamptz,uuid,integer) TO authenticated;
