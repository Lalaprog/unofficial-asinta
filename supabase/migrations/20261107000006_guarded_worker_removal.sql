-- Worker removal is intentionally limited to rows without linked data.
-- This migration does not modify any worker, attendance or payroll records.
CREATE OR REPLACE FUNCTION public.delete_workers_guarded(p_actor uuid, p_ids uuid[])
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_actor_email text;
  v_id uuid;
  v_worker public.workers%ROWTYPE;
  v_ref record;
  v_referenced boolean;
  v_reasons jsonb;
  v_results jsonb := '[]'::jsonb;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'WORKER_REMOVAL_REQUIRES_READ_COMMITTED' USING ERRCODE = 'P1002';
  END IF;
  PERFORM app_private.lock_founder_guard();
  SELECT email INTO v_actor_email FROM public.users WHERE id = p_actor AND role = 'founder';
  IF NOT FOUND THEN RAISE EXCEPTION 'Founder access is required.' USING ERRCODE = '42501'; END IF;
  IF p_ids IS NULL OR cardinality(p_ids) < 1 OR cardinality(p_ids) > 100 OR array_position(p_ids, NULL) IS NOT NULL
    OR (SELECT count(DISTINCT id) FROM unnest(p_ids) AS id) <> cardinality(p_ids) THEN
    RAISE EXCEPTION 'Invalid worker selection.' USING ERRCODE = '22023';
  END IF;
  -- Unknown triggers may introduce side effects which a reference check misses.
  IF EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.workers'::regclass AND NOT t.tgisinternal AND t.tgenabled <> 'D') THEN
    RAISE EXCEPTION 'WORKER_REMOVAL_SCHEMA_REVIEW_REQUIRED' USING ERRCODE = 'P1002';
  END IF;
  -- Fixed order prevents two deletion batches from deadlocking on worker rows.
  FOR v_id IN SELECT id FROM unnest(p_ids) id ORDER BY id LOOP
    SELECT * INTO v_worker FROM public.workers WHERE id = v_id FOR UPDATE;
    IF NOT FOUND THEN
      v_results := v_results || jsonb_build_array(jsonb_build_object('id',v_id,'status','missing'));
      CONTINUE;
    END IF;
    -- Account links are conventionally worker.id = user.id; protect orphaned
    -- Auth accounts too. Auth and public profile changes are not atomic.
    IF EXISTS (SELECT 1 FROM public.users WHERE id = v_id) OR EXISTS (SELECT 1 FROM auth.users WHERE id = v_id) THEN
      v_results := v_results || jsonb_build_array(jsonb_build_object('id',v_id,'status','account'));
      CONTINUE;
    END IF;
    v_reasons := '[]'::jsonb;
    -- Check every FK, including SET NULL/CASCADE and future tables. The worker
    -- row lock makes concurrent FK insertions wait. Composite FKs fail closed.
    FOR v_ref IN
      SELECT n.nspname,t.relname,c.conkey,c.confkey,a.attname AS column_name
      FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
      JOIN pg_namespace n ON n.oid=t.relnamespace
      LEFT JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=c.conkey[1]
      WHERE c.contype='f' AND c.confrelid='public.workers'::regclass
    LOOP
      IF array_length(v_ref.conkey,1) IS DISTINCT FROM 1 OR array_length(v_ref.confkey,1) IS DISTINCT FROM 1
        OR v_ref.column_name IS NULL OR v_ref.confkey[1] <> (SELECT attnum FROM pg_attribute WHERE attrelid='public.workers'::regclass AND attname='id' AND NOT attisdropped) THEN
        RAISE EXCEPTION 'WORKER_REMOVAL_SCHEMA_REVIEW_REQUIRED' USING ERRCODE='P1002';
      END IF;
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.%I WHERE %I = $1)',v_ref.nspname,v_ref.relname,v_ref.column_name)
        INTO v_referenced USING v_id;
      IF v_referenced THEN
        v_reasons := v_reasons || jsonb_build_array(CASE
          WHEN v_ref.nspname='public' AND v_ref.relname='attendance' THEN 'Attendance'
          WHEN v_ref.nspname='public' AND v_ref.relname='payroll' THEN 'Payroll'
          WHEN v_ref.nspname='public' AND v_ref.relname IN ('advances','advance_requests') THEN 'Advances or Bale requests'
          WHEN v_ref.nspname='public' AND v_ref.relname='project_worker_assignments' THEN 'Project assignment records'
          WHEN v_ref.nspname='public' AND v_ref.relname='user_notifications' THEN 'Notifications'
          WHEN v_ref.nspname='app_private' AND v_ref.relname='project_worker_create_requests' THEN 'Registration records'
          ELSE 'Other linked records' END);
      END IF;
    END LOOP;
    IF jsonb_array_length(v_reasons) > 0 THEN
      v_results := v_results || jsonb_build_array(jsonb_build_object('id',v_id,'status','linked','reasons',v_reasons));
      CONTINUE;
    END IF;
    DELETE FROM public.workers WHERE id = v_id;
    INSERT INTO public.audit_log(actor_id,actor_email,action,table_name,record_id,before_row,after_row)
      VALUES(p_actor,v_actor_email,'delete','workers',v_id,to_jsonb(v_worker),NULL);
    v_results := v_results || jsonb_build_array(jsonb_build_object('id',v_id,'status','deleted'));
  END LOOP;
  RETURN jsonb_build_object('results',v_results);
END;
$$;
REVOKE ALL ON FUNCTION public.delete_workers_guarded(uuid,uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_workers_guarded(uuid,uuid[]) TO service_role;
-- Existing application flows do not delete workforce rows directly. Keep this
-- destructive action behind the guarded endpoint, including old clients.
REVOKE DELETE ON public.workers FROM PUBLIC, anon, authenticated;
