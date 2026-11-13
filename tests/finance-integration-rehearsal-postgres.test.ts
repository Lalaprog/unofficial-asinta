// Opt-in ONLY: a fresh synthetic, local asinta_test_* PostgreSQL database.
// Never run against a shared or hosted database: this rehearsal takes DDL locks.
import {Client} from 'pg';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {baseFixture} from './helpers/pr103-fixture';
import {parseWeeklyDraftDetails} from '@/lib/payroll/weeklyDraftDetails';
import {estimateProjectCost,parseCostSnapshot} from '@/lib/projects/projectCostReconciliation';

const url=process.env.FINANCE_INTEGRATION_REHEARSAL_TEST_DATABASE_URL;
const suite=url?describe:describe.skip;
const sql=(name:string)=>readFileSync(`supabase/migrations/${name}`,'utf8');
const previous=['20261103000001_attendance_history.sql','20261107000002_project_worker_lists.sql','20261112000000_guarded_single_project_worker.sql','20261112000001_payslip_batch_snapshot.sql','20261112000002_project_attendance_calendar.sql','20261112000003_project_expense_ledger.sql','20261112000004_receipt_photo_inbox.sql','20261112000005_attendance_history_calendar.sql','20261112000006_revoke_client_truncate.sql'];
const founder='00000000-0000-0000-0000-000000000001',supervisor='00000000-0000-0000-0000-000000000002',worker='00000000-0000-0000-0000-000000000003',site='00000000-0000-0000-0000-000000000004';
const attendance='70000000-0000-4000-8000-000000000001',voucher='70000000-0000-4000-8000-000000000002';

suite('coordinated finance integration rehearsal, synthetic PostgreSQL only',()=>{
 it('checks the marker and rollback, rejects late collisions, and exercises the whole ordered chain inside a rolled-back transaction',async()=>{
  const parsed=new URL(url!);
  if(!['localhost','127.0.0.1','[::1]'].includes(parsed.hostname)||!parsed.pathname.slice(1).startsWith('asinta_test_')||parsed.search||parsed.hash)throw Error('Use a fresh local disposable asinta_test_* database without URL options.');
  const db=new Client({connectionString:url});await db.connect();
  try{
   const existing=(await db.query(`SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S'))::int objects,(SELECT count(*) FROM pg_namespace WHERE nspname IN ('auth','app_private','storage'))::int schemas`)).rows[0];
   if(existing.objects||existing.schemas)throw Error('Database must be empty.');
   await db.query(`DO $$BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF; END$$;`);
   const roles='CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; ';if(!baseFixture.startsWith(roles))throw Error('Fixture role bootstrap changed');await db.query(baseFixture.slice(roles.length));
   await db.query(`ALTER TABLE public.users ADD COLUMN email text; UPDATE public.users SET email='fixture@example.invalid';
    ALTER TABLE public.payroll ADD COLUMN notes text;
    ALTER TABLE public.expenses ADD COLUMN ai_bale_detection boolean DEFAULT false, ADD COLUMN revision bigint NOT NULL DEFAULT 0;
    ALTER TABLE public.advances ADD COLUMN reason text, ADD COLUMN created_at timestamptz DEFAULT now(); ALTER TABLE public.advances ALTER COLUMN id SET DEFAULT gen_random_uuid();
    ALTER TABLE public.advance_requests ADD COLUMN approved_by uuid, ADD COLUMN approved_at timestamptz, ADD COLUMN rejected_by uuid, ADD COLUMN rejected_at timestamptz, ADD COLUMN issued_by uuid, ADD COLUMN updated_at timestamptz DEFAULT now();
    ALTER TABLE public.advance_requests ADD CONSTRAINT advance_request_rejection_fields CHECK(status<>'rejected' OR (rejected_by IS NOT NULL AND rejected_at IS NOT NULL));
    DROP TABLE public.audit_log; CREATE TABLE public.audit_log(actor_id uuid,actor_email text,action text,table_name text,record_id uuid,before_row jsonb,after_row jsonb);
    CREATE POLICY test_founder_payroll_write ON public.payroll FOR ALL TO authenticated USING(public.is_founder()) WITH CHECK(public.is_founder());
    CREATE POLICY test_supervisor_attendance_insert ON public.attendance FOR INSERT TO authenticated WITH CHECK(public.is_supervisor_assigned(project_id));`);
   // Selected hosted-shaped constraints and types, NOT a complete schema clone.
   // These expose mistakes hidden by the deliberately minimal shared fixture.
   await db.query(readFileSync('tests/helpers/finance-hosted-shape-fixture.sql','utf8'));
   for(const name of previous)await db.query(sql(name));
   // Synthetic stand-in for the existing Founder account lock helper; this is
   // not a simulation of all hosted team/account protections.
   await db.query('CREATE FUNCTION app_private.lock_founder_guard() RETURNS void LANGUAGE sql AS $$SELECT$$');
   await db.query(sql('20261107000006_guarded_worker_removal.sql'));
   for(const name of ['20261105000002_expense_breakdown.sql','20261102000000_atomic_payroll_payments.sql','20261013000000_advance_requests.sql','20261013000001_advance_request_notifications.sql','20261113000004_bale_request_site_guard.sql','20261113000000_weekly_worker_preview.sql'])await db.query(sql(name));
   await db.query(readFileSync('supabase/drafts/supervisor_table_foundation.sql','utf8'));
   const rehearsal=execFileSync('node',['scripts/build-finance-integration-rehearsal.mjs'],{encoding:'utf8'});
   await expect(db.query(rehearsal)).rejects.toThrow(/Synthetic disposable database and marker required/);await db.query('ROLLBACK');
   await db.query('CREATE TABLE app_private.synthetic_finance_rehearsal_marker (id integer)');
   const snapshot=async()=>(await db.query(`SELECT
    (SELECT md5(coalesce(string_agg(row_to_json(p)::text,',' ORDER BY id),'')) FROM public.payroll p) payroll,
    (SELECT md5(coalesce(string_agg(row_to_json(a)::text,',' ORDER BY id),'')) FROM public.advances a) advances,
    (SELECT md5(coalesce(string_agg(row_to_json(a)::text,',' ORDER BY id),'')) FROM public.attendance a) attendance,
    (SELECT md5(coalesce(string_agg(row_to_json(u)::text,',' ORDER BY id),'')) FROM public.users u) users,
    (SELECT md5(coalesce(string_agg(row_to_json(w)::text,',' ORDER BY id),'')) FROM public.workers w) workers,
    (SELECT md5(coalesce(string_agg(row_to_json(e)::text,',' ORDER BY id),'')) FROM public.expenses e) expenses,
    (SELECT md5(coalesce(string_agg(row_to_json(a)::text,',' ORDER BY project_id,worker_id),'')) FROM public.project_worker_assignments a) assignments,
    (SELECT md5(coalesce(string_agg(row_to_json(s)::text,',' ORDER BY project_id,supervisor_id),'')) FROM public.project_supervisors s) supervisors,
    (SELECT md5(coalesce(string_agg(row_to_json(r)::text,',' ORDER BY id),'')) FROM public.advance_requests r) requests,
    (SELECT md5(coalesce(string_agg(row_to_json(n)::text,',' ORDER BY id),'')) FROM public.user_notifications n) notifications`)).rows[0];
   const before=await snapshot();
   await db.query('CREATE TABLE public.confirmed_rental_expenses(id uuid)');
   await expect(db.query(rehearsal)).rejects.toThrow(/already exist|collision/i);await db.query('ROLLBACK');
   expect(await snapshot()).toEqual(before);
   expect((await db.query("SELECT to_regclass('public.weekly_worker_draft_sources') IS NULL absent,to_regprocedure('public.weekly_worker_preview_inputs(date)') IS NOT NULL base_present")).rows[0]).toEqual({absent:true,base_present:true});
   await db.query('DROP TABLE public.confirmed_rental_expenses');
   await db.query(rehearsal);expect(await snapshot()).toEqual(before);
   expect((await db.query("SELECT to_regclass('public.weekly_worker_draft_sources') IS NULL absent")).rows[0].absent).toBe(true);
   // Keep the identical SQL open only in this disposable test, exercise a
   // voucher, then roll back the DDL and all fixture writes together.
   if(!rehearsal.endsWith('ROLLBACK;\n'))throw Error('Unexpected transaction boundary');
   await db.query(rehearsal.slice(0,-'ROLLBACK;\n'.length));
   // Additional experimental assignment history, atomic move and attendance
   // guard are not in the generated 26-draft chain. Install only inside this
   // disposable rollback transaction.
   await db.query(readFileSync('supabase/drafts/project_assignment_history.sql','utf8'));
   await db.query(readFileSync('supabase/drafts/atomic_worker_move.sql','utf8'));
   await db.query(readFileSync('supabase/drafts/attendance_assignment_guard.sql','utf8'));
   // Separate uninstalled assignment ACL candidate; this is not in the generated chain.
   await db.query(readFileSync('supabase/drafts/assignment_writer_acl_cutover.sql','utf8'));
   // Old-client payroll writes must not bypass the source-bound workflow.
   // This extra draft is outside the generated chain and remains uninstalled.
   await db.query(readFileSync('supabase/drafts/weekly_bale_legacy_cutover_guard.sql','utf8'));
   await db.query(readFileSync('supabase/drafts/weekly_worker_legacy_cutover_guard.sql','utf8'));
   // External health signal is a separate draft, installed only in this test transaction.
   await db.query(readFileSync('supabase/drafts/weekly_bale_external_monitor.sql','utf8'));
   expect((await db.query("SELECT has_function_privilege('authenticated','public.weekly_bale_external_monitor_healthy()','EXECUTE') allowed")).rows[0].allowed).toBe(false);
   // The review ledger is also separate from the generated chain, and never
   // posts money or makes the bounded snapshot complete.
   await db.query(readFileSync('supabase/drafts/project_cost_review_ledger.sql','utf8'));
   await db.query(`SET LOCAL test.uid='${founder}'; SET LOCAL test.assurance='yes'`);
   await db.query("INSERT INTO public.attendance(id,worker_id,project_id,date,status,hours_worked,submitted_at) VALUES($1,$2,$3,'2024-08-04','present',8,'2024-08-04T08:00:00Z')",[attendance,worker,site]);
   await db.query('INSERT INTO public.project_worker_assignments(project_id,worker_id,active) VALUES($1,$2,true)',[site,worker]);
   await db.query('SET LOCAL ROLE service_role; SAVEPOINT denied_assignment_writer');
   await expect(db.query('UPDATE public.project_worker_assignments SET active=false WHERE worker_id=$1',[worker])).rejects.toThrow(/permission denied/);
   await db.query('ROLLBACK TO SAVEPOINT denied_assignment_writer; RELEASE SAVEPOINT denied_assignment_writer');
   await db.query('SELECT public.set_project_worker_guarded($1,$2,$3,true)',[founder,site,worker]);
   await db.query('RESET ROLE');
   await db.query("INSERT INTO public.project_supervisors(project_id,supervisor_id) VALUES('00000000-0000-0000-0000-000000000005',$1)",[supervisor]);
   await db.query("INSERT INTO public.workers(id,name,position,contact_number,pay_rate,pay_rate_type,active) VALUES($1,'Supervisor','Supervisor','none',600,'daily',true)",[supervisor]);
   await db.query(`INSERT INTO public.expenses(id,project_id,description,category,amount,expense_date,ai_bale_detection) VALUES
    ('70000000-0000-4000-8000-000000000009',$1,'Excavator','equipment',1000,'2024-08-04',false),
    ('70000000-0000-4000-8000-000000000010',$1,'Bale expense','other',100.25,'2024-08-07',true)`,[site]);
   // Controlled clock exists only in this disposable transaction.
   await db.query("CREATE OR REPLACE FUNCTION public.weekly_bale_clock() RETURNS timestamptz LANGUAGE sql VOLATILE SET search_path='' AS $$SELECT current_setting('test.clock')::timestamptz$$");
   await db.query(`SET LOCAL ROLE authenticated; SET LOCAL test.uid='${supervisor}'; SET LOCAL test.assurance='yes'; SET LOCAL test.clock='2024-08-04T04:00:00Z'`);
   const request=(await db.query('INSERT INTO public.advance_requests(worker_id,project_id,requested_amount,submitted_by) VALUES($1,$2,100.25,$3) RETURNING id',[worker,site,supervisor])).rows[0].id;
   await db.query(`SET LOCAL test.uid='${founder}'; SET LOCAL test.clock='2024-08-06T04:00:00Z'`);
   await db.query("SELECT public.review_advance_request($1,'approve')",[request]);
   await db.query(`SET LOCAL test.uid='${supervisor}'; SET LOCAL test.clock='2024-08-07T04:00:00Z'`);
   expect((await db.query('SELECT public.record_weekly_bale_release($1) v',[request])).rows[0].v.outcome).toBe('updated');
   await db.query('SET CONSTRAINTS require_weekly_bale_source_on_insert IMMEDIATE; SET CONSTRAINTS require_weekly_bale_source_on_insert DEFERRED');
   await db.query(`SET LOCAL test.uid='${founder}'`);
   await db.query('SAVEPOINT denied_manual_deduction');
   await expect(db.query("SELECT public.record_advance_deduction_atomic((SELECT issued_advance_id FROM public.advance_requests WHERE id=$1),10)",[request])).rejects.toThrow(/Weekly Bale is immutable/);
   await db.query('ROLLBACK TO SAVEPOINT denied_manual_deduction; RELEASE SAVEPOINT denied_manual_deduction');
   await db.query("SELECT public.record_attendance_time_detail('70000000-0000-4000-8000-000000000003',$1,'2024-08-04T08:00:00Z',8,2,'Synthetic overtime')",[attendance]);
   await db.query("SELECT public.submit_worker_allowance('70000000-0000-4000-8000-000000000004',$1,'2024-08-04T08:00:00Z',50.25,'Synthetic allowance')",[attendance]);
   await db.query('SAVEPOINT denied_unsourced_insert');
   await db.query("INSERT INTO public.payroll(id,worker_id,period_start,period_end,status,days_worked,hours_worked,gross_pay,bale_deduction,other_deductions,net_pay) VALUES('70000000-0000-4000-8000-000000000020',$1,'2024-08-04','2024-08-10','draft',1,8,600,0,0,600)",[worker]);
   await expect(db.query('SET CONSTRAINTS require_weekly_worker_source_on_insert IMMEDIATE')).rejects.toThrow(/Legacy payroll insertion blocked/);
   await db.query('ROLLBACK TO SAVEPOINT denied_unsourced_insert; RELEASE SAVEPOINT denied_unsourced_insert');
   expect((await db.query("SELECT public.create_weekly_worker_draft($1,$2,'2024-08-04') v",[voucher,worker])).rows[0].v.calculation).toMatchObject({gross:'800.25',bale:'100.25',net:'700.00'});
   // This rehearsal rolls back the outer transaction, so explicitly fire the
   // deferred constraint to test the same source check that commit would run.
   await db.query('SET CONSTRAINTS require_weekly_worker_source_on_insert IMMEDIATE; SET CONSTRAINTS require_weekly_worker_source_on_insert DEFERRED');
   await db.query('SAVEPOINT denied_legacy');
   await expect(db.query("SELECT public.set_payroll_status_atomic($1,'approved')",[voucher])).rejects.toThrow(/frozen/);
   await db.query('ROLLBACK TO SAVEPOINT denied_legacy; RELEASE SAVEPOINT denied_legacy');
   await db.query('SELECT public.approve_weekly_worker_draft($1,0)',[voucher]);
   expect((await db.query("SELECT public.record_weekly_worker_payment($1,'2024-08-10',0) v",[voucher])).rows[0].v.outcome).toBe('updated');
   const details=parseWeeklyDraftDetails((await db.query('SELECT public.weekly_worker_draft_details($1) v',[voucher])).rows[0].v,{id:voucher,worker,start:'2024-08-04'},true);
   expect(details).toMatchObject({status:'paid',draft_revision:0,gross:'800.25',bale:'100.25',net:'700.00',payment_date:'2024-08-10'});
   await db.query("SELECT public.confirm_rental_expense('70000000-0000-4000-8000-000000000011','70000000-0000-4000-8000-000000000009',$1,1000,'2024-08-04','Excavator','Excavator','Supplier',1,'2024-08-04','2024-08-10')",[site]);
   // Exercise the actual legacy expense-revision trigger alongside the rental
   // guard, with constraints resembling the observed development database.
   await db.query('RESET ROLE');
   expect((await db.query("SELECT revision FROM public.expenses WHERE id='70000000-0000-4000-8000-000000000009'")).rows[0].revision).toBe('1'); // Confirmation touches the parent for concurrency.
   expect((await db.query("UPDATE public.expenses SET notes='Non-financial note' WHERE id='70000000-0000-4000-8000-000000000009' RETURNING revision")).rows[0].revision).toBe('2');
   await db.query('SAVEPOINT rental_locked');
   await expect(db.query("UPDATE public.expenses SET amount=1001 WHERE id='70000000-0000-4000-8000-000000000009'")).rejects.toThrow(/financial details are locked/);
   await db.query('ROLLBACK TO SAVEPOINT rental_locked; RELEASE SAVEPOINT rental_locked; SET LOCAL ROLE authenticated');
   const rawCosts=(await db.query('SELECT public.project_cost_reconciliation_preview($1) v',[site])).rows[0].v;
   const costs=parseCostSnapshot(rawCosts,site);
   const choices=Object.fromEntries(costs.expenses.map(e=>[e.id,e.id==='70000000-0000-4000-8000-000000000010'?'exclude' as const:'include' as const]));
   expect(estimateProjectCost(costs,choices)).toEqual({expenses:101235n,excluded:10025n,payroll:80025n,total:181260n});
   const reviewChoices=Object.fromEntries(Object.entries(choices).map(([id,decision])=>[id,{decision,reason:decision==='exclude'?'Already represented in payroll gross':null}]));
   const reviewArgs=['70000000-0000-4000-8000-000000000021',site,0,JSON.stringify(rawCosts),JSON.stringify(reviewChoices),'Synthetic incomplete review'];
   const saveReview='SELECT public.record_project_cost_review($1,$2,$3,$4::jsonb,$5::jsonb,$6) v';
   expect((await db.query(saveReview,reviewArgs)).rows[0].v).toMatchObject({revision:1,replayed:false});
   expect((await db.query(saveReview,reviewArgs)).rows[0].v).toMatchObject({revision:1,replayed:true});
   expect((await db.query('SELECT public.project_cost_review($1) v',[site])).rows[0].v).toMatchObject({freshness:'matches',included_expenses:'1012.35',excluded_expenses:'100.25',paid_gross:'800.25',incomplete_total:'1812.60'});
   await db.query('RESET ROLE');
   const original=(await db.query('SELECT to_jsonb(p) v FROM public.payroll p WHERE id=$1',[voucher])).rows[0].v;
   const correctionSnapshot=(await db.query('SELECT app_private.paid_adjustment_voucher_snapshot(p) v FROM public.payroll p WHERE id=$1',[voucher])).rows[0].v;
   await db.query('SET LOCAL ROLE authenticated');
   await db.query("SELECT public.open_paid_payroll_adjustment('70000000-0000-4000-8000-000000000012',$1,$2,25.50,'Synthetic review')",[voucher,correctionSnapshot]);
   await db.query("SELECT public.resolve_paid_payroll_adjustment('70000000-0000-4000-8000-000000000012','settled_external','2024-08-12','Synthetic settlement')");
   await db.query('RESET ROLE');expect((await db.query('SELECT to_jsonb(p) v FROM public.payroll p WHERE id=$1',[voucher])).rows[0].v).toEqual(original);await db.query('SET LOCAL ROLE authenticated');
   // The case changes the evidence snapshot but its whole-voucher difference
   // is not silently assigned or added to a site cost.
   expect((await db.query('SELECT public.project_cost_review($1) v',[site])).rows[0].v).toMatchObject({freshness:'changed',incomplete_total:'1812.60'});
   const corrected=parseCostSnapshot((await db.query('SELECT public.project_cost_reconciliation_preview($1) v',[site])).rows[0].v,site);
   expect(corrected.adjustments).toMatchObject([{payrollId:voucher,status:'settled_external',difference:'25.50',settledOn:'2024-08-12'}]);
   expect(estimateProjectCost(corrected,choices)).toEqual({expenses:101235n,excluded:10025n,payroll:80025n,total:181260n});
   const detailHistory=(await db.query('SELECT public.attendance_history_time_batch($1::uuid[]) v',[[attendance]])).rows[0].v;
   expect(detailHistory).toMatchObject({items:[{id:attendance,detail:{regular_hours:'8.00',overtime_hours:'2.00'}}]});
   const paidSite=(await db.query('SELECT public.project_paid_worker_evidence($1) v',[site])).rows[0].v;
   expect(paidSite.items).toEqual([expect.objectContaining({payroll_id:voucher,gross:'800.25'})]);
   // Supervisor attendance is one personal day even with a site assignment;
   // its externally recorded pay stays company evidence, not a site allocation.
   await db.query(`SET LOCAL test.uid='${supervisor}'`);
   await db.query('SAVEPOINT denied_finance');
   await expect(db.query('SELECT public.project_cost_reconciliation_preview($1)',[site])).rejects.toThrow(/Founder/);
   await db.query('ROLLBACK TO SAVEPOINT denied_finance; RELEASE SAVEPOINT denied_finance');
   await db.query(`SET LOCAL test.uid='${founder}'; SET LOCAL test.assurance='no'`);
   await db.query('SAVEPOINT denied_assurance');
   await expect(db.query('SELECT public.weekly_worker_draft_details($1)',[voucher])).rejects.toThrow(/Founder|assurance/i);
   await db.query("ROLLBACK TO SAVEPOINT denied_assurance; RELEASE SAVEPOINT denied_assurance; SET LOCAL test.assurance='yes'");
   await db.query(`SET LOCAL test.uid='${supervisor}'`);
   await db.query("SELECT public.submit_supervisor_day('70000000-0000-4000-8000-000000000005','2024-08-04','present')");
   await db.query("SELECT public.submit_supervisor_leave('70000000-0000-4000-8000-000000000013','2024-08-05','2024-08-05','emergency','Synthetic leave')");
   await db.query(`SET LOCAL test.uid='${founder}'`);
   expect((await db.query('SELECT public.supervisor_leave_pending_summary() v')).rows[0].v).toEqual({pending_count:1});
   await db.query("SELECT public.review_supervisor_day('70000000-0000-4000-8000-000000000005','approved')");
   await db.query("SELECT public.review_supervisor_leave('70000000-0000-4000-8000-000000000013','approved')");
   expect((await db.query('SELECT public.supervisor_leave_pending_summary() v')).rows[0].v).toEqual({pending_count:0});
   const plan=(await db.query("SELECT public.supervisor_period_prepare($1,'2024-08-01') v",[supervisor])).rows[0].v;
   const supervisorVoucher='70000000-0000-4000-8000-000000000006';
   await db.query("SELECT public.create_supervisor_period_draft($1,$2,'2024-08-01',600,$3)",[supervisorVoucher,supervisor,JSON.stringify(plan)]);
   await db.query("SELECT public.transition_supervisor_period_payroll('70000000-0000-4000-8000-000000000007',$1,'approved',NULL,true)",[supervisorVoucher]);
   await db.query("SELECT public.transition_supervisor_period_payroll('70000000-0000-4000-8000-000000000008',$1,'recorded_paid','2024-08-15',true)",[supervisorVoucher]);
   expect((await db.query("SELECT public.supervisor_paid_company_evidence('2024-08-01','2024-08-15') v")).rows[0].v).toMatchObject({count:1,total:'600.00'});
   expect((await db.query('SELECT public.project_paid_worker_evidence($1) v',[site])).rows[0].v.items).toEqual([expect.objectContaining({payroll_id:voucher,gross:'800.25'})]);
   // A second week's unapproved request is expired by the system-only runner,
   // not treated as a release or as an additional payroll deduction.
   await db.query(`SET LOCAL test.uid='${supervisor}'; SET LOCAL test.clock='2024-08-11T04:00:00Z'`);
   const pending=(await db.query('INSERT INTO public.advance_requests(worker_id,project_id,requested_amount,submitted_by) VALUES($1,$2,90,$3) RETURNING id',[worker,site,supervisor])).rows[0].id;
   await db.query("RESET ROLE; SET LOCAL test.uid=''; SET LOCAL test.clock='2024-08-13T16:00:00Z'");
   expect((await db.query('SELECT public.weekly_bale_external_monitor_healthy() v')).rows[0].v).toBe(false);
   expect((await db.query('SELECT public.run_weekly_bale_expiry_job() v')).rows[0].v).toMatchObject({outcome:'completed',processed:1});
   expect((await db.query('SELECT public.weekly_bale_external_monitor_healthy() v')).rows[0].v).toBe(true);
   expect((await db.query('SELECT public.run_weekly_bale_expiry_job() v')).rows[0].v).toMatchObject({outcome:'completed',processed:0});
   expect((await db.query('SELECT status,auto_expired,issued_advance_id FROM public.advance_requests WHERE id=$1',[pending])).rows).toEqual([{status:'rejected',auto_expired:true,issued_advance_id:null}]);
   expect((await db.query("SELECT actor_id FROM public.audit_log WHERE table_name='advance_requests' AND record_id=$1 AND after_row->>'auto_expired'='true'",[pending])).rows).toEqual([{actor_id:null}]);
   expect((await db.query('SELECT count(*)::int n FROM public.advances WHERE worker_id=$1',[worker])).rows[0].n).toBe(1);
   // The earlier external correction and expired request must not leak into the
   // following week's new draft or create an extra advance.
   await db.query(`SET LOCAL test.uid='${founder}'`);
   await db.query("INSERT INTO public.attendance(id,worker_id,project_id,date,status,hours_worked,submitted_at) VALUES('70000000-0000-4000-8000-000000000014',$1,$2,'2024-08-11','present',8,'2024-08-11T08:00:00Z')",[worker,site]);
   await db.query(`SET LOCAL ROLE authenticated; SET LOCAL test.uid='${founder}'`);
   expect((await db.query("SELECT public.create_weekly_worker_draft('70000000-0000-4000-8000-000000000015',$1,'2024-08-11') v",[worker])).rows[0].v.calculation).toMatchObject({gross:'600.00',bale:'0.00',net:'600.00'});
   await db.query('SET CONSTRAINTS require_weekly_worker_source_on_insert IMMEDIATE; SET CONSTRAINTS require_weekly_worker_source_on_insert DEFERRED');
   await db.query('RESET ROLE');expect((await db.query('SELECT to_jsonb(p) v FROM public.payroll p WHERE id=$1',[voucher])).rows[0].v).toEqual(original);
   await db.query(`SET LOCAL ROLE authenticated; SET LOCAL test.uid='${supervisor}'`);
   await db.query("INSERT INTO public.attendance(id,worker_id,project_id,date,status,hours_worked,submitted_at) VALUES('70000000-0000-4000-8000-000000000016',$1,$2,'2024-08-18','present',8,'2024-08-18T08:00:00Z')",[worker,site]);
   await db.query('SAVEPOINT wrong_site_worker');
   await expect(db.query("INSERT INTO public.attendance(id,worker_id,project_id,date,status,hours_worked,submitted_at) VALUES('70000000-0000-4000-8000-000000000017',$1,'00000000-0000-0000-0000-000000000005','2024-08-18','present',8,'2024-08-18T08:00:00Z')",[worker])).rejects.toThrow(/one active assignment/);
   await db.query(`ROLLBACK TO SAVEPOINT wrong_site_worker; RELEASE SAVEPOINT wrong_site_worker; SET LOCAL test.uid='${founder}'`);
   const destination='00000000-0000-0000-0000-000000000005',move='70000000-0000-4000-8000-000000000018';
   expect((await db.query('SELECT public.move_worker_project($1,$2,$3,$4) v',[move,worker,site,destination])).rows[0].v.replayed).toBe(false);
   expect((await db.query('SELECT public.move_worker_project($1,$2,$3,$4) v',[move,worker,site,destination])).rows[0].v.replayed).toBe(true);
   expect((await db.query('SELECT public.project_paid_worker_evidence($1) v',[site])).rows[0].v.items).toEqual([expect.objectContaining({payroll_id:voucher,gross:'800.25'})]);
   await db.query(`SET LOCAL test.uid='${supervisor}'; SAVEPOINT former_site`);
   await expect(db.query("INSERT INTO public.attendance(id,worker_id,project_id,date,status,hours_worked,submitted_at) VALUES('70000000-0000-4000-8000-000000000019',$1,$2,'2024-08-19','present',8,'2024-08-19T08:00:00Z')",[worker,site])).rejects.toThrow(/one active assignment/);
   await db.query('ROLLBACK TO SAVEPOINT former_site; RELEASE SAVEPOINT former_site');
   await db.query("INSERT INTO public.attendance(id,worker_id,project_id,date,status,hours_worked,submitted_at) VALUES('70000000-0000-4000-8000-000000000020',$1,$2,'2024-08-19','present',8,'2024-08-19T08:00:00Z')",[worker,destination]);
   await db.query('RESET ROLE');expect((await db.query('SELECT to_jsonb(p) v FROM public.payroll p WHERE id=$1',[voucher])).rows[0].v).toEqual(original);
   expect((await db.query('SELECT project_id,event_type FROM public.project_assignment_history WHERE worker_id=$1 ORDER BY event_type,project_id',[worker])).rows).toEqual([{project_id:site,event_type:'assigned'},{project_id:destination,event_type:'assigned'},{project_id:site,event_type:'unassigned'}]);
   await db.query('ROLLBACK');expect(await snapshot()).toEqual(before);
   expect((await db.query("SELECT to_regclass('public.weekly_worker_draft_sources') IS NULL absent,to_regprocedure('public.weekly_worker_preview_base_inputs(date)') IS NULL wrapper_absent,to_regprocedure('public.weekly_worker_preview_inputs(date)') IS NOT NULL base_present,to_regprocedure('public.weekly_bale_external_monitor_healthy()') IS NULL monitor_absent")).rows[0]).toEqual({absent:true,wrapper_absent:true,base_present:true,monitor_absent:true});
  }finally{await db.query('ROLLBACK').catch(()=>{});await db.end();}
 },60000);
});
