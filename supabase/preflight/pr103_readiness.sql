-- READ-ONLY catalog check for the PR #103 schema mismatch; not a deployment
-- script and not proof that a migration, Auth, RLS, PostgREST or locks are safe.
-- It returns missing prerequisites, conflicting names and existing column-level
-- INSERT ACLs. An empty list does not authorize a migration or a blind db push.
WITH expected_relations(name) AS (VALUES
  ('public.attendance'),('public.workers'),('public.users'),('public.projects'),
  ('public.project_supervisors'),('public.project_worker_assignments'),
  ('public.payroll'),('public.advances'),('public.advance_requests')
), expected_helpers(signature) AS (VALUES
  ('public.is_founder()'),('public.is_supervisor_assigned(uuid)'),
  ('public.session_assurance_satisfied()'),('public.current_user_role()'),
  ('auth.uid()')
), new_relations(name) AS (VALUES
  ('public.attendance_time_details'),('public.worker_allowances'),
  ('public.supervisor_leave_requests'),('public.supervisor_daily_attendance')
), new_functions(signature) AS (VALUES
  ('public.weekly_worker_preview_inputs(date)'),
  ('public.weekly_worker_preview_base_inputs(date)'),
  ('public.weekly_worker_time_preview_inputs(date)'),
  ('public.attendance_time_detail_latest(uuid)'),
  ('public.record_attendance_time_detail(uuid,uuid,timestamp with time zone,numeric,numeric,text)'),
  ('public.worker_allowances_for_attendance(uuid)'),
  ('public.submit_worker_allowance(uuid,uuid,timestamp with time zone,numeric,text)'),
  ('public.review_worker_allowance(uuid,text)'),
  ('public.worker_allowance_pending_queue()'),
  ('app_private.normal_leave_notice_allowed(date,timestamp with time zone)'),
  ('public.submit_supervisor_leave(uuid,date,date,text,text)'),
  ('public.review_supervisor_leave(uuid,text)'),('public.supervisor_leave_list(integer)'),
  ('public.submit_supervisor_day(uuid,date,text)'),('public.review_supervisor_day(uuid,text)'),
  ('public.guard_leave_against_approved_supervisor_day()'),('public.supervisor_day_list(integer)')
)
SELECT jsonb_build_object(
  'app_private_schema_exists',pg_catalog.to_regnamespace('app_private') IS NOT NULL,
  'missing_relations',(SELECT coalesce(jsonb_agg(name ORDER BY name),'[]'::jsonb) FROM expected_relations WHERE pg_catalog.to_regclass(name) IS NULL),
  'missing_helpers',(SELECT coalesce(jsonb_agg(signature ORDER BY signature),'[]'::jsonb) FROM expected_helpers WHERE pg_catalog.to_regprocedure(signature) IS NULL),
  'existing_new_relations',(SELECT coalesce(jsonb_agg(name ORDER BY name),'[]'::jsonb) FROM new_relations WHERE pg_catalog.to_regclass(name) IS NOT NULL),
  'existing_new_functions',(SELECT coalesce(jsonb_agg(signature ORDER BY signature),'[]'::jsonb) FROM new_functions WHERE pg_catalog.to_regprocedure(signature) IS NOT NULL),
  'site_guard_function_exists',pg_catalog.to_regprocedure('public.guard_advance_request_site()') IS NOT NULL,
  'site_guard_function_body_md5',(SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid=pg_catalog.to_regprocedure('public.guard_advance_request_site()')),
  'site_guard_trigger_enabled',(SELECT t.tgenabled FROM pg_catalog.pg_trigger t WHERE t.tgrelid=pg_catalog.to_regclass('public.advance_requests') AND t.tgname='guard_advance_request_site' AND NOT t.tgisinternal),
  'advance_request_explicit_column_acls',(SELECT coalesce(jsonb_agg(jsonb_build_object('column',a.attname,'acl',a.attacl::text) ORDER BY a.attnum),'[]'::jsonb)
    FROM pg_catalog.pg_attribute a WHERE a.attrelid=pg_catalog.to_regclass('public.advance_requests') AND a.attnum>0 AND NOT a.attisdropped AND a.attacl IS NOT NULL)
) AS readiness;
