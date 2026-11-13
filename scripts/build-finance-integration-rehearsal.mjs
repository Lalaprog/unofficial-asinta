#!/usr/bin/env node
// TEST ONLY: emit one rollback-only, synthetic-database integration rehearsal.
// It is NOT a migration bundle and must never run on a shared/hosted database.
// DDL takes locks even on rollback. The SQL intentionally requires a test-only
// marker and an asinta_test_* database name; neither is a security boundary.
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=join(dirname(fileURLToPath(import.meta.url)),'..');
if(process.argv.length!==2)throw Error('No options or deployment mode are supported');
const base=execFileSync(process.execPath,[join(root,'scripts/build-pr103-rehearsal.mjs')],{encoding:'utf8'});
const ending='ROLLBACK;\n\n';
if(!base.startsWith('-- REHEARSAL ONLY')||!base.endsWith(ending))throw Error('Unexpected PR103 rehearsal boundaries');
const names=[
 'guard_legacy_bale_payment','weekly_payment_date','weekly_worker_generator','weekly_worker_approval',
 'weekly_worker_paid_allocation','weekly_worker_draft_details','weekly_paid_attendance_change_review','weekly_worker_draft_refresh','weekly_worker_return_to_draft',
 'weekly_bale_schedule','weekly_bale_expiration','weekly_bale_release_list','weekly_bale_status_batch','weekly_bale_scheduler',
 'attendance_history_time_batch','supervisor_leave_notification','project_paid_payroll_evidence','paid_payroll_adjustments','supervisor_payroll_preview',
 'historical_paid_date_annotation','historical_settled_bale_evidence','historical_finance_evidence_review',
 'historical_external_worker_payroll','supervisor_payroll_ledger','paid_period_assertion_adjustments',
 'confirmed_rental_expense_link','project_cost_reconciliation_preview'
];
const chunks=names.map(name=>{
 const source=readFileSync(join(root,'supabase/drafts',`${name}.sql`),'utf8');
 // A tripwire, not a SQL parser: review each file before using this script.
 if(/^\s*(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|PREPARE\s+TRANSACTION)\s*;/im.test(source)||/^\s*\\/m.test(source))throw Error(`Unexpected transaction control or psql command in ${name}`);
 return `\n-- Draft: ${name}.sql SHA-256 ${createHash('sha256').update(source).digest('hex')}\n${source}\n`;
});
const marker=`BEGIN;\nDO $synthetic_guard$\nBEGIN\n IF current_database() NOT LIKE 'asinta\\_test\\_%' ESCAPE '\\' OR pg_catalog.to_regclass('app_private.synthetic_finance_rehearsal_marker') IS NULL THEN\n  RAISE EXCEPTION 'Synthetic disposable database and marker required'; END IF;\nEND;\n$synthetic_guard$;`;
if(base.split('BEGIN;\n').length!==2)throw Error('Ambiguous outer transaction boundary');
const head=base.slice(0,-ending.length).replace('BEGIN;\n',`${marker}\n`);
const post=`
DO $finance_postflight$
DECLARE v text; v_function regprocedure; v_table regclass;
BEGIN
 FOREACH v IN ARRAY ARRAY['public.weekly_worker_draft_sources','public.weekly_worker_paid_allocations','public.weekly_worker_draft_refreshes','public.weekly_worker_approval_returns','public.payroll_payment_dates','public.weekly_bale_requests','public.weekly_bale_expiry_health','public.supervisor_period_payroll','public.historical_external_worker_payroll'] LOOP
  v_table:=pg_catalog.to_regclass(v);
  IF v_table IS NULL OR NOT (SELECT relrowsecurity FROM pg_catalog.pg_class WHERE oid=v_table) OR pg_catalog.has_table_privilege('anon',v_table,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') OR pg_catalog.has_table_privilege('authenticated',v_table,'INSERT,UPDATE,DELETE,TRUNCATE') THEN RAISE EXCEPTION 'Missing or unexpectedly accessible finance table: %',v; END IF;
 END LOOP;
 FOREACH v IN ARRAY ARRAY['public.create_weekly_worker_draft(uuid,uuid,date)','public.approve_weekly_worker_draft(uuid,bigint)','public.record_weekly_worker_payment(uuid,date,bigint)','public.return_weekly_worker_to_draft(uuid,uuid,bigint,text)','public.weekly_paid_attendance_change_review(uuid)','public.record_weekly_bale_release(uuid)','public.project_cost_reconciliation_preview(uuid)'] LOOP
  v_function:=pg_catalog.to_regprocedure(v);
  IF v_function IS NULL OR pg_catalog.has_function_privilege('anon',v_function,'EXECUTE') OR NOT pg_catalog.has_function_privilege('authenticated',v_function,'EXECUTE') THEN RAISE EXCEPTION 'Missing or unexpectedly accessible finance function: %',v; END IF;
 END LOOP;
 FOREACH v IN ARRAY ARRAY['public.weekly_worker_approval_internal(uuid)','public.weekly_worker_payment_internal(uuid,date)','public.run_weekly_bale_expiry_job()','public.materialize_weekly_bale_expiry(integer)'] LOOP
  v_function:=pg_catalog.to_regprocedure(v);
  IF v_function IS NULL OR pg_catalog.has_function_privilege('anon',v_function,'EXECUTE') OR pg_catalog.has_function_privilege('authenticated',v_function,'EXECUTE') OR pg_catalog.has_function_privilege('service_role',v_function,'EXECUTE') THEN RAISE EXCEPTION 'Missing or unexpectedly callable internal function: %',v; END IF;
 END LOOP;
 IF pg_catalog.to_regprocedure('public.approve_weekly_worker_draft(uuid)') IS NOT NULL OR pg_catalog.to_regprocedure('public.record_weekly_worker_payment(uuid,date)') IS NOT NULL THEN RAISE EXCEPTION 'Old weekly action signature remains'; END IF;
END;
$finance_postflight$;
`;
process.stdout.write(`${head}\n${chunks.join('\n')}\n${post}\nROLLBACK;\n`);
