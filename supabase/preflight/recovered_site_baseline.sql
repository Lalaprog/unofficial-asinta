-- READ-ONLY, PARTIAL baseline for the current development database and the
-- default-off PR #104 website. No result authorizes a deployment or migration.
-- These point-in-time fingerprints describe selected objects observed on the
-- recovered target; they are not a full schema/RLS/Auth/PostgREST comparison.
WITH expected(signature,body_md5,definer,volatility,anon_exec,auth_exec,service_exec) AS (VALUES
 ('public.visible_projects()','60eb06b0370a7dcad55523ad20174cb8',true,'s',false,true,true),
 ('public.attendance_history_page(text,uuid,text,date,text,date,uuid,uuid,integer)','016855d568b5147fa0c0f2e8e0c134c5',false,'s',false,true,true),
 ('public.payroll_input_snapshot(date,date,uuid)','9a8e084c081e6ac3e3a03cef06278f9c',false,'s',false,true,true),
 ('public.available_project_workers_guarded(uuid,uuid)','82cf2522167d5b85016ed445bc3d4741',true,'v',false,false,true),
 ('public.set_project_worker_guarded(uuid,uuid,uuid,boolean)','c266c871185767a6ef6b362bbd1f983c',true,'v',false,false,true),
 ('public.create_project_worker_guarded(uuid,uuid,uuid,text,text,text,numeric,text)','bccc89be65e7f42d8ba6dab365c3603f',true,'v',false,false,true),
 ('public.guard_advance_request_site()','5df27c07b98136257e129c7bcaf8feb5',true,'v',false,false,true),
 ('public.weekly_worker_preview_inputs(date)','e94e19cb53dbeb677bf02b24dd43cb13',false,'s',false,true,true)
), resolved AS (
 SELECT e.*,to_regprocedure(e.signature) AS oid FROM expected e
), funcs AS (
 SELECT r.signature,r.oid IS NOT NULL AS present,
  CASE WHEN r.oid IS NULL THEN false ELSE md5(p.prosrc)=r.body_md5 END AS body_matches,
  CASE WHEN r.oid IS NULL THEN false ELSE p.prosecdef=r.definer AND p.provolatile::text=r.volatility END AS execution_mode_matches,
  CASE WHEN r.oid IS NULL THEN false ELSE
   coalesce(p.proconfig = ARRAY[CASE WHEN r.signature IN ('public.available_project_workers_guarded(uuid,uuid)','public.set_project_worker_guarded(uuid,uuid,uuid,boolean)','public.create_project_worker_guarded(uuid,uuid,uuid,text,text,text,numeric,text)') THEN 'search_path=pg_catalog, pg_temp' ELSE 'search_path=""' END],false)
   AND p.pronargdefaults=CASE WHEN r.signature LIKE 'public.attendance_history_page(%' THEN 8 WHEN r.signature LIKE 'public.payroll_input_snapshot(%' THEN 1 ELSE 0 END
   AND pg_get_function_result(r.oid)=CASE WHEN r.signature='public.visible_projects()' THEN 'TABLE(id uuid, name text, client_id uuid, location text, budget_estimate numeric, status text, start_date date, target_completion_date date, created_at timestamp with time zone)' WHEN r.signature='public.guard_advance_request_site()' THEN 'trigger' ELSE 'jsonb' END
  END AS contract_matches,
  CASE WHEN r.oid IS NULL THEN false ELSE has_function_privilege('anon',r.oid,'EXECUTE')=r.anon_exec AND has_function_privilege('authenticated',r.oid,'EXECUTE')=r.auth_exec AND has_function_privilege('service_role',r.oid,'EXECUTE')=r.service_exec END AS grants_match
 FROM resolved r LEFT JOIN pg_proc p ON p.oid=r.oid
), selected_tables(name) AS (VALUES
 ('public.users'),('public.projects'),('public.workers'),('public.project_worker_assignments'),('public.project_supervisors'),('public.attendance'),('public.advance_requests'),('public.payroll'),('public.advances')
), tables AS (
 SELECT s.name,c.oid IS NOT NULL AS present,coalesce(c.relrowsecurity,false) AS rls_enabled,
  (SELECT count(*)::integer FROM pg_policy p WHERE p.polrelid=c.oid) AS policy_count
 FROM selected_tables s LEFT JOIN pg_class c ON c.oid=to_regclass(s.name)
), gated(signature) AS (VALUES
 ('public.attendance_time_detail_latest(uuid)'),('public.worker_allowance_pending_queue()'),
 ('public.submit_supervisor_leave(uuid,date,date,text,text)'),('public.submit_supervisor_day(uuid,date,text)'),
 ('public.project_equipment_snapshot(uuid)'),('public.supervisor_leave_pending_summary()')
)
SELECT jsonb_build_object(
 'functions',(SELECT jsonb_agg(to_jsonb(f) ORDER BY f.signature) FROM funcs f),
 'tables',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.name) FROM tables t),
 'site_guard_trigger_enabled',coalesce((SELECT t.tgenabled='O' AND t.tgfoid=to_regprocedure('public.guard_advance_request_site()') FROM pg_trigger t WHERE t.tgrelid=to_regclass('public.advance_requests') AND t.tgname='guard_advance_request_site' AND NOT t.tgisinternal),false),
 'gated_functions',(SELECT jsonb_agg(jsonb_build_object('signature',signature,'present',to_regprocedure(signature) IS NOT NULL) ORDER BY signature) FROM gated)
) AS baseline;
