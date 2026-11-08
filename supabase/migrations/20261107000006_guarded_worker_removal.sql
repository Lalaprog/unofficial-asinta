-- Removal is an archive: preserve worker IDs, attendance, payroll and Bale.
-- This migration adds the mechanism only; it does not remove any worker.
ALTER TABLE public.workers ADD COLUMN removed_at timestamptz;
ALTER TABLE public.workers ADD CONSTRAINT removed_workers_are_inactive CHECK (removed_at IS NULL OR active = false);

CREATE OR REPLACE FUNCTION public.set_workers_removed_guarded(p_actor uuid, p_ids uuid[], p_remove boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_actor_email text;
  v_id uuid;
  v_before public.workers%ROWTYPE;
  v_after public.workers%ROWTYPE;
  v_project_ids uuid[];
  v_status text;
  v_results jsonb := '[]'::jsonb;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'WORKER_REMOVAL_REQUIRES_READ_COMMITTED' USING ERRCODE = 'P1002';
  END IF;
  PERFORM app_private.lock_founder_guard();
  SELECT email INTO v_actor_email FROM public.users WHERE id = p_actor AND role = 'founder';
  IF NOT FOUND THEN RAISE EXCEPTION 'Founder access is required.' USING ERRCODE = '42501'; END IF;
  IF p_remove IS NULL OR p_ids IS NULL OR cardinality(p_ids) < 1 OR cardinality(p_ids) > 100
    OR array_position(p_ids,NULL) IS NOT NULL OR (SELECT count(DISTINCT id) FROM unnest(p_ids) AS id) <> cardinality(p_ids) THEN
    RAISE EXCEPTION 'Invalid worker selection.' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid IN ('public.workers'::regclass,'public.project_worker_assignments'::regclass) AND NOT t.tgisinternal AND t.tgenabled <> 'D') THEN
    RAISE EXCEPTION 'WORKER_REMOVAL_SCHEMA_REVIEW_REQUIRED' USING ERRCODE = 'P1002';
  END IF;
  FOR v_id IN SELECT id FROM unnest(p_ids) id ORDER BY id LOOP
    SELECT * INTO v_before FROM public.workers WHERE id=v_id FOR UPDATE;
    IF NOT FOUND THEN
      v_results := v_results || jsonb_build_array(jsonb_build_object('id',v_id,'status','missing'));
      CONTINUE;
    END IF;
    IF p_remove AND v_before.removed_at IS NOT NULL THEN
      v_results := v_results || jsonb_build_array(jsonb_build_object('id',v_id,'status','already_removed'));
      CONTINUE;
    ELSIF NOT p_remove AND v_before.removed_at IS NULL THEN
      v_results := v_results || jsonb_build_array(jsonb_build_object('id',v_id,'status','already_available'));
      CONTINUE;
    END IF;
    v_project_ids := ARRAY[]::uuid[];
    IF p_remove THEN
      -- Keep the assignment rows for history, but remove current team access.
      WITH changed AS (
        UPDATE public.project_worker_assignments SET active=false,updated_at=now(),updated_by=p_actor
        WHERE worker_id=v_id AND active=true RETURNING project_id
      ) SELECT coalesce(array_agg(project_id ORDER BY project_id),ARRAY[]::uuid[]) INTO v_project_ids FROM changed;
      UPDATE public.workers SET active=false,removed_at=now() WHERE id=v_id RETURNING * INTO v_after;
      v_status := 'removed';
    ELSE
      -- Restoration is intentionally inactive. Re-activation and project team
      -- assignment remain separate, explicit decisions.
      UPDATE public.workers SET active=false,removed_at=NULL WHERE id=v_id RETURNING * INTO v_after;
      v_status := 'restored';
    END IF;
    INSERT INTO public.audit_log(actor_id,actor_email,action,table_name,record_id,before_row,after_row)
      VALUES(p_actor,v_actor_email,'update','workers',v_id,to_jsonb(v_before),jsonb_build_object('worker',to_jsonb(v_after),'removed_from_project_ids',to_jsonb(v_project_ids)));
    v_results := v_results || jsonb_build_array(jsonb_build_object('id',v_id,'status',v_status));
  END LOOP;
  RETURN jsonb_build_object('results',v_results);
END;
$$;
REVOKE ALL ON FUNCTION public.set_workers_removed_guarded(uuid,uuid[],boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_workers_removed_guarded(uuid,uuid[],boolean) TO service_role;
-- No routine client-side hard deletion: history must remain linked to workers.
REVOKE DELETE ON public.workers FROM PUBLIC, anon, authenticated;
