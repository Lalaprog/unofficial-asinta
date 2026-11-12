-- Hosted Supabase default privileges may grant client roles direct access to
-- newly created sequences. The time-detail writer is SECURITY DEFINER; callers
-- do not need to read or advance the revision identity sequence themselves.
-- Preserve service-role permissions exactly as found, and fail closed when an
-- inherited grant prevents effective revocation. No business rows are modified.
DO $$
DECLARE
  v_sequence regclass;
  v_service_usage boolean;
  v_service_select boolean;
  v_service_update boolean;
BEGIN
  v_sequence := pg_catalog.pg_get_serial_sequence('public.attendance_time_details','revision_id')::regclass;
  IF v_sequence IS NULL OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class WHERE oid=v_sequence AND relkind='S') THEN
    RAISE EXCEPTION 'Expected attendance time detail identity sequence is missing';
  END IF;
  v_service_usage := pg_catalog.has_sequence_privilege('service_role',v_sequence,'USAGE');
  v_service_select := pg_catalog.has_sequence_privilege('service_role',v_sequence,'SELECT');
  v_service_update := pg_catalog.has_sequence_privilege('service_role',v_sequence,'UPDATE');
  EXECUTE pg_catalog.format('REVOKE ALL PRIVILEGES ON SEQUENCE %s FROM PUBLIC, anon, authenticated',v_sequence);
  IF pg_catalog.has_sequence_privilege('anon',v_sequence,'USAGE, SELECT, UPDATE')
     OR pg_catalog.has_sequence_privilege('authenticated',v_sequence,'USAGE, SELECT, UPDATE') THEN
    RAISE EXCEPTION 'Inherited client access remains on attendance time detail sequence';
  END IF;
  IF pg_catalog.has_sequence_privilege('service_role',v_sequence,'USAGE') IS DISTINCT FROM v_service_usage
     OR pg_catalog.has_sequence_privilege('service_role',v_sequence,'SELECT') IS DISTINCT FROM v_service_select
     OR pg_catalog.has_sequence_privilege('service_role',v_sequence,'UPDATE') IS DISTINCT FROM v_service_update THEN
    RAISE EXCEPTION 'Service sequence privileges would change';
  END IF;
END;
$$;
