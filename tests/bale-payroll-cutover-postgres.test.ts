// Opt-in only: synthetic data, fresh local disposable PostgreSQL database.
import {readFileSync} from 'node:fs';
import {Client} from 'pg';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {baseFixture} from './helpers/pr103-fixture';
import {estimateProjectCost,parseCostSnapshot} from '@/lib/projects/projectCostReconciliation';
import {parseWeeklyDraftDetails} from '@/lib/payroll/weeklyDraftDetails';
const url=process.env.BALE_PAYROLL_CUTOVER_TEST_DATABASE_URL;
const suite=url?describe:describe.skip;
const founder='00000000-0000-0000-0000-000000000001',supervisor='00000000-0000-0000-0000-000000000002',site='00000000-0000-0000-0000-000000000004';
const id=(n:number)=>`40000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const pause=()=>new Promise(resolve=>setTimeout(resolve,150));
let admin:Client,first:Client,second:Client;
const generate=(c:Client,payroll:string,worker:string,start:string)=>c.query('SELECT public.create_weekly_worker_draft($1,$2,$3) result',[payroll,worker,start]);
const approve=(c:Client,payroll:string)=>c.query('SELECT public.approve_weekly_worker_draft($1) result',[payroll]);
const release=(c:Client,request:string)=>c.query('SELECT public.record_weekly_bale_release($1) result',[request]);
async function request(worker:string,sunday:string,tuesday:string,wednesday:string){
 await first.query(`SET test.uid='${supervisor}'`);await first.query("SELECT set_config('test.clock',$1,false)",[`${sunday}T04:00:00Z`]);
 const req=(await first.query('INSERT INTO public.advance_requests(worker_id,project_id,requested_amount,submitted_by) VALUES($1,$2,100.25,$3) RETURNING id',[worker,site,supervisor])).rows[0].id as string;
 await first.query(`SET test.uid='${founder}'`);await first.query("SELECT set_config('test.clock',$1,false)",[`${tuesday}T04:00:00Z`]);await first.query("SELECT public.review_advance_request($1,'approve')",[req]);
 await second.query(`SET test.uid='${supervisor}'`);await second.query("SELECT set_config('test.clock',$1,false)",[`${wednesday}T04:00:00Z`]);return req;
}
suite('real PostgreSQL combined weekly Bale and payroll candidate races',()=>{
 beforeAll(async()=>{
  const parsed=new URL(url!);if(!['localhost','127.0.0.1','[::1]'].includes(parsed.hostname)||!parsed.pathname.slice(1).startsWith('asinta_test_')||parsed.search||parsed.hash)throw Error('Use an empty local disposable asinta_test_* database without URL options.');
  admin=new Client({connectionString:url});first=new Client({connectionString:url});second=new Client({connectionString:url});await Promise.all([admin.connect(),first.connect(),second.connect()]);
  const existing=(await admin.query(`SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S'))::int objects, (SELECT count(*) FROM pg_namespace WHERE nspname IN ('auth','app_private','storage'))::int schemas`)).rows[0];if(existing.objects||existing.schemas)throw Error('Database must be empty.');
  await admin.query(`DO $$BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF; END$$;`);
  const roles='CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; ';if(!baseFixture.startsWith(roles))throw Error('Fixture role bootstrap changed');await admin.query(baseFixture.slice(roles.length));
  await admin.query(`ALTER TABLE public.users ADD COLUMN email text; UPDATE public.users SET email='fixture@example.invalid'; ALTER TABLE public.payroll ADD COLUMN notes text; ALTER TABLE public.expenses ADD COLUMN ai_bale_detection boolean DEFAULT false;
   INSERT INTO public.expenses(id,project_id,description,category,amount,expense_date,ai_bale_detection) VALUES ('${id(601)}','${site}','Excavator','equipment',1000,'2024-12-15',false),('${id(602)}','${site}','Bale expense','other',100.25,'2024-12-18',true);
   ALTER TABLE public.advances ADD COLUMN reason text, ADD COLUMN created_at timestamptz DEFAULT now(); ALTER TABLE public.advances ALTER COLUMN id SET DEFAULT gen_random_uuid();
   ALTER TABLE public.advance_requests ADD COLUMN approved_by uuid, ADD COLUMN approved_at timestamptz, ADD COLUMN rejected_by uuid, ADD COLUMN rejected_at timestamptz, ADD COLUMN issued_by uuid, ADD COLUMN updated_at timestamptz DEFAULT now();
   CREATE TABLE public.project_worker_assignments(project_id uuid,worker_id uuid,active boolean,primary key(project_id,worker_id));
   DROP TABLE public.audit_log; CREATE TABLE public.audit_log(actor_id uuid,actor_email text,action text,table_name text,record_id uuid,before_row jsonb,after_row jsonb);
   CREATE POLICY test_founder_payroll_write ON public.payroll FOR ALL TO authenticated USING(public.is_founder()) WITH CHECK(public.is_founder());
   INSERT INTO public.workers(id,name,position,contact_number,pay_rate,pay_rate_type,active) VALUES
    ('${id(101)}','Worker One','Mason','none',600,'daily',true),('${id(102)}','Worker Two','Mason','none',600,'daily',true),('${id(103)}','Worker Three','Mason','none',600,'daily',true),('${id(104)}','Worker Four','Mason','none',600,'daily',true);
   INSERT INTO public.project_worker_assignments VALUES ('${site}','${id(101)}',true),('${site}','${id(102)}',true),('${site}','${id(103)}',true),('${site}','${id(104)}',true);
   INSERT INTO public.attendance(id,worker_id,project_id,date,status,hours_worked,submitted_at) VALUES
    ('${id(201)}','${id(101)}','${site}','2024-12-01','present',8,'2024-12-01T08:00:00Z'),
    ('${id(202)}','${id(102)}','${site}','2024-12-08','present',8,'2024-12-08T08:00:00Z'),
    ('${id(203)}','${id(103)}','${site}','2024-12-15','present',8,'2024-12-15T08:00:00Z'),
    ('${id(204)}','${id(103)}','${site}','2024-12-22','present',8,'2024-12-22T08:00:00Z'),
    ('${id(205)}','${id(104)}','${site}','2024-12-29','present',8,'2024-12-29T08:00:00Z');`);
  const paths=['supabase/migrations/20261102000000_atomic_payroll_payments.sql','supabase/migrations/20261113000000_weekly_worker_preview.sql','supabase/migrations/20261113000001_attendance_time_detail.sql','supabase/migrations/20261113000002_worker_allowances.sql','supabase/migrations/20261113000003_weekly_payroll_context.sql','supabase/drafts/guard_legacy_bale_payment.sql','supabase/drafts/weekly_payment_date.sql','supabase/drafts/weekly_worker_generator.sql','supabase/drafts/weekly_worker_approval.sql','supabase/drafts/weekly_worker_paid_allocation.sql','supabase/drafts/weekly_worker_draft_details.sql','supabase/drafts/project_paid_payroll_evidence.sql','supabase/drafts/paid_payroll_adjustments.sql','supabase/migrations/20261013000000_advance_requests.sql','supabase/migrations/20261013000001_advance_request_notifications.sql','supabase/migrations/20261113000004_bale_request_site_guard.sql','supabase/drafts/weekly_bale_schedule.sql'];
  for(const path of paths)await admin.query(readFileSync(path,'utf8'));
  // Rehearse coexistence of the Supervisor, historical-worker and original-period
  // assertion candidates with the weekly Bale/payroll chain in this fixture.
  for(const name of ['supervisor_table_foundation','supervisor_rpc_rollout','supervisor_payroll_preview','historical_external_worker_payroll','supervisor_payroll_ledger','paid_period_assertion_adjustments','confirmed_rental_expense_link','project_cost_reconciliation_preview','historical_worker_project_attribution'])await admin.query(`BEGIN; ${readFileSync(`supabase/drafts/${name}.sql`,'utf8')} COMMIT;`);
  await admin.query(`INSERT INTO public.workers(id,name,position,contact_number,pay_rate,pay_rate_type,active) VALUES ('${supervisor}','Supervisor','Supervisor','none',600,'daily',true),('${id(105)}','Worker Five','Mason','none',600,'daily',true),('${id(106)}','Worker Six','Mason','none',600,'daily',true),('${id(107)}','Worker Seven','Mason','none',600,'daily',true),('${id(108)}','Worker Eight','Mason','none',600,'daily',true),('${id(109)}','Worker Nine','Mason','none',600,'daily',true);
   INSERT INTO public.project_worker_assignments VALUES ('${site}','${id(107)}',true),('${site}','${id(108)}',true);
   INSERT INTO public.attendance(id,worker_id,project_id,date,status,hours_worked,submitted_at) VALUES ('${id(206)}','${id(105)}','${site}','2024-11-03','present',8,'2024-11-03T08:00:00Z'),('${id(207)}','${id(106)}','${site}','2024-11-10','present',8,'2024-11-10T08:00:00Z'),('${id(209)}','${id(109)}','${site}','2024-09-15','present',8,'2024-09-15T08:00:00Z');
   INSERT INTO public.supervisor_daily_attendance(id,supervisor_id,work_date,work_status,status,submitted_at,reviewed_by,reviewed_at) VALUES ('${id(208)}','${supervisor}','2024-11-01','present','approved',now(),'${founder}',now())`);
  // Test-only clock; actual candidate uses the database clock, not caller input.
  await admin.query("CREATE OR REPLACE FUNCTION public.weekly_bale_clock() RETURNS timestamptz LANGUAGE sql VOLATILE SET search_path='' AS $$SELECT current_setting('test.clock')::timestamptz$$");
  await Promise.all([first.query(`SET ROLE authenticated; SET test.uid='${founder}'; SET test.assurance='yes'; SET lock_timeout='4s'`),second.query(`SET ROLE authenticated; SET test.uid='${supervisor}'; SET test.assurance='yes'; SET lock_timeout='4s'`)]);
  await first.query("SELECT public.confirm_rental_expense($1,$2,$3,1000,'2024-12-15','Excavator','Excavator','Supplier',1,'2024-12-15','2024-12-21')",[id(603),id(601),site]);
 },30000);
 afterAll(async()=>{await Promise.all([admin?.end(),first?.end(),second?.end()]);});
 it('waits for a release that wins and refuses to approve the now-stale payroll draft',async()=>{
  const worker=id(101),payroll=id(301),req=await request(worker,'2024-12-01','2024-12-03','2024-12-04');await generate(first,payroll,worker,'2024-12-01');
  await second.query('BEGIN');await first.query('BEGIN');try{
   const issued=(await release(second,req)).rows[0].result;let done=false;const attempt=approve(first,payroll).then(()=>({code:'success'}),(e:{code:string})=>({code:e.code})).finally(()=>{done=true});
   await pause();expect(done).toBe(false);await second.query('COMMIT');expect((await attempt).code).toBe('40001');await first.query('ROLLBACK');
   expect((await admin.query('SELECT status,bale_deduction::text FROM public.payroll WHERE id=$1',[payroll])).rows).toEqual([{status:'draft',bale_deduction:'0.00'}]);
   expect((await admin.query('SELECT status,amount_deducted::text FROM public.advances WHERE id=$1',[issued.advance_id])).rows).toEqual([{status:'active',amount_deducted:'0.00'}]);
   expect((await admin.query<{n:number}>('SELECT count(*)::int n FROM public.weekly_worker_paid_allocations WHERE payroll_id=$1',[payroll])).rows[0].n).toBe(0);
  }finally{await first.query('ROLLBACK');await second.query('ROLLBACK');}
 },15000);
 it('waits for approval that wins and refuses a late Bale release into that original period',async()=>{
  const worker=id(102),payroll=id(302),req=await request(worker,'2024-12-08','2024-12-10','2024-12-11');await generate(first,payroll,worker,'2024-12-08');
  await first.query('BEGIN');await second.query('BEGIN');try{
   await approve(first,payroll);let done=false;const attempt=release(second,req).then(()=>({code:'success'}),(e:{code:string})=>({code:e.code})).finally(()=>{done=true});
   await pause();expect(done).toBe(false);await first.query('COMMIT');expect((await attempt).code).toBe('22023');await second.query('ROLLBACK');
   expect((await admin.query('SELECT status FROM public.advance_requests WHERE id=$1',[req])).rows).toEqual([{status:'approved_pending_payment'}]);expect((await admin.query('SELECT status FROM public.payroll WHERE id=$1',[payroll])).rows).toEqual([{status:'approved'}]);
   expect((await admin.query<{n:number}>('SELECT count(*)::int n FROM public.advances WHERE worker_id=$1',[worker])).rows[0].n).toBe(0);
  }finally{await first.query('ROLLBACK');await second.query('ROLLBACK');}
 },15000);
 it('records one release, its full same-week deduction and one project gross allocation through real candidates',async()=>{
  const worker=id(103),payroll=id(303),req=await request(worker,'2024-12-15','2024-12-17','2024-12-18');const issued=(await release(second,req)).rows[0].result;expect((await release(second,req)).rows[0].result).toMatchObject({outcome:'already_recorded',advance_id:issued.advance_id});
  const calculation=(await generate(first,payroll,worker,'2024-12-15')).rows[0].result.calculation;expect(calculation).toMatchObject({gross:'600.00',bale:'100.25',net:'499.75'});await approve(first,payroll);
  const result=(await first.query("SELECT public.record_weekly_worker_payment($1,'2024-12-21') result",[payroll])).rows[0].result;expect(result.outcome).toBe('updated');
  expect((await first.query("SELECT public.record_weekly_worker_payment($1,'2024-12-21') result",[payroll])).rows[0].result.outcome).toBe('already_recorded');
  expect((await admin.query('SELECT status,amount_deducted::text FROM public.advances WHERE id=$1',[issued.advance_id])).rows).toEqual([{status:'fully_deducted',amount_deducted:'100.25'}]);
  expect((await admin.query('SELECT project_id,gross::text FROM public.weekly_worker_paid_allocations WHERE payroll_id=$1',[payroll])).rows).toEqual([{project_id:site,gross:'600.00'}]);
  expect((await admin.query<{n:number}>('SELECT count(*)::int n FROM public.payroll_payment_dates WHERE payroll_id=$1',[payroll])).rows[0].n).toBe(1);
  const cost=parseCostSnapshot((await first.query('SELECT public.project_cost_reconciliation_preview($1) v',[site])).rows[0].v,site);expect(cost.paid).toHaveLength(1);expect(cost.expenses.find(e=>e.id===id(601))?.rental?.item).toBe('Excavator');const choices=Object.fromEntries(cost.expenses.map(e=>[e.id,e.id===id(602)?'exclude' as const:'include' as const]));expect(estimateProjectCost(cost,choices)).toEqual({expenses:101235n,excluded:10025n,payroll:60000n,total:161235n});
  const before=(await admin.query('SELECT to_jsonb(p) v FROM public.payroll p WHERE id=$1',[payroll])).rows[0].v;
  const snapshot=(await admin.query('SELECT app_private.paid_adjustment_voucher_snapshot(p) v FROM public.payroll p WHERE id=$1',[payroll])).rows[0].v;
  expect((await first.query("SELECT public.open_paid_payroll_adjustment($1,$2,$3,25.50,'Review missed time') v",[id(401),payroll,snapshot])).rows[0].v.status).toBe('pending');
  expect((await first.query("SELECT public.resolve_paid_payroll_adjustment($1,'settled_external','2024-12-23','External settlement reviewed') v",[id(401)])).rows[0].v.status).toBe('settled_external');
  expect((await admin.query('SELECT to_jsonb(p) v FROM public.payroll p WHERE id=$1',[payroll])).rows[0].v).toEqual(before);
  expect((await admin.query('SELECT status,amount_deducted::text FROM public.advances WHERE id=$1',[issued.advance_id])).rows).toEqual([{status:'fully_deducted',amount_deducted:'100.25'}]);
  expect((await admin.query('SELECT project_id,gross::text FROM public.weekly_worker_paid_allocations WHERE payroll_id=$1',[payroll])).rows).toEqual([{project_id:site,gross:'600.00'}]);
  const next=(await generate(first,id(304),worker,'2024-12-22')).rows[0].result.calculation;expect(next).toMatchObject({gross:'600.00',bale:'0.00',net:'600.00'});
 },15000);
 it('rolls back payment, deduction, allocation and date together when audit recording fails, then retries once',async()=>{
  const worker=id(104),payroll=id(305),req=await request(worker,'2024-12-29','2024-12-31','2025-01-01');const issued=(await release(second,req)).rows[0].result;await generate(first,payroll,worker,'2024-12-29');await approve(first,payroll);
  await admin.query(`ALTER TABLE public.audit_log ADD CONSTRAINT reject_test_payment CHECK(NOT (record_id='${payroll}' AND action='update' AND after_row->>'status'='paid')) NOT VALID`);
  try{
   await expect(first.query("SELECT public.record_weekly_worker_payment($1,'2025-01-04')",[payroll])).rejects.toThrow(/reject_test_payment/);
   expect((await admin.query('SELECT status FROM public.payroll WHERE id=$1',[payroll])).rows).toEqual([{status:'approved'}]);
   expect((await admin.query('SELECT status,amount_deducted::text FROM public.advances WHERE id=$1',[issued.advance_id])).rows).toEqual([{status:'active',amount_deducted:'0.00'}]);
   expect((await admin.query<{n:number}>('SELECT count(*)::int n FROM public.weekly_worker_paid_allocations WHERE payroll_id=$1',[payroll])).rows[0].n).toBe(0);
   expect((await admin.query<{n:number}>('SELECT count(*)::int n FROM public.payroll_payment_dates WHERE payroll_id=$1',[payroll])).rows[0].n).toBe(0);
  }finally{await admin.query('ALTER TABLE public.audit_log DROP CONSTRAINT reject_test_payment');}
  expect((await first.query("SELECT public.record_weekly_worker_payment($1,'2025-01-04') v",[payroll])).rows[0].v.outcome).toBe('updated');
  expect((await first.query("SELECT public.record_weekly_worker_payment($1,'2025-01-04') v",[payroll])).rows[0].v.outcome).toBe('already_recorded');
  expect((await admin.query('SELECT status,amount_deducted::text FROM public.advances WHERE id=$1',[issued.advance_id])).rows).toEqual([{status:'fully_deducted',amount_deducted:'100.25'}]);
  expect((await admin.query<{n:number}>('SELECT count(*)::int n FROM public.weekly_worker_paid_allocations WHERE payroll_id=$1',[payroll])).rows[0].n).toBe(1);
 },15000);
 it('serializes a historical external claim before a competing weekly draft',async()=>{
  const worker=id(105),start='2024-11-03',claim=id(501),payroll=id(502);await first.query(`SET test.uid='${founder}'`);await second.query(`SET test.uid='${founder}'`);
  const reviewed=(await first.query('SELECT public.historical_external_worker_review($1,$2) v',[worker,start])).rows[0].v.worker;
  await first.query('BEGIN');await second.query('BEGIN');try{
   await first.query('SELECT public.record_historical_external_worker_payroll($1,$2,$3,$3::date+6,600,100,0,500,$4,$5,true)',[claim,worker,start,'Original ledger',JSON.stringify(reviewed)]);
   let done=false;const attempted=generate(second,payroll,worker,start).then(()=>({code:'success'}),(e:{code:string})=>({code:e.code})).finally(()=>{done=true});await pause();expect(done).toBe(false);await first.query('COMMIT');expect((await attempted).code).toBe('22023');await second.query('ROLLBACK');
   expect((await admin.query('SELECT count(*)::int n FROM public.payroll WHERE id=$1',[payroll])).rows[0].n).toBe(0);expect((await admin.query('SELECT count(*)::int n FROM public.advances WHERE worker_id=$1',[worker])).rows[0].n).toBe(0);
   const snap=(await first.query("SELECT public.paid_period_assertion_case_list('external_worker',$1) v",[claim])).rows[0].v.snapshot;await first.query("SELECT public.open_paid_period_assertion_case($1,'external_worker',$2,$3,30,'Review')",[id(503),claim,JSON.stringify(snap)]);await first.query("SELECT public.resolve_paid_period_assertion_case($1,'no_transfer',NULL,'Reviewed',true)",[id(503)]);
   expect((await admin.query('SELECT count(*)::int n FROM public.payroll WHERE worker_id=$1',[worker])).rows[0].n).toBe(0);expect((await admin.query('SELECT count(*)::int n FROM public.weekly_worker_paid_allocations a JOIN public.payroll p ON p.id=a.payroll_id WHERE p.worker_id=$1',[worker])).rows[0].n).toBe(0);
  }finally{await first.query('ROLLBACK');await second.query('ROLLBACK');}
 },15000);
 it('serializes historical attribution retries and competing splits without creating finance transactions',async()=>{
  const source=id(501),original=(await first.query('SELECT public.historical_external_worker_lookup($1) v',[source])).rows[0].v;
  const split=[{project_id:site,gross:'400.25'},{project_id:'00000000-0000-0000-0000-000000000005',gross:'199.75'}];
  const call=(c:Client,request:string,items:unknown)=>c.query("SELECT public.record_historical_worker_attribution($1,$2,$3::jsonb,$4::jsonb,'Synthetic evidence reviewed',true) v",[request,source,JSON.stringify(original),JSON.stringify(items)]);
  await first.query(`SET test.uid='${founder}'`);await second.query(`SET test.uid='${founder}'`);
  await first.query('BEGIN');await second.query('BEGIN');try{
   expect((await call(first,id(700),split)).rows[0].v.replayed).toBe(false);
   let done=false;const retry=call(second,id(700),[...split].reverse()).finally(()=>{done=true});await pause();expect(done).toBe(false);
   await first.query('COMMIT');expect((await retry).rows[0].v.replayed).toBe(true);await second.query('COMMIT');
   await expect(call(first,id(701),split)).rejects.toMatchObject({code:'23505'});
   // A distinct assertion exercises genuinely concurrent different request IDs.
   const secondWorker=id(950),secondSource=id(702);
   await admin.query("INSERT INTO public.workers(id,name,position,contact_number,pay_rate,pay_rate_type,active) VALUES($1,'Additional worker','Mason','none',600,'daily',true)",[secondWorker]);
   const reviewed=(await first.query("SELECT public.historical_external_worker_review($1,'2024-10-20') v",[secondWorker])).rows[0].v.worker;
   await first.query("SELECT public.record_historical_external_worker_payroll($1,$2,'2024-10-20','2024-10-26',600,0,0,600,'Synthetic evidence',$3,true)",[secondSource,secondWorker,JSON.stringify(reviewed)]);
   const secondOriginal=(await first.query('SELECT public.historical_external_worker_lookup($1) v',[secondSource])).rows[0].v;
   const competing=(c:Client,request:string,items:unknown)=>c.query("SELECT public.record_historical_worker_attribution($1,$2,$3::jsonb,$4::jsonb,'Synthetic evidence reviewed',true) v",[request,secondSource,JSON.stringify(secondOriginal),JSON.stringify(items)]);
   await first.query('BEGIN');await second.query('BEGIN');await competing(first,id(703),split);
   let finished=false;const conflict=competing(second,id(704),[{project_id:site,gross:'600.00'}]).then(()=>({code:'success'}),(error:{code:string})=>({code:error.code})).finally(()=>{finished=true});
   await pause();expect(finished).toBe(false);await first.query('COMMIT');expect((await conflict).code).toBe('23505');await second.query('ROLLBACK');
   expect((await admin.query('SELECT count(*)::int n FROM public.historical_worker_attributions WHERE source_id=$1',[secondSource])).rows[0].n).toBe(1);
   expect((await admin.query('SELECT count(*)::int n FROM public.historical_worker_attributions WHERE source_id=$1',[source])).rows[0].n).toBe(1);
   expect((await admin.query('SELECT sum(gross)::text total,count(*)::int n FROM public.historical_worker_attribution_sites WHERE attribution_id=$1',[id(700)])).rows[0]).toEqual({total:'600.00',n:2});
   expect((await admin.query('SELECT count(*)::int n FROM public.payroll WHERE worker_id=$1 AND period_start=$2',[id(105),'2024-11-03'])).rows[0].n).toBe(0);
   expect((await first.query('SELECT public.project_historical_worker_attributions($1) v',[site])).rows[0].v.items).toEqual(expect.arrayContaining([expect.objectContaining({source_id:source,site_gross:'400.25',case_count:1})]));
  }finally{await first.query('ROLLBACK');await second.query('ROLLBACK');}
 },15000);
 it('serializes a weekly draft before a competing historical external claim',async()=>{
  const worker=id(106),start='2024-11-10',claim=id(504),payroll=id(505);const reviewed=(await first.query('SELECT public.historical_external_worker_review($1,$2) v',[worker,start])).rows[0].v.worker;
  await first.query('BEGIN');await second.query('BEGIN');try{
   await generate(first,payroll,worker,start);let done=false;const attempted=second.query('SELECT public.record_historical_external_worker_payroll($1,$2,$3,$3::date+6,600,0,0,600,$4,$5,true)',[claim,worker,start,'Original ledger',JSON.stringify(reviewed)]).then(()=>({code:'success'}),(e:{code:string})=>({code:e.code})).finally(()=>{done=true});await pause();expect(done).toBe(false);await first.query('COMMIT');expect((await attempted).code).toBe('22023');await second.query('ROLLBACK');
   expect((await admin.query('SELECT count(*)::int n FROM public.historical_external_worker_payroll WHERE request_id=$1',[claim])).rows[0].n).toBe(0);expect((await admin.query('SELECT status FROM public.payroll WHERE id=$1',[payroll])).rows[0].status).toBe('draft');
  }finally{await first.query('ROLLBACK');await second.query('ROLLBACK');}
 },15000);
 it('keeps Supervisor company evidence and worker site allocation separate in the same period',async()=>{
  const supervisorPayroll=id(506),workerPayroll=id(505);const prepared=(await first.query("SELECT public.supervisor_period_prepare($1,'2024-11-01') v",[supervisor])).rows[0].v;
  await first.query("SELECT public.create_supervisor_period_draft($1,$2,'2024-11-01',600,$3)",[supervisorPayroll,supervisor,JSON.stringify(prepared)]);
  await first.query("SELECT public.transition_supervisor_period_payroll($1,$2,'approved',NULL,true)",[id(507),supervisorPayroll]);await first.query("SELECT public.transition_supervisor_period_payroll($1,$2,'recorded_paid','2024-11-15',true)",[id(508),supervisorPayroll]);
  await approve(first,workerPayroll);await first.query("SELECT public.record_weekly_worker_payment($1,'2024-11-16')",[workerPayroll]);
  const snapshot=(await first.query("SELECT public.paid_period_assertion_case_list('supervisor',$1) v",[supervisorPayroll])).rows[0].v.snapshot;await first.query("SELECT public.open_paid_period_assertion_case($1,'supervisor',$2,$3,-25,'Review')",[id(509),supervisorPayroll,JSON.stringify(snapshot)]);await first.query("SELECT public.resolve_paid_period_assertion_case($1,'no_transfer',NULL,'Reviewed',true)",[id(509)]);
  const evidence=(await first.query("SELECT public.supervisor_paid_company_evidence('2024-11-01','2024-11-30') v")).rows[0].v;expect(evidence).toMatchObject({count:1,total:'600.00'});
  expect((await admin.query('SELECT project_id,gross::text FROM public.weekly_worker_paid_allocations WHERE payroll_id=$1',[workerPayroll])).rows).toEqual([{project_id:site,gross:'600.00'}]);
  expect((await admin.query('SELECT count(*)::int n FROM public.weekly_worker_paid_allocations WHERE payroll_id=$1',[supervisorPayroll])).rows[0].n).toBe(0);
  expect((await admin.query('SELECT gross::text,status FROM public.supervisor_period_payroll WHERE id=$1',[supervisorPayroll])).rows).toEqual([{gross:'600.00',status:'paid'}]);
 },15000);

 it('does not record a Bale release after the Supervisor role is revoked while waiting',async()=>{
  const worker=id(107),req=await request(worker,'2024-10-20','2024-10-22','2024-10-23');await admin.query('BEGIN');try{
   await admin.query("UPDATE public.users SET role='worker' WHERE id=$1",[supervisor]);let done=false;const pending=release(second,req).then(()=>({code:'success'}),(e:{code:string})=>({code:e.code})).finally(()=>{done=true});await pause();expect(done).toBe(false);await admin.query('COMMIT');expect((await pending).code).toBe('42501');
   expect((await admin.query('SELECT status,issued_advance_id FROM public.advance_requests WHERE id=$1',[req])).rows).toEqual([{status:'approved_pending_payment',issued_advance_id:null}]);expect((await admin.query('SELECT count(*)::int n FROM public.advances WHERE worker_id=$1',[worker])).rows[0].n).toBe(0);
  }finally{await admin.query('ROLLBACK');await admin.query("UPDATE public.users SET role='supervisor' WHERE id=$1",[supervisor]);}
  expect((await release(second,req)).rows[0].result.outcome).toBe('updated');
 },15000);

 it('does not record a Bale release after the Founder role is revoked while waiting',async()=>{
  const worker=id(108),req=await request(worker,'2024-10-13','2024-10-15','2024-10-16');await first.query("SELECT set_config('test.clock','2024-10-16T04:00:00Z',false)");await admin.query('BEGIN');try{
   await admin.query("UPDATE public.users SET role='worker' WHERE id=$1",[founder]);let done=false;const pending=release(first,req).then(()=>({code:'success'}),(e:{code:string})=>({code:e.code})).finally(()=>{done=true});await pause();expect(done).toBe(false);await admin.query('COMMIT');expect((await pending).code).toBe('42501');
   expect((await admin.query('SELECT status,issued_advance_id FROM public.advance_requests WHERE id=$1',[req])).rows).toEqual([{status:'approved_pending_payment',issued_advance_id:null}]);expect((await admin.query('SELECT count(*)::int n FROM public.advances WHERE worker_id=$1',[worker])).rows[0].n).toBe(0);
  }finally{await admin.query('ROLLBACK');await admin.query("UPDATE public.users SET role='founder' WHERE id=$1",[founder]);}
  expect((await release(first,req)).rows[0].result.outcome).toBe('updated');
  await first.query('BEGIN');try{expect((await release(first,req)).rows[0].result.outcome).toBe('already_recorded');let changed=false;const revoke=admin.query("UPDATE public.users SET role='worker' WHERE id=$1",[founder]).finally(()=>{changed=true;});await pause();expect(changed).toBe(false);await first.query('COMMIT');await revoke;}finally{await first.query('ROLLBACK');await admin.query("UPDATE public.users SET role='founder' WHERE id=$1",[founder]);}
 },15000);

 it('blocks unwrapped weekly approval and payment after a concurrent Founder revocation',async()=>{
  const payroll=id(510);await generate(first,payroll,id(109),'2024-09-15');
  for(const [operation,status] of [[()=>approve(first,payroll),'draft'],[()=>first.query("SELECT public.record_weekly_worker_payment($1,'2024-09-21')",[payroll]),'approved']] as const){
   if(status==='approved')await approve(first,payroll);await admin.query('BEGIN');try{
    await admin.query("UPDATE public.users SET role='worker' WHERE id=$1",[founder]);let done=false;const pending=operation().then(()=>({code:'success'}),(e:{code:string})=>({code:e.code})).finally(()=>{done=true});await pause();expect(done).toBe(false);await admin.query('COMMIT');expect((await pending).code).toBe('42501');
    expect((await admin.query('SELECT status FROM public.payroll WHERE id=$1',[payroll])).rows[0].status).toBe(status);expect((await admin.query('SELECT count(*)::int n FROM public.weekly_worker_paid_allocations WHERE payroll_id=$1',[payroll])).rows[0].n).toBe(0);expect((await admin.query('SELECT count(*)::int n FROM public.payroll_payment_dates WHERE payroll_id=$1',[payroll])).rows[0].n).toBe(0);
   }finally{await admin.query('ROLLBACK');await admin.query("UPDATE public.users SET role='founder' WHERE id=$1",[founder]);}
  }
  expect((await first.query("SELECT public.record_weekly_worker_payment($1,'2024-09-21') v",[payroll])).rows[0].v.outcome).toBe('updated');
 },15000);

 it('integrates revision-aware refresh and return with Bale, overtime, allowances, payment and correction evidence',async()=>{
  // Added only after the unwrapped scenarios above: these candidates revoke the
  // old approval/payment signatures and are not independently deployable.
  for(const name of ['weekly_worker_draft_refresh','weekly_worker_return_to_draft'])await admin.query(`BEGIN; ${readFileSync(`supabase/drafts/${name}.sql`,'utf8')} COMMIT;`);
  const permissions=(await admin.query("SELECT to_regprocedure('public.approve_weekly_worker_draft(uuid)') IS NULL old_approval_absent,to_regprocedure('public.record_weekly_worker_payment(uuid,date)') IS NULL old_payment_absent,has_function_privilege('authenticated','public.weekly_worker_approval_internal(uuid)','EXECUTE') internal_approval,has_function_privilege('authenticated','public.weekly_worker_payment_internal(uuid,date)','EXECUTE') internal_payment")).rows[0];
  expect(permissions).toEqual({old_approval_absent:true,old_payment_absent:true,internal_approval:false,internal_payment:false});
  const worker=id(110),attendance=id(210),payroll=id(310),week='2024-08-04';
  await admin.query("INSERT INTO public.workers(id,name,position,contact_number,pay_rate,pay_rate_type,active) VALUES ($1,'Integrated Worker','Mason','none',600,'daily',true)",[worker]);
  await admin.query('INSERT INTO public.project_worker_assignments VALUES ($1,$2,true)',[site,worker]);
  await admin.query("INSERT INTO public.attendance(id,worker_id,project_id,date,status,hours_worked,submitted_at) VALUES ($1,$2,$3,'2024-08-04','present',8,'2024-08-04T08:00:00Z')",[attendance,worker,site]);
  await first.query(`SET test.uid='${founder}'`);
  await first.query("SELECT public.record_attendance_time_detail($1,$2,'2024-08-04T08:00:00Z',8,2,'Approved time')",[id(611),attendance]);
  expect((await first.query("SELECT public.submit_worker_allowance($1,$2,'2024-08-04T08:00:00Z',50.25,'Meals') v",[id(612),attendance])).rows[0].v.status).toBe('approved');
  const req=await request(worker,week,'2024-08-06','2024-08-07');
  expect((await generate(first,payroll,worker,week)).rows[0].result.calculation).toMatchObject({gross:'800.25',bale:'0.00',net:'800.25'});
  const issued=(await release(second,req)).rows[0].result;
  await expect(first.query('SELECT public.approve_weekly_worker_draft($1,0)',[payroll])).rejects.toThrow(/changed|stale/i);
  const refreshed=(await first.query('SELECT public.refresh_weekly_worker_draft($1,$2,0) v',[id(613),payroll])).rows[0].v;
  expect(refreshed).toMatchObject({replayed:false,revision:1,calculation:{gross:'800.25',bale:'100.25',net:'700.00'}});
  expect((await first.query('SELECT public.refresh_weekly_worker_draft($1,$2,0) v',[id(613),payroll])).rows[0].v.replayed).toBe(true);
  await expect(first.query('SELECT public.approve_weekly_worker_draft($1,0)',[payroll])).rejects.toThrow(/revision changed/);
  await first.query('SELECT public.approve_weekly_worker_draft($1,1)',[payroll]);
  expect((await first.query("SELECT public.return_weekly_worker_to_draft($1,$2,1,'Review') v",[id(614),payroll])).rows[0].v).toMatchObject({revision:2,replayed:false});
  await expect(first.query("SELECT public.record_weekly_worker_payment($1,'2024-08-10',1)",[payroll])).rejects.toThrow(/revision changed/);
  await first.query('SELECT public.approve_weekly_worker_draft($1,2)',[payroll]);
  expect((await first.query("SELECT public.record_weekly_worker_payment($1,'2024-08-10',2) v",[payroll])).rows[0].v.outcome).toBe('updated');
  expect((await first.query("SELECT public.record_weekly_worker_payment($1,'2024-08-10',2) v",[payroll])).rows[0].v.outcome).toBe('already_recorded');
  expect((await admin.query('SELECT gross_pay::text,bale_deduction::text,net_pay::text,status FROM public.payroll WHERE id=$1',[payroll])).rows).toEqual([{gross_pay:'800.25',bale_deduction:'100.25',net_pay:'700.00',status:'paid'}]);
  expect((await admin.query('SELECT status,amount_deducted::text FROM public.advances WHERE id=$1',[issued.advance_id])).rows).toEqual([{status:'fully_deducted',amount_deducted:'100.25'}]);
  expect((await admin.query('SELECT gross::text FROM public.weekly_worker_paid_allocations WHERE payroll_id=$1',[payroll])).rows).toEqual([{gross:'800.25'}]);
  // Simulate privileged tampering that bypasses the immutable-allocation guard:
  // a retry must not assert success when hours no longer reconcile, even if
  // every monetary amount is unchanged. This does not prevent owner tampering.
  await admin.query('ALTER TABLE public.weekly_worker_paid_allocations DISABLE TRIGGER guard_weekly_paid_allocation_immutable');
  try{await admin.query('UPDATE public.weekly_worker_paid_allocations SET hours=11 WHERE payroll_id=$1',[payroll]);}
  finally{await admin.query('ALTER TABLE public.weekly_worker_paid_allocations ENABLE TRIGGER guard_weekly_paid_allocation_immutable');}
  await expect(first.query("SELECT public.record_weekly_worker_payment($1,'2024-08-10',2)",[payroll])).rejects.toThrow(/allocation is incomplete/);
  await expect(first.query('SELECT public.project_cost_reconciliation_preview($1)',[site])).rejects.toThrow(/inconsistent/);
  await admin.query('ALTER TABLE public.weekly_worker_paid_allocations DISABLE TRIGGER guard_weekly_paid_allocation_immutable');
  try{await admin.query('UPDATE public.weekly_worker_paid_allocations SET hours=10 WHERE payroll_id=$1',[payroll]);}
  finally{await admin.query('ALTER TABLE public.weekly_worker_paid_allocations ENABLE TRIGGER guard_weekly_paid_allocation_immutable');}
  expect((await first.query("SELECT public.record_weekly_worker_payment($1,'2024-08-10',2) v",[payroll])).rows[0].v.outcome).toBe('already_recorded');
  const details=parseWeeklyDraftDetails((await first.query('SELECT public.weekly_worker_draft_details($1) v',[payroll])).rows[0].v,{id:payroll,worker,start:week},true);
  expect(details).toMatchObject({status:'paid',draft_revision:2,gross:'800.25',bale:'100.25',net:'700.00',payment_date:'2024-08-10',allocations:[{project_id:site,gross:'800.25'}]});
  const snapshot=(await admin.query('SELECT app_private.paid_adjustment_voucher_snapshot(p) v FROM public.payroll p WHERE id=$1',[payroll])).rows[0].v;
  await first.query("SELECT public.open_paid_payroll_adjustment($1,$2,$3,25.50,'Review missed time')",[id(615),payroll,snapshot]);
  await first.query("SELECT public.resolve_paid_payroll_adjustment($1,'settled_external','2024-08-12','External settlement reviewed')",[id(615)]);
  expect((await admin.query('SELECT gross_pay::text,net_pay::text,status FROM public.payroll WHERE id=$1',[payroll])).rows).toEqual([{gross_pay:'800.25',net_pay:'700.00',status:'paid'}]);
  const review=parseCostSnapshot((await first.query('SELECT public.project_cost_reconciliation_preview($1) v',[site])).rows[0].v,site);
  expect(review.paid.find(p=>p.payrollId===payroll)).toMatchObject({gross:'800.25',voucherBale:'100.25',voucherNet:'700.00'});
  await admin.query("INSERT INTO public.attendance(id,worker_id,project_id,date,status,hours_worked,submitted_at) VALUES ($1,$2,$3,'2024-08-11','present',8,'2024-08-11T08:00:00Z')",[id(212),worker,site]);
  const next=(await generate(first,id(312),worker,'2024-08-11')).rows[0].result.calculation;
  expect(next).toMatchObject({gross:'600.00',bale:'0.00',net:'600.00'});
 },30000);

 it('serializes a Wednesday release racing revision-aware approval, then requires a refreshed draft',async()=>{
  const worker=id(112),attendance=id(213),payroll=id(313),week='2024-06-30';
  await admin.query("INSERT INTO public.workers(id,name,position,contact_number,pay_rate,pay_rate_type,active) VALUES ($1,'Concurrent Worker','Mason','none',600,'daily',true)",[worker]);
  await admin.query('INSERT INTO public.project_worker_assignments VALUES ($1,$2,true)',[site,worker]);
  await admin.query("INSERT INTO public.attendance(id,worker_id,project_id,date,status,hours_worked,submitted_at) VALUES ($1,$2,$3,'2024-06-30','present',8,'2024-06-30T08:00:00Z')",[attendance,worker,site]);
  const req=await request(worker,week,'2024-07-02','2024-07-03');await generate(first,payroll,worker,week);
  await second.query('BEGIN');await first.query('BEGIN');try{
   const issued=(await release(second,req)).rows[0].result;let done=false;
   const approval=first.query('SELECT public.approve_weekly_worker_draft($1,0)',[payroll]).then(()=>({code:'success'}),(e:{code:string})=>({code:e.code})).finally(()=>{done=true;});
   await pause();expect(done).toBe(false);await second.query('COMMIT');expect((await approval).code).toBe('40001');await first.query('ROLLBACK');
   expect((await admin.query('SELECT status,bale_deduction::text FROM public.payroll WHERE id=$1',[payroll])).rows).toEqual([{status:'draft',bale_deduction:'0.00'}]);
   expect((await first.query('SELECT public.refresh_weekly_worker_draft($1,$2,0) v',[id(616),payroll])).rows[0].v.calculation).toMatchObject({gross:'600.00',bale:'100.25',net:'499.75'});
   await first.query('SELECT public.approve_weekly_worker_draft($1,1)',[payroll]);
   await first.query("SELECT public.record_weekly_worker_payment($1,'2024-07-06',1)",[payroll]);
   expect((await admin.query('SELECT amount_deducted::text FROM public.advances WHERE id=$1',[issued.advance_id])).rows).toEqual([{amount_deducted:'100.25'}]);
  }finally{await first.query('ROLLBACK');await second.query('ROLLBACK');}
 },15000);

 it('combines the expiry worker with revision-aware payroll without creating or deducting an unreleased Bale',async()=>{
  // The simplified fixture pre-creates the request table, so model the legacy
  // rejection constraint that exists on the actual schema before installing.
  await admin.query("ALTER TABLE public.advance_requests ADD CONSTRAINT advance_request_rejection_fields CHECK (status<>'rejected' OR (rejected_by IS NOT NULL AND rejected_at IS NOT NULL))");
  for(const name of ['weekly_bale_expiration','weekly_bale_release_list','weekly_bale_status_batch','weekly_bale_scheduler'])await admin.query(`BEGIN; ${readFileSync(`supabase/drafts/${name}.sql`,'utf8')} COMMIT;`);
  const worker=id(111),attendance=id(211),payroll=id(311);
  await admin.query("INSERT INTO public.workers(id,name,position,contact_number,pay_rate,pay_rate_type,active) VALUES ($1,'Expiry Worker','Mason','none',600,'daily',true)",[worker]);
  await admin.query('INSERT INTO public.project_worker_assignments VALUES ($1,$2,true)',[site,worker]);
  await admin.query("INSERT INTO public.attendance(id,worker_id,project_id,date,status,hours_worked,submitted_at) VALUES ($1,$2,$3,'2024-07-07','present',8,'2024-07-07T08:00:00Z')",[attendance,worker,site]);
  await second.query(`SET test.uid='${supervisor}'; SET test.clock='2024-07-09T15:59:59Z'`);
  const req=(await second.query('INSERT INTO public.advance_requests(worker_id,project_id,requested_amount,submitted_by) VALUES($1,$2,100.25,$3) RETURNING id',[worker,site,supervisor])).rows[0].id;
  await admin.query("SET test.uid=''; SET test.clock='2024-07-09T15:59:59Z'");
  expect((await admin.query('SELECT public.run_weekly_bale_expiry_job() v')).rows[0].v).toMatchObject({outcome:'completed',processed:0});
  await admin.query("SET test.clock='2024-07-09T16:00:00Z'");
  await first.query(`SET test.uid='${founder}'`);
  await admin.query('BEGIN');try{
   expect((await admin.query('SELECT public.run_weekly_bale_expiry_job() v')).rows[0].v).toMatchObject({outcome:'completed',processed:1});
   let done=false;const pending=generate(first,payroll,worker,'2024-07-07').finally(()=>{done=true;});
   await pause();expect(done).toBe(false);await admin.query('COMMIT');
   expect((await pending).rows[0].result.calculation).toMatchObject({gross:'600.00',bale:'0.00',net:'600.00'});
  }finally{await admin.query('ROLLBACK');}
  expect((await admin.query('SELECT public.run_weekly_bale_expiry_job() v')).rows[0].v).toMatchObject({outcome:'completed',processed:0});
  expect((await admin.query('SELECT status,auto_expired,rejected_by,issued_advance_id FROM public.advance_requests WHERE id=$1',[req])).rows).toEqual([{status:'rejected',auto_expired:true,rejected_by:null,issued_advance_id:null}]);
  expect((await admin.query("SELECT actor_id FROM public.audit_log WHERE record_id=$1 AND action='update'",[req])).rows).toEqual([{actor_id:null}]);
  await first.query('SELECT public.approve_weekly_worker_draft($1,0)',[payroll]);
  expect((await first.query("SELECT public.record_weekly_worker_payment($1,'2024-07-13',0) v",[payroll])).rows[0].v.outcome).toBe('updated');
  expect((await admin.query('SELECT count(*)::int n FROM public.advances WHERE worker_id=$1',[worker])).rows[0].n).toBe(0);
  expect((await admin.query('SELECT gross::text FROM public.weekly_worker_paid_allocations WHERE payroll_id=$1',[payroll])).rows).toEqual([{gross:'600.00'}]);
 },30000);

});
