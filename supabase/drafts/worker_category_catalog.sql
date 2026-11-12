-- EXPERIMENTAL DRAFT. Not for the shared database or generated bundles.
-- Independent category catalog only: workers.position and all historical
-- attendance/payroll records remain unchanged. Selection/enforcement and legacy
-- position mapping need a separate reviewed design before this is deployable.

CREATE TABLE public.worker_categories (
  id uuid PRIMARY KEY,
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 80 AND label=btrim(label) AND label !~ '[[:cntrl:]]'),
  archived boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT
);
-- Archived names remain reserved so restoration cannot conflict or silently
-- give a historical category name a different identity.
CREATE UNIQUE INDEX worker_categories_label_unique ON public.worker_categories (lower(label));

CREATE TABLE public.worker_category_events (
  request_id uuid PRIMARY KEY,
  category_id uuid NOT NULL REFERENCES public.worker_categories(id) ON DELETE RESTRICT,
  actor_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN ('add','rename','archive','restore')),
  requested_label text,
  expected_revision integer,
  before_label text,
  before_archived boolean,
  after_label text NOT NULL,
  after_archived boolean NOT NULL,
  after_revision integer NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.worker_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.worker_category_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.worker_categories, public.worker_category_events FROM PUBLIC, anon, authenticated;
DO $$ BEGIN
  IF has_table_privilege('anon','public.worker_categories','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
    OR has_table_privilege('authenticated','public.worker_categories','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
    OR has_table_privilege('anon','public.worker_category_events','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
    OR has_table_privilege('authenticated','public.worker_category_events','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
  THEN RAISE EXCEPTION 'Unexpected inherited worker category table privilege'; END IF;
END $$;

-- Founder only. Empty arrays are genuine empty catalogs, not a failed read.
CREATE FUNCTION public.worker_category_catalog()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_categories jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT coalesce(public.session_assurance_satisfied(),false) OR NOT coalesce(public.is_founder(),false)
    THEN RAISE EXCEPTION 'Founder access required' USING ERRCODE='42501'; END IF;
  IF (SELECT count(*) FROM public.worker_categories)>500 THEN RAISE EXCEPTION 'Category catalog exceeds supported limit' USING ERRCODE='54000'; END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',c.id,'label',c.label,'archived',c.archived,'revision',c.revision)
    ORDER BY c.archived,lower(c.label),c.id),'[]'::jsonb) INTO v_categories FROM public.worker_categories c;
  RETURN v_categories;
END $$;
REVOKE ALL ON FUNCTION public.worker_category_catalog() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.worker_category_catalog() TO authenticated;

-- Request UUID supports exact replay after an uncertain network result. The
-- global lock bounds the catalog and serializes same-name create/rename and
-- retries. Optimistic revision prevents overwriting another Founder's edit.
CREATE FUNCTION public.change_worker_category(p_request_id uuid,p_category_id uuid,p_action text,p_label text,p_expected_revision integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid:=auth.uid(); v_old public.worker_categories%ROWTYPE; v_new public.worker_categories%ROWTYPE; v_event public.worker_category_events%ROWTYPE; v_label text;
BEGIN
  IF v_actor IS NULL OR NOT coalesce(public.session_assurance_satisfied(),false) OR NOT coalesce(public.is_founder(),false)
    THEN RAISE EXCEPTION 'Founder access required' USING ERRCODE='42501'; END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN RAISE EXCEPTION 'Category changes require read committed isolation' USING ERRCODE='P1002'; END IF;
  IF p_request_id IS NULL OR p_category_id IS NULL OR p_action IS NULL OR p_action NOT IN ('add','rename','archive','restore')
    THEN RAISE EXCEPTION 'Invalid category change' USING ERRCODE='22023'; END IF;
  IF p_action IN ('add','rename') THEN
    v_label:=btrim(p_label);
    IF v_label IS NULL OR length(v_label) NOT BETWEEN 1 AND 80 OR v_label ~ '[[:cntrl:]]'
      THEN RAISE EXCEPTION 'Enter a category name from 1 to 80 characters without control characters' USING ERRCODE='22023'; END IF;
  ELSE
    IF p_label IS NOT NULL THEN RAISE EXCEPTION 'Unexpected category label' USING ERRCODE='22023'; END IF;
  END IF;
  IF (p_action='add' AND p_expected_revision IS NOT NULL) OR (p_action<>'add' AND (p_expected_revision IS NULL OR p_expected_revision < 1))
    THEN RAISE EXCEPTION 'Invalid category revision' USING ERRCODE='22023'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('worker-category-catalog',0));
  SELECT * INTO v_event FROM public.worker_category_events WHERE request_id=p_request_id;
  IF FOUND THEN
    IF (v_event.category_id,v_event.actor_id,v_event.action,v_event.requested_label,v_event.expected_revision)
      IS DISTINCT FROM (p_category_id,v_actor,p_action,v_label,p_expected_revision)
      THEN RAISE EXCEPTION 'Request ID already used for a different category change' USING ERRCODE='22023'; END IF;
    RETURN jsonb_build_object('id',v_event.category_id,'label',v_event.after_label,'archived',v_event.after_archived,'revision',v_event.after_revision,'replayed',true);
  END IF;
  IF p_action='add' THEN
    IF (SELECT count(*) FROM public.worker_categories)>=500 THEN RAISE EXCEPTION 'Category catalog limit reached' USING ERRCODE='54000'; END IF;
    INSERT INTO public.worker_categories(id,label,created_by) VALUES(p_category_id,v_label,v_actor) RETURNING * INTO v_new;
  ELSE
    SELECT * INTO v_old FROM public.worker_categories WHERE id=p_category_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Category not found' USING ERRCODE='P0002'; END IF;
    IF v_old.revision<>p_expected_revision THEN RAISE EXCEPTION 'Category changed; refresh before editing' USING ERRCODE='40001'; END IF;
    IF (p_action='rename' AND (v_old.archived OR v_old.label=v_label)) OR (p_action='archive' AND v_old.archived) OR (p_action='restore' AND NOT v_old.archived)
      THEN RAISE EXCEPTION 'No category change to save' USING ERRCODE='22023'; END IF;
    UPDATE public.worker_categories SET label=CASE WHEN p_action='rename' THEN v_label ELSE label END,
      archived=CASE WHEN p_action='archive' THEN true WHEN p_action='restore' THEN false ELSE archived END,
      revision=revision+1 WHERE id=p_category_id RETURNING * INTO v_new;
  END IF;
  INSERT INTO public.worker_category_events(request_id,category_id,actor_id,action,requested_label,expected_revision,before_label,before_archived,after_label,after_archived,after_revision)
    VALUES(p_request_id,p_category_id,v_actor,p_action,v_label,p_expected_revision,v_old.label,v_old.archived,v_new.label,v_new.archived,v_new.revision);
  RETURN jsonb_build_object('id',v_new.id,'label',v_new.label,'archived',v_new.archived,'revision',v_new.revision,'replayed',false);
END $$;
REVOKE ALL ON FUNCTION public.change_worker_category(uuid,uuid,text,text,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.change_worker_category(uuid,uuid,text,text,integer) TO authenticated;

-- Founder can inspect history without exposing either table for client writes.
-- Keyset pagination preserves a stable order by timestamp and request UUID.
CREATE FUNCTION public.worker_category_history(p_category_id uuid,p_before_at timestamptz DEFAULT NULL,p_before_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_result jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT coalesce(public.session_assurance_satisfied(),false) OR NOT coalesce(public.is_founder(),false)
    THEN RAISE EXCEPTION 'Founder access required' USING ERRCODE='42501'; END IF;
  IF p_category_id IS NULL OR (p_before_at IS NULL)<>(p_before_id IS NULL)
    THEN RAISE EXCEPTION 'Invalid category history cursor' USING ERRCODE='22023'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.worker_categories WHERE id=p_category_id)
    THEN RAISE EXCEPTION 'Category not found' USING ERRCODE='P0002'; END IF;
  WITH page AS MATERIALIZED (
    SELECT request_id,actor_id,action,before_label,before_archived,after_label,after_archived,after_revision,occurred_at
    FROM public.worker_category_events WHERE category_id=p_category_id
      AND (p_before_at IS NULL OR (occurred_at,request_id)<(p_before_at,p_before_id))
    ORDER BY occurred_at DESC,request_id DESC LIMIT 101
  ), visible AS (SELECT * FROM page ORDER BY occurred_at DESC,request_id DESC LIMIT 100)
  SELECT jsonb_build_object('items',coalesce((SELECT jsonb_agg(to_jsonb(v) ORDER BY v.occurred_at DESC,v.request_id DESC) FROM visible v),'[]'::jsonb),
    'has_more',(SELECT count(*)>100 FROM page)) INTO v_result;
  RETURN v_result;
END $$;
REVOKE ALL ON FUNCTION public.worker_category_history(uuid,timestamptz,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.worker_category_history(uuid,timestamptz,uuid) TO authenticated;
