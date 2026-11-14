-- Preserve financial history from direct client DELETE operations. No rows are
-- modified. The application has no payroll/advance delete workflow; corrections
-- require a separately reviewed adjustment, not deletion of historical records.
-- This is independent of the unfinished weekly-payroll migrations.
DO $$
DECLARE v_name text; v_table regclass; v_service_before boolean;
BEGIN
  FOREACH v_name IN ARRAY ARRAY['payroll','advances'] LOOP
    v_table:=to_regclass(format('public.%I',v_name));
    IF v_table IS NULL OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class WHERE oid=v_table AND relkind IN ('r','p')) THEN
      RAISE EXCEPTION 'Expected financial table public.% is missing',v_name;
    END IF;
    v_service_before:=has_table_privilege('service_role',v_table,'DELETE');
    EXECUTE format('REVOKE DELETE ON TABLE public.%I FROM anon, authenticated',v_name);
    -- Do not silently modify PUBLIC or membership grants to force success.
    IF has_table_privilege('anon',v_table,'DELETE') OR has_table_privilege('authenticated',v_table,'DELETE') THEN
      RAISE EXCEPTION 'Inherited DELETE grant remains on public.%; review role grants',v_name;
    END IF;
    IF has_table_privilege('service_role',v_table,'DELETE') IS DISTINCT FROM v_service_before THEN
      RAISE EXCEPTION 'Service DELETE privilege would change on public.%',v_name;
    END IF;
  END LOOP;
END;
$$;
-- Database owners, service-role operations and other privileged roles are not
-- covered by this client restriction and still require operational controls.
