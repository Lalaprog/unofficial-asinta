-- Draft: protect NEW Supervisor requests only. Existing requests, advances and
-- payroll are not changed. This is not the weekly Bale schedule or cutover.
-- Narrow the insert surface so callers cannot backdate/forge request fields.
REVOKE INSERT ON public.advance_requests FROM PUBLIC, anon, authenticated;
GRANT INSERT (worker_id, project_id, requested_amount, submitted_by) ON public.advance_requests TO authenticated;
-- Fail rather than pretend inherited or pre-existing column grants were removed.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a
    WHERE a.attrelid='public.advance_requests'::regclass AND a.attnum>0 AND NOT a.attisdropped
      AND (pg_catalog.has_column_privilege('anon',a.attrelid,a.attname,'INSERT')
        OR (a.attname NOT IN ('worker_id','project_id','requested_amount','submitted_by')
          AND pg_catalog.has_column_privilege('authenticated',a.attrelid,a.attname,'INSERT')))
  ) THEN RAISE EXCEPTION 'Unexpected inherited or column INSERT privileges on advance_requests'; END IF;
END;
$$;

CREATE FUNCTION public.guard_advance_request_site()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_active boolean;
BEGIN
  IF auth.uid() IS NULL OR NOT coalesce(public.session_assurance_satisfied(), false) THEN
    RAISE EXCEPTION 'Supervisor access required' USING ERRCODE = '42501';
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Bale request requires read committed isolation' USING ERRCODE = 'P1002';
  END IF;
  PERFORM 1 FROM public.users WHERE id=auth.uid() AND role='supervisor' FOR SHARE;
  IF NOT FOUND OR NEW.submitted_by IS DISTINCT FROM auth.uid() OR NOT coalesce(public.current_user_role()='supervisor',false) THEN
    RAISE EXCEPTION 'Supervisor access required' USING ERRCODE = '42501';
  END IF;
  -- Lock site access before the worker, matching guarded assignment's order.
  PERFORM 1 FROM public.projects WHERE id=NEW.project_id FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Project access required' USING ERRCODE = '42501'; END IF;
  PERFORM 1 FROM public.project_supervisors WHERE project_id=NEW.project_id AND supervisor_id=auth.uid() FOR KEY SHARE;
  IF NOT FOUND OR NOT coalesce(public.is_supervisor_assigned(NEW.project_id),false) THEN
    RAISE EXCEPTION 'Project access required' USING ERRCODE = '42501';
  END IF;
  SELECT active INTO v_active FROM public.workers WHERE id=NEW.worker_id FOR UPDATE;
  IF NOT FOUND OR v_active IS NOT TRUE OR EXISTS (SELECT 1 FROM public.users WHERE id=NEW.worker_id AND role='supervisor') THEN
    RAISE EXCEPTION 'Worker unavailable' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.project_worker_assignments WHERE worker_id=NEW.worker_id AND project_id=NEW.project_id AND active=true)
    OR EXISTS (SELECT 1 FROM public.project_worker_assignments WHERE worker_id=NEW.worker_id AND project_id<>NEW.project_id AND active=true) THEN
    RAISE EXCEPTION 'Worker must have one active assignment at the selected site; review conflicting assignments' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_advance_request_site() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER guard_advance_request_site BEFORE INSERT ON public.advance_requests
FOR EACH ROW EXECUTE FUNCTION public.guard_advance_request_site();
