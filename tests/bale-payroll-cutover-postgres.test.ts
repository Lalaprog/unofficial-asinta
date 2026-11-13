// Opt-in only: synthetic data, fresh local disposable PostgreSQL database.
import {readFileSync} from 'node:fs';
import {Client} from 'pg';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {baseFixture} from './helpers/pr103-fixture';
import {estimateProjectCost,parseCostSnapshot} from '@/lib/projects/projectCostReconciliation';
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
  for(const name of ['supervisor_table_foundation','supervisor_rpc_rollout','supervisor_payroll_preview','historical_external_worker_payroll','supervisor_payroll_ledger','paid_period_assertion_adjustments','confirmed_rental_expense_link','project_cost_reconciliation_preview'])await admin.query(`BEGIN; ${readFileSync(`supabase/drafts/${name}.sql`,'utf8')} COMMIT;`);
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

});
