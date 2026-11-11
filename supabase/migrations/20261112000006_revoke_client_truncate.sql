-- Table RLS does not apply to TRUNCATE. Existing Supabase default grants can
-- give API roles that privilege even on RLS-protected tables. The app has no
-- browser-facing TRUNCATE workflow; preserve all other privileges and rows.
-- Fail closed if an inherited/PUBLIC grant still permits TRUNCATE, instead of
-- altering unrelated roles. Privileged service access is not changed.
DO $$
DECLARE
  v_name text;
  v_table regclass;
BEGIN
  FOREACH v_name IN ARRAY ARRAY[
    'advance_requests','advances','attendance','audit_log','clients',
    'email_logs','email_templates','expense_drafts','expenses','invoices',
    'payroll','project_supervisors','projects','reminder_dispatches','sms_logs',
    'tools','users','vendor_memory','workers'
  ] LOOP
    v_table := to_regclass(format('public.%I',v_name));
    IF v_table IS NULL OR NOT EXISTS (SELECT 1 FROM pg_class WHERE oid=v_table AND relkind IN ('r','p')) THEN
      RAISE EXCEPTION 'Expected business table public.% is missing',v_name;
    END IF;
    EXECUTE format('REVOKE TRUNCATE ON TABLE %s FROM anon, authenticated',v_table);
    IF has_table_privilege('anon',v_table,'TRUNCATE') OR has_table_privilege('authenticated',v_table,'TRUNCATE') THEN
      RAISE EXCEPTION 'Inherited TRUNCATE grant remains on %; review role grants',v_table;
    END IF;
  END LOOP;
END;
$$;
-- This does not alter database-wide default privileges. New tables and changes
-- to PUBLIC/role membership must be audited separately before deployment.
