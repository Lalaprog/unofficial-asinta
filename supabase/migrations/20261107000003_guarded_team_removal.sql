-- This guard preserves attribution and historical records. It removes only an
-- unreferenced profile; project assignments and personal notifications are
-- explicitly allowed to cascade. Auth removal remains a separate API call.
CREATE OR REPLACE FUNCTION public.delete_team_profile_guarded(p_actor uuid, p_target uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_target public.users%ROWTYPE;
  v_actor_email text;
  v_ref record;
  v_referenced boolean;
BEGIN
  -- Each reference check must see commits that completed while waiting for the
  -- target row lock. Fail closed under stale transaction snapshots.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'TEAM_REMOVAL_REQUIRES_READ_COMMITTED' USING ERRCODE = 'P1002';
  END IF;
  PERFORM app_private.lock_founder_guard();
  SELECT email INTO v_actor_email FROM public.users WHERE id = p_actor AND role = 'founder';
  IF NOT FOUND THEN RAISE EXCEPTION 'Founder access is required.' USING ERRCODE = '42501'; END IF;
  IF p_target IS NULL OR p_target = p_actor THEN RAISE EXCEPTION 'You cannot remove your own account.' USING ERRCODE = '22023'; END IF;
  SELECT * INTO v_target FROM public.users WHERE id = p_target FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Team account not found.' USING ERRCODE = 'P0002'; END IF;
  IF v_target.role = 'founder' AND (SELECT count(*) FROM public.users WHERE role = 'founder') <= 1 THEN
    RAISE EXCEPTION 'Cannot remove the last Founder account.' USING ERRCODE = '23514';
  END IF;
  -- Later custom triggers could have side effects beyond FK cascades.
  IF EXISTS (
    SELECT 1 FROM pg_trigger t
    WHERE NOT t.tgisinternal AND t.tgenabled <> 'D'
      AND t.tgrelid IN ('public.users'::regclass, 'public.project_supervisors'::regclass, 'public.user_notifications'::regclass)
      AND NOT (t.tgrelid = 'public.users'::regclass AND t.tgname IN ('lock_user_mutations', 'check_founder_after_update', 'check_founder_after_delete', 'prevent_user_truncate'))
  ) THEN RAISE EXCEPTION 'TEAM_REMOVAL_SCHEMA_REVIEW_REQUIRED' USING ERRCODE = 'P1002'; END IF;

  -- Enumerate *all* referencing foreign keys, including ones added later. A
  -- target row lock makes concurrent FK insertions wait until this transaction
  -- finishes. Unknown composite relationships fail closed rather than being
  -- accidentally cascaded or detached.
  FOR v_ref IN
    SELECT n.nspname, t.relname, c.conkey, c.confdeltype,
           a.attname AS column_name
    FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    LEFT JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
    WHERE c.contype = 'f' AND c.confrelid = 'public.users'::regclass
  LOOP
    IF array_length(v_ref.conkey, 1) IS DISTINCT FROM 1 OR v_ref.column_name IS NULL THEN
      RAISE EXCEPTION 'TEAM_REMOVAL_SCHEMA_REVIEW_REQUIRED' USING ERRCODE = 'P1002';
    END IF;
    IF v_ref.nspname = 'public' AND v_ref.confdeltype = 'c' AND
      ((v_ref.relname = 'project_supervisors' AND v_ref.column_name = 'supervisor_id') OR
       (v_ref.relname = 'user_notifications' AND v_ref.column_name = 'recipient_id')) THEN
      -- Do not allow a later schema addition to turn these intentional
      -- cascades into indirect deletion or mutation of other records.
      IF EXISTS (SELECT 1 FROM pg_constraint child WHERE child.contype = 'f' AND child.confrelid = format('%I.%I', v_ref.nspname, v_ref.relname)::regclass) THEN
        RAISE EXCEPTION 'TEAM_REMOVAL_SCHEMA_REVIEW_REQUIRED' USING ERRCODE = 'P1002';
      END IF;
      CONTINUE;
    END IF;
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.%I WHERE %I = $1)', v_ref.nspname, v_ref.relname, v_ref.column_name)
      INTO v_referenced USING p_target;
    IF v_referenced THEN RAISE EXCEPTION 'TEAM_ACCOUNT_HAS_LINKED_RECORDS' USING ERRCODE = 'P1001'; END IF;
  END LOOP;

  DELETE FROM public.users WHERE id = p_target;
  INSERT INTO public.audit_log (actor_id, actor_email, action, table_name, record_id, before_row, after_row)
    VALUES (p_actor, v_actor_email, 'delete', 'users', p_target, to_jsonb(v_target), NULL);
  RETURN to_jsonb(v_target);
END;
$$;
REVOKE ALL ON FUNCTION public.delete_team_profile_guarded(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_team_profile_guarded(uuid, uuid) TO service_role;
