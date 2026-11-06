-- Isolated private storage. No existing project columns or storage policies change.
-- Only trusted server routes can access the metadata or the bucket; they verify
-- the caller's session assurance and visible project before using service_role.
-- Fail closed if a new broad Storage policy could expose this private bucket.
-- The reviewed existing policies are receipt-only; no new policy is installed.
DO $$
BEGIN
  LOCK TABLE storage.objects, storage.buckets IN SHARE MODE;
  PERFORM pg_catalog.set_config('search_path', '', true);
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_policy WHERE polrelid = 'storage.objects'::pg_catalog.regclass) <> 4
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_policy p
      WHERE p.polrelid = 'storage.objects'::pg_catalog.regclass
        AND p.polpermissive AND p.polroles = ARRAY['authenticated'::pg_catalog.regrole::pg_catalog.oid]
        AND ((p.polname = 'Founders can read expense receipts' AND p.polcmd = 'r')
          OR (p.polname = 'Founders can update expense receipts' AND p.polcmd = 'w')
          OR (p.polname = 'Founders can delete expense receipts' AND p.polcmd = 'd'))
        AND pg_catalog.pg_get_expr(p.polqual, p.polrelid) = $predicate$((bucket_id = 'receipts'::text) AND public.is_founder())$predicate$
        AND p.polwithcheck IS NULL) <> 3
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_policy p
      WHERE p.polrelid = 'storage.objects'::pg_catalog.regclass
        AND p.polpermissive AND p.polroles = ARRAY['authenticated'::pg_catalog.regrole::pg_catalog.oid]
        AND p.polname = 'Founders can upload expense receipts' AND p.polcmd = 'a'
        AND p.polqual IS NULL
        AND pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) = $predicate$((bucket_id = 'receipts'::text) AND public.is_founder())$predicate$) <> 1 THEN
    RAISE EXCEPTION 'Storage policies differ from the reviewed receipt-only policies';
  END IF;
END $$;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('project-photos', 'project-photos', false, 3145728, ARRAY['image/jpeg','image/png','image/webp']);

CREATE TABLE public.project_photos (
  project_id uuid PRIMARY KEY REFERENCES public.projects(id) ON DELETE CASCADE,
  object_path text NOT NULL UNIQUE,
  version uuid NOT NULL DEFAULT gen_random_uuid(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.project_photos ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.project_photos FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.project_photos TO service_role;
