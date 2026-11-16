#!/usr/bin/env node
// Target-specific candidate for the already-staged development database.
// NOT an automatic deployer: the caller must run the complete output in ONE
// transaction, after reviewing target state, monitoring and client rollout.
// In particular, do not use this for a fresh install or real client data.
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';
const root=join(dirname(fileURLToPath(import.meta.url)),'..');
if(process.argv.length!==2)throw Error('This generator takes no arguments.');
const files=[
 'supabase/migrations/20261113000002_worker_allowances.sql',
 'supabase/migrations/20261113000003_weekly_payroll_context.sql',
 'supabase/drafts/supervisor_rpc_rollout.sql',
 ...[
  'supervisor_day_founder_backfill','guard_legacy_bale_payment','weekly_payment_date','weekly_worker_generator','weekly_worker_approval',
  'weekly_worker_paid_allocation','weekly_worker_draft_details','weekly_paid_attendance_change_review','weekly_worker_draft_refresh','weekly_worker_return_to_draft',
  'weekly_bale_schedule','weekly_bale_expiration','weekly_bale_release_list','weekly_bale_status_batch','weekly_bale_scheduler',
  'attendance_history_time_batch','supervisor_leave_notification','project_paid_payroll_evidence','paid_payroll_adjustments','supervisor_payroll_preview',
  'historical_paid_date_annotation','historical_settled_bale_evidence','historical_finance_evidence_review',
  'historical_external_worker_payroll','supervisor_payroll_ledger','paid_period_assertion_adjustments',
  'confirmed_rental_expense_link','project_cost_reconciliation_preview',
  'project_assignment_history','atomic_worker_move','attendance_assignment_guard','assignment_writer_acl_cutover',
  'weekly_bale_legacy_cutover_guard','weekly_worker_legacy_cutover_guard','weekly_bale_external_monitor',
  'project_cost_review_ledger','historical_worker_project_attribution','project_cost_historical_review','owned_equipment_allocations'
 ].map(n=>`supabase/drafts/${n}.sql`)
];
const chunks=files.map(file=>{
 const source=readFileSync(join(root,file),'utf8');
 // A conservative tripwire, NOT a SQL parser or a substitute for review.
 if(/^\s*(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|PREPARE\s+TRANSACTION)\s*;/im.test(source)||/^\s*\\/m.test(source))throw Error(`Unexpected transaction control in ${file}`);
 return `\n-- ${file} sha256 ${createHash('sha256').update(source).digest('hex')}\n${source}\n`;
});
const preflight=`-- Development cutover candidate: run all statements in ONE managed transaction.
-- No test-only data is created; this is not the rollback-only rehearsal bundle.
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
-- Take all business locks before the empty-development check. This blocks new
-- writes until commit; it is not a guarantee against privileged trigger bypass.
LOCK TABLE public.advances,public.advance_requests,public.payroll,public.attendance,public.workers,public.projects,public.project_worker_assignments,public.project_supervisors,public.supervisor_daily_attendance,public.supervisor_leave_requests,public.tools,public.expenses IN SHARE ROW EXCLUSIVE MODE;
DO $staged_preflight$
DECLARE f regprocedure;
BEGIN
 IF current_database()<>'postgres' AND NOT (current_database() LIKE 'asinta\\_test\\_%' ESCAPE '\\' AND to_regclass('app_private.synthetic_finance_rehearsal_marker') IS NOT NULL) THEN RAISE EXCEPTION 'Unexpected database'; END IF;
 IF EXISTS(SELECT 1 FROM public.workers) OR EXISTS(SELECT 1 FROM public.projects) OR EXISTS(SELECT 1 FROM public.attendance) OR EXISTS(SELECT 1 FROM public.payroll) OR EXISTS(SELECT 1 FROM public.advances) OR EXISTS(SELECT 1 FROM public.advance_requests) OR EXISTS(SELECT 1 FROM public.project_worker_assignments) OR EXISTS(SELECT 1 FROM public.project_supervisors) OR EXISTS(SELECT 1 FROM public.supervisor_daily_attendance) OR EXISTS(SELECT 1 FROM public.supervisor_leave_requests) OR EXISTS(SELECT 1 FROM public.tools) OR EXISTS(SELECT 1 FROM public.expenses) THEN RAISE EXCEPTION 'Development business records exist; reconcile before cutover'; END IF;
 IF to_regclass('public.attendance_time_details') IS NULL OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.attendance_time_details'::regclass) OR EXISTS(SELECT 1 FROM public.attendance_time_details) THEN RAISE EXCEPTION 'Expected empty staged time detail table required'; END IF;
 f:=to_regprocedure('public.record_attendance_time_detail(uuid,uuid,timestamptz,numeric,numeric,text)');
 IF f IS NULL OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=f AND prosecdef AND md5(prosrc)='9e005a393f9295f31e5724906b46b08e') OR EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r(role_name) WHERE has_function_privilege(r.role_name,f,'EXECUTE')) THEN RAISE EXCEPTION 'Staged time writer changed or enabled'; END IF;
 f:=to_regprocedure('public.weekly_worker_preview_inputs(date)');
 IF f IS NULL OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=f AND NOT prosecdef AND md5(prosrc)='c8c1bd7f427fddce5f3ddd3167b1482c') OR has_function_privilege('anon',f,'EXECUTE') OR NOT has_function_privilege('authenticated',f,'EXECUTE') THEN RAISE EXCEPTION 'Staged weekly preview changed'; END IF;
 f:=to_regprocedure('public.weekly_worker_preview_base_inputs(date)');
 IF f IS NULL OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=f AND NOT prosecdef AND md5(prosrc)='e94e19cb53dbeb677bf02b24dd43cb13') OR to_regprocedure('public.weekly_worker_time_preview_inputs(date)') IS NOT NULL THEN RAISE EXCEPTION 'Weekly base changed'; END IF;
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r(role_name) WHERE has_table_privilege(r.role_name,'public.attendance_time_details','INSERT,UPDATE,DELETE,TRUNCATE') OR has_sequence_privilege(r.role_name,pg_get_serial_sequence('public.attendance_time_details','revision_id'),'USAGE,SELECT,UPDATE')) THEN RAISE EXCEPTION 'Staged time detail write access changed'; END IF;
END $staged_preflight$;
`;
const postflight=`
-- Enable the staged time writer only after the rest of the chain and guards exist.
DO $before_time_activation$ BEGIN
 IF to_regprocedure('public.create_weekly_worker_draft(uuid,uuid,date)') IS NULL OR to_regprocedure('public.record_weekly_bale_release(uuid)') IS NULL OR to_regprocedure('public.run_weekly_bale_expiry_job()') IS NULL OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.payroll'::regclass AND tgname='require_weekly_worker_source_on_insert' AND tgenabled='O' AND NOT tgisinternal) OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.advances'::regclass AND tgname='require_weekly_bale_source_on_insert' AND tgenabled='O' AND NOT tgisinternal) THEN RAISE EXCEPTION 'Weekly cutover is incomplete'; END IF;
END $before_time_activation$;
GRANT EXECUTE ON FUNCTION public.record_attendance_time_detail(uuid,uuid,timestamptz,numeric,numeric,text) TO authenticated;
DO $final_checks$ BEGIN
 IF has_function_privilege('anon','public.record_attendance_time_detail(uuid,uuid,timestamptz,numeric,numeric,text)','EXECUTE') OR has_function_privilege('service_role','public.record_attendance_time_detail(uuid,uuid,timestamptz,numeric,numeric,text)','EXECUTE') OR NOT has_function_privilege('authenticated','public.record_attendance_time_detail(uuid,uuid,timestamptz,numeric,numeric,text)','EXECUTE') THEN RAISE EXCEPTION 'Unexpected time writer execute privilege'; END IF;
END $final_checks$;
`;
process.stdout.write(preflight+chunks.join('')+postflight);
