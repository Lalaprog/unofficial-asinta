-- UNINSTALLED DRAFT. Requires the separately reviewed Supervisor RPC rollout.
-- A live pending-queue indicator, not an event delivery or read receipt.
-- Run only in one reviewed transaction on a compatible target, never blindly.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
DO $preflight$
BEGIN
 IF to_regclass('public.supervisor_leave_requests') IS NULL
    OR to_regprocedure('public.supervisor_leave_list(integer)') IS NULL
    OR to_regprocedure('public.review_supervisor_leave(uuid,text)') IS NULL
    OR to_regprocedure('public.is_founder()') IS NULL
    OR to_regprocedure('public.session_assurance_satisfied()') IS NULL
    OR to_regprocedure('auth.uid()') IS NULL THEN
  RAISE EXCEPTION 'Reviewed Supervisor leave prerequisites missing';
 END IF;
 IF to_regprocedure('public.supervisor_leave_pending_summary()') IS NOT NULL THEN
  RAISE EXCEPTION 'Supervisor leave summary already exists';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class WHERE oid='public.supervisor_leave_requests'::regclass AND relkind='r' AND relrowsecurity)
    OR has_table_privilege('anon','public.supervisor_leave_requests','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    OR has_table_privilege('authenticated','public.supervisor_leave_requests','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN
  RAISE EXCEPTION 'Supervisor leave table not safely locked';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid='public.supervisor_leave_requests'::regclass AND attname='status' AND atttypid='text'::regtype AND NOT attisdropped) THEN
  RAISE EXCEPTION 'Supervisor leave status column differs';
 END IF;
END;
$preflight$;

CREATE FUNCTION public.supervisor_leave_pending_summary()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_count bigint;
BEGIN
 IF auth.uid() IS NULL OR NOT coalesce(public.is_founder(),false) OR NOT coalesce(public.session_assurance_satisfied(),false) THEN
  RAISE EXCEPTION 'Founder access required' USING ERRCODE='42501';
 END IF;
 SELECT count(*) INTO v_count FROM public.supervisor_leave_requests WHERE status='pending';
 RETURN jsonb_build_object('pending_count',v_count);
END;
$$;
REVOKE ALL ON FUNCTION public.supervisor_leave_pending_summary() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.supervisor_leave_pending_summary() TO authenticated;
DO $postflight$
BEGIN
 IF has_function_privilege('anon','public.supervisor_leave_pending_summary()','EXECUTE')
    OR NOT has_function_privilege('authenticated','public.supervisor_leave_pending_summary()','EXECUTE') THEN
  RAISE EXCEPTION 'Unexpected Supervisor leave summary execution privileges';
 END IF;
END;
$postflight$;
