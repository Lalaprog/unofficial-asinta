// Opt-in ONLY: a fresh synthetic, local asinta_test_* PostgreSQL database.
// Never run against a shared or hosted database: this rehearsal takes DDL locks.
import {Client} from 'pg';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {baseFixture} from './helpers/pr103-fixture';
import {parseWeeklyDraftDetails} from '@/lib/payroll/weeklyDraftDetails';
import {estimateProjectCost,parseCostSnapshot} from '@/lib/projects/projectCostReconciliation';
import {parseEquipmentSnapshot} from '@/lib/tools/ownedEquipment';
import {parseProjectEquipment} from '@/lib/tools/projectEquipment';
import {parseHistoricalProjectAttributions} from '@/lib/projects/historicalWorkerAttributions';
import {parseAttributionProjects,parseAttributionSource,parseAttributionStatus} from '@/lib/payroll/historicalAttribution';
import {estimateHistoricalProjectCost,parseHistoricalCostSnapshot} from '@/lib/projects/projectCostHistoricalReview';
import {parseSavedReview} from '@/lib/projects/projectCostReview';

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
    ALTER TABLE public.tools ADD COLUMN name text, ADD COLUMN quantity integer, ADD COLUMN condition text, ADD COLUMN project_id uuid;
    UPDATE public.tools SET name='Existing fixture equipment',quantity=0,condition='good';
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
   // Reproduce only the three observed explicit anonymous function grants.
   await db.query('GRANT EXECUTE ON FUNCTION public.review_advance_request(uuid,text),public.approve_advance_requests(uuid[]),public.issue_advance_request(uuid) TO anon,service_role');
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
    (SELECT md5(coalesce(string_agg(row_to_json(t)::text,',' ORDER BY id),'')) FROM public.tools t) tools,
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
   // guard are not in the generated 28-draft chain. Install only inside this
   // disposable rollback transaction.
   await db.query(readFileSync('supabase/drafts/project_assignment_history.sql','utf8'));
   await db.query(readFileSync('supabase/drafts/atomic_worker_move.sql','utf8'));
   await db.query(readFileSync('supabase/drafts/attendance_assignment_guard.sql','utf8'));
   // Separate uninstalled legacy RPC ACL candidate; modeled grants return on rollback.
   await db.query(readFileSync('supabase/drafts/legacy_bale_request_anon_acl.sql','utf8'));
   const legacySignatures=['public.review_advance_request(uuid,text)','public.approve_advance_requests(uuid[])','public.issue_advance_request(uuid)'];
   for(const signature of legacySignatures)expect((await db.query("SELECT has_function_privilege('anon',$1,'EXECUTE') anon,has_function_privilege('authenticated',$1,'EXECUTE') authenticated,has_function_privilege('service_role',$1,'EXECUTE') service",[signature])).rows[0]).toEqual({anon:false,authenticated:true,service:true});
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
   // New external-pay attribution evidence is separate and never posts project costs.
   await db.query(readFileSync('supabase/drafts/historical_worker_project_attribution.sql','utf8'));
   await db.query(readFileSync('supabase/drafts/project_cost_historical_review.sql','utf8'));
   // Equipment is outside the generated chain; only this disposable transaction installs it.
   await db.query(readFileSync('supabase/drafts/owned_equipment_allocations.sql','utf8'));
   expect((await db.query("SELECT has_table_privilege('service_role','public.owned_equipment_allocations','INSERT,UPDATE,DELETE') allowed")).rows[0].allowed).toBe(false);
   // Rehearse category integration and entry-time craft observations with all the finance guards.
   for (const p of ['worker_category_catalog','worker_category_workforce_cutover','worker_removal_category_compatibility','recorded_craft_observations']) await db.query(readFileSync(`supabase/drafts/${p}.sql`,'utf8'));
   await db.query(`SET LOCAL test.uid='${founder}'; SET LOCAL test.assurance='yes'`);
   await db.query("INSERT INTO public.attendance(id,worker_id,project_id,date,status,hours_worked,submitted_at) VALUES($1,$2,$3,'2024-08-04','present',8,'2024-08-04T08:00:00Z')",[attendance,worker,site]);
   await db.query('INSERT INTO public.project_worker_assignments(project_id,worker_id,active) VALUES($1,$2,true)',[site,worker]);
   await db.query('SET LOCAL ROLE service_role; SAVEPOINT denied_assignment_writer');
   await expect(db.query('UPDATE public.project_worker_assignments SET active=false WHERE worker_id=$1',[worker])).rejects.toThrow(/permission denied/);
   await db.query('ROLLBACK TO SAVEPOINT denied_assignment_writer; RELEASE SAVEPOINT denied_assignment_writer');
   await db.query('SELECT public.set_project_worker_guarded($1,$2,$3,true)',[founder,site,worker]);
   await db.query('RESET ROLE');
   await db.query("INSERT INTO public.project_supervisors(project_id,supervisor_id) VALUES('00000000-0000-0000-0000-000000000005',$1)",[supervisor]);
   await db.query("INSERT INTO public.tools(id,name,quantity,condition,project_id) VALUES('70000000-0000-4000-8000-000000000030','Synthetic drill',5,'good',NULL)");
   await db.query("INSERT INTO public.workers(id,name,position,contact_number,pay_rate,pay_rate_type,active) VALUES($1,'Supervisor','Site Supervisor','none',600,'daily',true)",[supervisor]);
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
   expect((await db.query('SELECT craft FROM public.attendance_craft_observations WHERE attendance_id=$1',[attendance])).rows).toEqual([{craft:'Mason'}]);
   expect((await db.query('SELECT craft FROM public.payroll_craft_observations WHERE payroll_id=$1',[voucher])).rows).toEqual([{craft:'Mason'}]);
   await db.query('SAVEPOINT denied_legacy');
   await expect(db.query("SELECT public.set_payroll_status_atomic($1,'approved')",[voucher])).rejects.toThrow(/frozen/);
   await db.query('ROLLBACK TO SAVEPOINT denied_legacy; RELEASE SAVEPOINT denied_legacy');
   await db.query('SELECT public.approve_weekly_worker_draft($1,0)',[voucher]);
   expect((await db.query("SELECT public.record_weekly_worker_payment($1,'2024-08-10',0) v",[voucher])).rows[0].v.outcome).toBe('updated');
   const details=parseWeeklyDraftDetails((await db.query('SELECT public.weekly_worker_draft_details($1) v',[voucher])).rows[0].v,{id:voucher,worker,start:'2024-08-04'},true);
   expect(details).toMatchObject({status:'paid',draft_revision:0,gross:'800.25',bale:'100.25',net:'700.00',payment_date:'2024-08-10'});
   expect((await db.query('SELECT public.weekly_paid_attendance_change_review($1) v',[voucher])).rows[0].v.attendance).toBe('unchanged');
   await db.query('SAVEPOINT paid_attendance_change; RESET ROLE');
   await db.query("UPDATE public.attendance SET notes='Synthetic later review' WHERE id=$1",[attendance]);await db.query('SET LOCAL ROLE authenticated');
   expect((await db.query('SELECT public.weekly_paid_attendance_change_review($1) v',[voucher])).rows[0].v.attendance).toBe('changed');
   expect((await db.query('SELECT status,net_pay::text net FROM public.payroll WHERE id=$1',[voucher])).rows[0]).toEqual({status:'paid',net:'700.00'});
   await db.query('ROLLBACK TO SAVEPOINT paid_attendance_change; RELEASE SAVEPOINT paid_attendance_change');
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
   // Owned stock movements are inventory, not a second rental expense or payroll cost.
   const drill='70000000-0000-4000-8000-000000000030',siteTwo='00000000-0000-0000-0000-000000000005';
   const equipmentChange='SELECT public.change_owned_equipment($1,$2,$3,$4,$5,$6,$7) v';
   const adopt=['70000000-0000-4000-8000-000000000031',drill,'adopt',null,null,5,null];
   expect((await db.query(equipmentChange,adopt)).rows[0].v).toMatchObject({allocated:0,depot:5,replayed:false});
   expect((await db.query(equipmentChange,adopt)).rows[0].v.replayed).toBe(true);
   expect((await db.query(equipmentChange,['70000000-0000-4000-8000-000000000032',drill,'allocate',site,3,5,0])).rows[0].v).toMatchObject({allocated:3,depot:2});
   expect((await db.query(equipmentChange,['70000000-0000-4000-8000-000000000033',drill,'allocate',siteTwo,1,5,0])).rows[0].v).toMatchObject({allocated:4,depot:1});
   const inventory=parseEquipmentSnapshot((await db.query('SELECT public.owned_equipment_snapshot() v')).rows[0].v);
   expect(inventory.items.find(item=>item.id===drill)).toMatchObject({stock:5,managed:true,sites:[{project_id:site,name:'Site One',quantity:3},{project_id:siteTwo,name:'Site Two',quantity:1}]});
   await db.query(`SET LOCAL test.uid='${supervisor}'`);
   expect(parseProjectEquipment((await db.query('SELECT public.project_equipment_snapshot($1) v',[site])).rows[0].v,site).items).toEqual([expect.objectContaining({id:drill,quantity:3,source:'allocated'})]);
   expect(parseProjectEquipment((await db.query('SELECT public.project_equipment_snapshot($1) v',[siteTwo])).rows[0].v,siteTwo).items).toEqual([expect.objectContaining({id:drill,quantity:1,source:'allocated'})]);
   await db.query(`SET LOCAL test.uid='${founder}'`);
   expect(estimateProjectCost(parseCostSnapshot((await db.query('SELECT public.project_cost_reconciliation_preview($1) v',[site])).rows[0].v,site),choices)).toEqual({expenses:101235n,excluded:10025n,payroll:80025n,total:181260n});
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
   // An earlier external assertion is evidence only: it creates no voucher,
   // advance or site allocation and a correction never enters later payroll.
   const historicalId='70000000-0000-4000-8000-000000000038',historicalCase='70000000-0000-4000-8000-000000000039';
   const historicalWorker=(await db.query("SELECT public.historical_external_worker_review($1,'2024-07-28') v",[worker])).rows[0].v.worker;
   const historicalArgs=[historicalId,worker,JSON.stringify(historicalWorker)];
   const historicalRecord="SELECT public.record_historical_external_worker_payroll($1,$2,'2024-07-28','2024-08-03',600,100,0,500,'Synthetic external evidence',$3::jsonb,true) v";
   expect((await db.query(historicalRecord,historicalArgs)).rows[0].v).toMatchObject({replayed:false});
   expect((await db.query(historicalRecord,historicalArgs)).rows[0].v).toMatchObject({replayed:true});
   const historicalSnap=(await db.query("SELECT public.paid_period_assertion_case_list('external_worker',$1) v",[historicalId])).rows[0].v.snapshot;
   const historicalSource=(await db.query('SELECT public.historical_external_worker_lookup($1) v',[historicalId])).rows[0].v;
   expect(parseAttributionProjects((await db.query('SELECT public.historical_worker_attribution_projects() v')).rows[0].v)).toEqual(expect.arrayContaining([expect.objectContaining({id:site}),expect.objectContaining({id:siteTwo})]));
   expect(parseAttributionSource(historicalSource,worker,historicalId)).toEqual(historicalSource);
   const attributionId='70000000-0000-4000-8000-000000000040';
   const attributionSplit=[{project_id:site,gross:'400.25'},{project_id:siteTwo,gross:'199.75'}];
   const attributionArgs=[attributionId,historicalId,JSON.stringify(historicalSource),JSON.stringify(attributionSplit)];
   const recordAttribution="SELECT public.record_historical_worker_attribution($1,$2,$3::jsonb,$4::jsonb,'Synthetic original evidence reviewed',true) v";
   expect((await db.query(recordAttribution,attributionArgs)).rows[0].v).toMatchObject({source_id:historicalId,replayed:false});
   expect((await db.query(recordAttribution,attributionArgs)).rows[0].v.replayed).toBe(true);
   const combinedRaw=(await db.query('SELECT public.project_cost_historical_review($1) v',[site])).rows[0].v;
   const combined=parseHistoricalCostSnapshot(combinedRaw,site);
   expect(combined.historical).toMatchObject([{requestId:attributionId,siteGross:'400.25',caseCount:0,overlappingVouchers:0}]);
   expect(estimateHistoricalProjectCost(combined,choices,{[attributionId]:'include'})).toMatchObject({expenses:101235n,payroll:80025n,historical:40025n,total:221285n});
   const historicalReviewArgs=['70000000-0000-4000-8000-000000000022',site,1,JSON.stringify(combinedRaw),JSON.stringify({expenses:reviewChoices,historical:{[attributionId]:{decision:'include',reason:null}}}),'Reviewed historical attribution'];
   expect((await db.query(saveReview,historicalReviewArgs)).rows[0].v).toMatchObject({revision:2,replayed:false});
   expect((await db.query(saveReview,historicalReviewArgs)).rows[0].v.replayed).toBe(true);
   const savedHistorical=(await db.query('SELECT public.project_cost_review($1) v',[site])).rows[0].v;
   expect(savedHistorical).toMatchObject({review_kind:'historical',historical_gross:'400.25',incomplete_total:'2212.85',freshness:'matches'});
   expect(parseSavedReview(savedHistorical,site)).toMatchObject({found:true,total:221285n});
   await db.query("SELECT public.open_paid_period_assertion_case($1,'external_worker',$2,$3,20,'Synthetic external review')",[historicalCase,historicalId,JSON.stringify(historicalSnap)]);
   await db.query("SELECT public.resolve_paid_period_assertion_case($1,'no_transfer',NULL,'Synthetic review complete',true)",[historicalCase]);
   const withCase=parseHistoricalCostSnapshot((await db.query('SELECT public.project_cost_historical_review($1) v',[site])).rows[0].v,site);
   expect(withCase.historical[0].caseCount).toBe(1);
   expect((await db.query('SELECT public.project_cost_review($1) v',[site])).rows[0].v).toMatchObject({freshness:'changed',incomplete_total:'2212.85'});
   const caseRaw=(await db.query('SELECT public.project_cost_historical_review($1) v',[site])).rows[0].v;
   await db.query('SAVEPOINT flagged_historical_review');
   await expect(db.query(saveReview,['70000000-0000-4000-8000-000000000023',site,2,JSON.stringify(caseRaw),historicalReviewArgs[4],'Flagged record'])).rejects.toThrow(/case or overlap/);
   await db.query('ROLLBACK TO SAVEPOINT flagged_historical_review; RELEASE SAVEPOINT flagged_historical_review');
   expect(()=>estimateHistoricalProjectCost(withCase,choices,{[attributionId]:'include'})).toThrow(/Investigate/);
   expect(estimateHistoricalProjectCost(withCase,choices,{[attributionId]:'exclude'})).toMatchObject({total:181260n,excludedHistorical:40025n});
   expect(parseAttributionStatus((await db.query('SELECT public.historical_worker_attribution($1) v',[historicalId])).rows[0].v,worker,historicalId)).toMatchObject({found:true,request_id:attributionId,case_count:1,source_changed:false});
   const historicalSiteRaw=(await db.query('SELECT public.project_historical_worker_attributions($1) v',[site])).rows[0].v;
   expect(historicalSiteRaw.items).toEqual([expect.objectContaining({source_id:historicalId,site_gross:'400.25',original_gross:'600.00',case_count:1})]);
   expect(parseHistoricalProjectAttributions(historicalSiteRaw,site)).toEqual([expect.objectContaining({sourceId:historicalId,siteGross:'400.25',caseCount:1})]);
   expect((await db.query('SELECT public.project_historical_worker_attributions($1) v',[siteTwo])).rows[0].v.items).toEqual([expect.objectContaining({source_id:historicalId,site_gross:'199.75',case_count:1})]);

   await db.query('RESET ROLE');
   expect((await db.query("SELECT count(*)::int n FROM public.payroll WHERE worker_id=$1 AND period_start='2024-07-28'",[worker])).rows[0].n).toBe(0);
   expect((await db.query("SELECT count(*)::int n FROM public.advances WHERE worker_id=$1 AND date BETWEEN '2024-07-28' AND '2024-08-03'",[worker])).rows[0].n).toBe(0);
   await db.query('SET LOCAL ROLE authenticated');
   expect(estimateProjectCost(parseCostSnapshot((await db.query('SELECT public.project_cost_reconciliation_preview($1) v',[site])).rows[0].v,site),choices)).toEqual({expenses:101235n,excluded:10025n,payroll:80025n,total:181260n});
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
   // Retire the old auto-self-row: otherwise the legacy signal blocks the
   // new company-wide Supervisor period even for an ordinary crew Roll Call.
   await db.query('SAVEPOINT denied_old_supervisor_site');
   await expect(db.query("INSERT INTO public.attendance(id,worker_id,project_id,date,status,hours_worked,submitted_at) VALUES('70000000-0000-4000-8000-000000000024',$1,$2,'2024-08-04','present',8,'2024-08-04T08:00:00Z')",[supervisor,site])).rejects.toThrow(/general daily attendance/);
   await db.query('ROLLBACK TO SAVEPOINT denied_old_supervisor_site; RELEASE SAVEPOINT denied_old_supervisor_site');
   await db.query("SELECT public.submit_supervisor_day('70000000-0000-4000-8000-000000000005','2024-08-04','present')");
   await db.query("SELECT public.submit_supervisor_leave('70000000-0000-4000-8000-000000000013','2024-08-05','2024-08-05','emergency','Synthetic leave')");
   await db.query(`SET LOCAL test.uid='${founder}'`);
   expect((await db.query('SELECT public.supervisor_leave_pending_summary() v')).rows[0].v).toEqual({pending_count:1});
   await db.query("SELECT public.review_supervisor_day('70000000-0000-4000-8000-000000000005','approved')");
   await db.query("SELECT public.review_supervisor_leave('70000000-0000-4000-8000-000000000013','approved')");
   expect((await db.query('SELECT public.supervisor_leave_pending_summary() v')).rows[0].v).toEqual({pending_count:0});
   const backfill='70000000-0000-4000-8000-000000000025';
   const backfillArgs=[backfill,supervisor,'2024-07-31','half_day','Founder reviewed synthetic source'];
   expect((await db.query('SELECT public.record_supervisor_day_backfill($1,$2,$3,$4,$5) v',backfillArgs)).rows[0].v).toMatchObject({status:'pending',replayed:false});
   expect((await db.query('SELECT public.record_supervisor_day_backfill($1,$2,$3,$4,$5) v',backfillArgs)).rows[0].v.replayed).toBe(true);
   expect((await db.query('SELECT public.supervisor_day_backfill_lookup($1) v',[backfill])).rows[0].v).toMatchObject({id:backfill,supervisor_id:supervisor,founder_id:founder,reason:'Founder reviewed synthetic source'});
   await db.query("SELECT public.review_supervisor_day($1,'approved')",[backfill]);
   const plan=(await db.query("SELECT public.supervisor_period_prepare($1,'2024-08-01') v",[supervisor])).rows[0].v;
   expect(plan.input.legacy_count).toBe(0);
   const supervisorVoucher='70000000-0000-4000-8000-000000000006';
   await db.query("SELECT public.create_supervisor_period_draft($1,$2,'2024-08-01',600,$3)",[supervisorVoucher,supervisor,JSON.stringify(plan)]);
   await db.query("SELECT public.transition_supervisor_period_payroll('70000000-0000-4000-8000-000000000007',$1,'approved',NULL,true)",[supervisorVoucher]);
   await db.query("SELECT public.transition_supervisor_period_payroll('70000000-0000-4000-8000-000000000008',$1,'recorded_paid','2024-08-15',true)",[supervisorVoucher]);
   expect((await db.query("SELECT public.supervisor_paid_company_evidence('2024-08-01','2024-08-15') v")).rows[0].v).toMatchObject({count:1,total:'600.00'});
   // A retroactive emergency request after recorded pay is flagged for review;
   // it never changes the original paid ledger or carries a case into the next period.
   await db.query('RESET ROLE');
   const paidSupervisorBefore=(await db.query('SELECT to_jsonb(p) v FROM public.supervisor_period_payroll p WHERE id=$1',[supervisorVoucher])).rows[0].v;
   await db.query(`SET LOCAL ROLE authenticated; SET LOCAL test.uid='${supervisor}'`);
   const lateLeave='70000000-0000-4000-8000-000000000034';
   await db.query("SELECT public.submit_supervisor_leave($1,'2024-08-06','2024-08-06','emergency','Synthetic late leave')",[lateLeave]);
   await db.query(`SET LOCAL test.uid='${founder}'`);
   const leaveList=(await db.query('SELECT public.supervisor_leave_list() v')).rows[0].v;
   expect(leaveList.items.find((entry:{id:string})=>entry.id===lateLeave)).toMatchObject({possible_paid_overlap:true});
   await db.query("SELECT public.review_supervisor_leave($1,'approved')",[lateLeave]);
   expect((await db.query("SELECT public.supervisor_period_payroll_review($1,'2024-08-01') v",[supervisor])).rows[0].v).toMatchObject({status:'paid',gross:'600.00',source_changed:true});
   const paidSupervisorSnapshot=(await db.query("SELECT public.paid_period_assertion_case_list('supervisor',$1) v",[supervisorVoucher])).rows[0].v.snapshot;
   const caseId='70000000-0000-4000-8000-000000000035';
   const openCase="SELECT public.open_paid_period_assertion_case($1,'supervisor',$2,$3,-75,'Synthetic original-period review') v";
   expect((await db.query(openCase,[caseId,supervisorVoucher,JSON.stringify(paidSupervisorSnapshot)])).rows[0].v).toMatchObject({status:'pending',replayed:false});
   expect((await db.query(openCase,[caseId,supervisorVoucher,JSON.stringify(paidSupervisorSnapshot)])).rows[0].v).toMatchObject({status:'pending',replayed:true});
   const resolveCase="SELECT public.resolve_paid_period_assertion_case($1,'no_transfer',NULL,'Synthetic review complete',true) v";
   expect((await db.query(resolveCase,[caseId])).rows[0].v).toMatchObject({status:'no_transfer',replayed:false});
   expect((await db.query(resolveCase,[caseId])).rows[0].v).toMatchObject({status:'no_transfer',replayed:true});
   await db.query('RESET ROLE');
   expect((await db.query('SELECT to_jsonb(p) v FROM public.supervisor_period_payroll p WHERE id=$1',[supervisorVoucher])).rows[0].v).toEqual(paidSupervisorBefore);
   await db.query(`SET LOCAL ROLE authenticated; SET LOCAL test.uid='${supervisor}'`);
   await db.query("SELECT public.submit_supervisor_day('70000000-0000-4000-8000-000000000036','2024-08-16','present')");
   await db.query(`SET LOCAL test.uid='${founder}'`);
   await db.query("SELECT public.review_supervisor_day('70000000-0000-4000-8000-000000000036','approved')");
   const nextSupervisorPlan=(await db.query("SELECT public.supervisor_period_prepare($1,'2024-08-16') v",[supervisor])).rows[0].v;
   await db.query("SELECT public.create_supervisor_period_draft('70000000-0000-4000-8000-000000000037',$1,'2024-08-16',600,$2)",[supervisor,JSON.stringify(nextSupervisorPlan)]);
   expect((await db.query("SELECT public.supervisor_period_payroll_review($1,'2024-08-16') v",[supervisor])).rows[0].v).toMatchObject({status:'draft',gross:'600.00'});
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
   for(const signature of legacySignatures)expect((await db.query("SELECT has_function_privilege('anon',$1,'EXECUTE') allowed",[signature])).rows[0].allowed).toBe(true);
   expect((await db.query("SELECT to_regclass('public.owned_equipment_allocations') IS NULL absent,to_regclass('public.historical_worker_attributions') IS NULL attribution_absent")).rows[0]).toEqual({absent:true,attribution_absent:true});
   expect((await db.query("SELECT to_regclass('public.weekly_worker_draft_sources') IS NULL absent,to_regprocedure('public.weekly_worker_preview_base_inputs(date)') IS NULL wrapper_absent,to_regprocedure('public.weekly_worker_preview_inputs(date)') IS NOT NULL base_present,to_regprocedure('public.weekly_bale_external_monitor_healthy()') IS NULL monitor_absent")).rows[0]).toEqual({absent:true,wrapper_absent:true,base_present:true,monitor_absent:true});
   // Exercise the actual ordered development cutover candidate against the
   // two already-staged migrations, independently of the rollback generator.
   // This database is still synthetic: the enclosing transaction is rolled back.
   const stagedCutover=execFileSync('node',['scripts/build-development-finance-cutover.mjs'],{encoding:'utf8'});
   expect(stagedCutover).toBe(readFileSync('supabase/release/development-finance-cutover.sql','utf8'));
   if(stagedCutover.includes('$cutover_source$'))throw Error('Unexpected SQL quote delimiter');
   // Exercise the exact large SQL as a single SQL statement as well; the
   // managed migration interface may submit the verified payload in one call.
   const singleStatement=`DO $outer$ BEGIN EXECUTE $cutover_source$${stagedCutover}$cutover_source$; END $outer$;`;
   const prepareStaged=async()=>{
    // Model the observed empty development business state, not its users.
    await db.query('DELETE FROM public.payroll; DELETE FROM public.attendance; DELETE FROM public.expenses; DELETE FROM public.project_supervisors; DELETE FROM public.tools; DELETE FROM public.workers; DELETE FROM public.projects');
    await db.query(readFileSync('supabase/drafts/legacy_bale_request_anon_acl.sql','utf8'));
    await db.query(readFileSync('supabase/applied_development/staged_attendance_time_foundation.sql','utf8'));
    await db.query(readFileSync('supabase/applied_development/staged_attendance_time_preview.sql','utf8'));
   };
   // A collision near the end must roll back the entire coordinated installation.
   await db.query('BEGIN'); await prepareStaged();
   await db.query('CREATE TABLE public.confirmed_rental_expenses(id uuid)');
   await expect(db.query(stagedCutover)).rejects.toThrow(/already exist|collision/i);
   await db.query('ROLLBACK'); expect(await snapshot()).toEqual(before);
   expect((await db.query("SELECT to_regclass('public.worker_allowances') IS NULL absent,to_regclass('public.attendance_time_details') IS NULL staged_absent")).rows[0]).toEqual({absent:true,staged_absent:true});
   await db.query('BEGIN'); await prepareStaged();
   await db.query('SAVEPOINT unexpected_business_data');
   await db.query("INSERT INTO public.projects(id,name) VALUES($1,'Synthetic drift')",[site]);
   await expect(db.query(stagedCutover)).rejects.toThrow(/Development business records exist/);
   await db.query('ROLLBACK TO SAVEPOINT unexpected_business_data; RELEASE SAVEPOINT unexpected_business_data');
   await db.query('SAVEPOINT changed_time_grant');
   await db.query('GRANT EXECUTE ON FUNCTION public.record_attendance_time_detail(uuid,uuid,timestamptz,numeric,numeric,text) TO authenticated');
   await expect(db.query(stagedCutover)).rejects.toThrow(/Staged time writer changed or enabled/);
   await db.query('ROLLBACK TO SAVEPOINT changed_time_grant; RELEASE SAVEPOINT changed_time_grant');
   await db.query(singleStatement);
   // Synthetic records only, in this local transaction, after installation.
   await db.query("INSERT INTO public.projects(id,name) VALUES($1,'Site One'),('00000000-0000-0000-0000-000000000005','Site Two')",[site]);
   await db.query("INSERT INTO public.workers(id,name,position,contact_number,pay_rate,pay_rate_type,active) VALUES($1,'Test Worker','Mason','none',600,'daily',true)",[worker]);
   await db.query('INSERT INTO public.project_supervisors(project_id,supervisor_id) VALUES($1,$2)',[site,supervisor]);
   expect((await db.query("SELECT has_function_privilege('authenticated','public.record_attendance_time_detail(uuid,uuid,timestamptz,numeric,numeric,text)','EXECUTE') allowed")).rows[0].allowed).toBe(true);
   expect((await db.query("SELECT count(*)::int n FROM pg_trigger WHERE tgrelid IN ('public.payroll'::regclass,'public.advances'::regclass) AND tgname IN ('require_weekly_worker_source_on_insert','require_weekly_bale_source_on_insert') AND tgenabled='O'")).rows[0].n).toBe(2);
   await db.query("CREATE OR REPLACE FUNCTION public.weekly_bale_clock() RETURNS timestamptz LANGUAGE sql VOLATILE SET search_path='' AS $$SELECT current_setting('test.clock')::timestamptz$$");
   await db.query(`SET LOCAL test.uid='${founder}'; SET LOCAL test.assurance='yes'; SET LOCAL test.clock='2024-08-04T04:00:00Z'`);
   await db.query('SELECT public.set_project_worker_guarded($1,$2,$3,true)',[founder,site,worker]);
   await db.query("INSERT INTO public.attendance(id,worker_id,project_id,date,status,hours_worked,submitted_at) VALUES($1,$2,$3,'2024-08-04','present',8,'2024-08-04T08:00:00Z')",[attendance,worker,site]);
   await db.query(`SET LOCAL ROLE authenticated; SET LOCAL test.uid='${supervisor}'`);
   const cutoverRequest=(await db.query('INSERT INTO public.advance_requests(worker_id,project_id,requested_amount,submitted_by) VALUES($1,$2,100.25,$3) RETURNING id',[worker,site,supervisor])).rows[0].id;
   await db.query(`SET LOCAL test.uid='${founder}'; SET LOCAL test.clock='2024-08-06T04:00:00Z'`);
   await db.query("SELECT public.review_advance_request($1,'approve')",[cutoverRequest]);
   await db.query(`SET LOCAL test.uid='${supervisor}'; SET LOCAL test.clock='2024-08-07T04:00:00Z'`);
   expect((await db.query('SELECT public.record_weekly_bale_release($1) v',[cutoverRequest])).rows[0].v.outcome).toBe('updated');
   await db.query(`SET LOCAL test.uid='${founder}'`);
   await db.query("SELECT public.record_attendance_time_detail('70000000-0000-4000-8000-000000000003',$1,'2024-08-04T08:00:00Z',8,2,'Synthetic overtime')",[attendance]);
   expect((await db.query("SELECT public.create_weekly_worker_draft($1,$2,'2024-08-04') v",[voucher,worker])).rows[0].v.calculation).toMatchObject({gross:'750.00',bale:'100.25',net:'649.75'});
   await db.query('SET CONSTRAINTS require_weekly_worker_source_on_insert,require_weekly_bale_source_on_insert IMMEDIATE');
   await db.query('SELECT public.approve_weekly_worker_draft($1,0)',[voucher]);
   expect((await db.query("SELECT public.record_weekly_worker_payment($1,'2024-08-10',0) v",[voucher])).rows[0].v.outcome).toBe('updated');
   expect((await db.query('SELECT public.project_paid_worker_evidence($1) v',[site])).rows[0].v.items).toEqual([expect.objectContaining({payroll_id:voucher,gross:'750.00'})]);
   await db.query('RESET ROLE');
   await db.query("INSERT INTO public.workers(id,name,position,contact_number,pay_rate,pay_rate_type,active) VALUES($1,'Supervisor','Supervisor','none',600,'daily',true)",[supervisor]);
   await db.query(`SET LOCAL ROLE authenticated; SET LOCAL test.uid='${supervisor}'`);
   await db.query("SELECT public.submit_supervisor_day('70000000-0000-4000-8000-000000000005','2024-08-04','present')");
   await db.query("SELECT public.submit_supervisor_leave('70000000-0000-4000-8000-000000000013','2024-08-05','2024-08-05','emergency','Synthetic leave')");
   await db.query(`SET LOCAL test.uid='${founder}'`);
   await db.query("SELECT public.review_supervisor_day('70000000-0000-4000-8000-000000000005','approved')");
   await db.query("SELECT public.review_supervisor_leave('70000000-0000-4000-8000-000000000013','approved')");
   const stagedPlan=(await db.query("SELECT public.supervisor_period_prepare($1,'2024-08-01') v",[supervisor])).rows[0].v;
   const stagedSupervisorVoucher='70000000-0000-4000-8000-000000000006';
   await db.query("SELECT public.create_supervisor_period_draft($1,$2,'2024-08-01',600,$3)",[stagedSupervisorVoucher,supervisor,JSON.stringify(stagedPlan)]);
   await db.query("SELECT public.transition_supervisor_period_payroll('70000000-0000-4000-8000-000000000007',$1,'approved',NULL,true)",[stagedSupervisorVoucher]);
   await db.query("SELECT public.transition_supervisor_period_payroll('70000000-0000-4000-8000-000000000008',$1,'recorded_paid','2024-08-15',true)",[stagedSupervisorVoucher]);
   expect((await db.query("SELECT public.supervisor_paid_company_evidence('2024-08-01','2024-08-15') v")).rows[0].v).toMatchObject({count:1,total:'600.00'});
   await db.query('RESET ROLE; ROLLBACK');
   expect(await snapshot()).toEqual(before);
  }finally{await db.query('ROLLBACK').catch(()=>{});await db.end();}
 },90000);
});
