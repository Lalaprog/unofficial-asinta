// Opt-in only: destructive synthetic fixtures on a NEW local PostgreSQL database.
import {readFileSync} from 'node:fs';
import {Client} from 'pg';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {baseFixture} from './helpers/pr103-fixture';
const url=process.env.WEEKLY_WORKER_CUTOVER_TEST_DATABASE_URL;
const suite=url?describe:describe.skip;
const founder='00000000-0000-0000-0000-000000000001',supervisor='00000000-0000-0000-0000-000000000002',worker='00000000-0000-0000-0000-000000000003',site='00000000-0000-0000-0000-000000000004';
const id=(n:number)=>`90000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const pause=()=>new Promise(resolve=>setTimeout(resolve,150));
const guard=readFileSync('supabase/drafts/weekly_worker_legacy_cutover_guard.sql','utf8');
const legacyInsert="INSERT INTO public.payroll(id,worker_id,period_start,period_end,status,days_worked,hours_worked,gross_pay,bale_deduction,other_deductions,net_pay) VALUES($1,$2,'2024-11-03','2024-11-09','draft',1,8,600,0,0,600)";
let admin:Client,client:Client;
suite('weekly source-bound cutover guard on disposable PostgreSQL',()=>{
 beforeAll(async()=>{
  const parsed=new URL(url!);if(!['localhost','127.0.0.1','[::1]'].includes(parsed.hostname)||!parsed.pathname.slice(1).startsWith('asinta_test_')||parsed.search||parsed.hash)throw Error('Use an empty local disposable asinta_test_* database without URL options');
  admin=new Client({connectionString:url});client=new Client({connectionString:url});await Promise.all([admin.connect(),client.connect()]);
  const existing=(await admin.query(`SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S'))::int objects,(SELECT count(*) FROM pg_namespace WHERE nspname IN ('auth','app_private','storage'))::int schemas`)).rows[0];if(existing.objects||existing.schemas)throw Error('Database must be empty');
  await admin.query(`DO $$BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF; END$$;`);
  const roles='CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; ';if(!baseFixture.startsWith(roles))throw Error('Fixture roles changed');await admin.query(baseFixture.slice(roles.length));
  await admin.query(`ALTER TABLE public.users ADD COLUMN email text;UPDATE public.users SET email='fixture@example.invalid';ALTER TABLE public.payroll ADD COLUMN notes text;ALTER TABLE public.advances ADD COLUMN reason text,ADD COLUMN created_at timestamptz DEFAULT now();ALTER TABLE public.advances ALTER COLUMN id SET DEFAULT gen_random_uuid();
   ALTER TABLE public.advance_requests ADD COLUMN approved_by uuid,ADD COLUMN approved_at timestamptz,ADD COLUMN rejected_by uuid,ADD COLUMN rejected_at timestamptz,ADD COLUMN issued_by uuid,ADD COLUMN updated_at timestamptz DEFAULT now();
   CREATE TABLE public.project_worker_assignments(project_id uuid,worker_id uuid,active boolean,primary key(project_id,worker_id));
   DROP TABLE public.audit_log;CREATE TABLE public.audit_log(actor_id uuid,actor_email text,action text,table_name text,record_id uuid,before_row jsonb,after_row jsonb);
   CREATE POLICY test_founder_payroll_write ON public.payroll FOR ALL TO authenticated USING(public.is_founder()) WITH CHECK(public.is_founder());
   INSERT INTO public.attendance(id,worker_id,project_id,date,status,hours_worked,submitted_at) VALUES('${id(1)}','${worker}','${site}','2024-11-03','present',8,'2024-11-03T08:00:00Z');`);
  const paths=['supabase/migrations/20261102000000_atomic_payroll_payments.sql','supabase/migrations/20261113000000_weekly_worker_preview.sql','supabase/migrations/20261113000001_attendance_time_detail.sql','supabase/migrations/20261113000002_worker_allowances.sql','supabase/migrations/20261113000003_weekly_payroll_context.sql','supabase/drafts/guard_legacy_bale_payment.sql','supabase/drafts/weekly_payment_date.sql','supabase/drafts/weekly_worker_generator.sql','supabase/drafts/weekly_worker_approval.sql','supabase/drafts/weekly_worker_paid_allocation.sql','supabase/drafts/weekly_worker_draft_details.sql','supabase/drafts/weekly_worker_draft_refresh.sql','supabase/drafts/weekly_worker_return_to_draft.sql','supabase/migrations/20261013000000_advance_requests.sql','supabase/migrations/20261013000001_advance_request_notifications.sql','supabase/migrations/20261113000004_bale_request_site_guard.sql','supabase/drafts/weekly_bale_schedule.sql'];
  for(const p of paths)await admin.query(readFileSync(p,'utf8'));
  await admin.query("CREATE OR REPLACE FUNCTION public.weekly_bale_clock() RETURNS timestamptz LANGUAGE sql VOLATILE SET search_path='' AS $$SELECT current_setting('test.clock')::timestamptz$$");
  await client.query(`SET ROLE authenticated;SET test.uid='${founder}';SET test.assurance='yes';SET lock_timeout='4s'`);
 },30000);
 afterAll(async()=>{await Promise.all([admin?.end(),client?.end()]);});
 it('waits for a legacy writer and refuses cutover if its unresolved draft commits',async()=>{
  await client.query('BEGIN');await admin.query('BEGIN');try{
   await client.query(legacyInsert,[id(2),worker]);let done=false;
   const install=admin.query(guard).then(()=>({message:'success'}),(e:Error)=>({message:e.message})).finally(()=>{done=true;});
   await pause();expect(done).toBe(false);await client.query('COMMIT');expect((await install).message).toMatch(/Unresolved legacy unpaid or unrecognized payroll/);await admin.query('ROLLBACK');
   expect((await admin.query('SELECT status FROM public.payroll WHERE id=$1',[id(2)])).rows).toEqual([{status:'draft'}]);
   expect((await admin.query("SELECT to_regprocedure('public.require_weekly_worker_source_on_insert()') IS NULL absent")).rows).toEqual([{absent:true}]);
   // Synthetic cleanup only, before guard installation. Real vouchers require reconciliation.
   await admin.query('DELETE FROM public.payroll WHERE id=$1',[id(2)]);
  }finally{await client.query('ROLLBACK');await admin.query('ROLLBACK');}
 },15000);
 it('blocks a waiting legacy insertion at commit after cutover wins',async()=>{
  await admin.query('BEGIN');await client.query('BEGIN');try{
   await admin.query(guard);let done=false;const insert=client.query(legacyInsert,[id(3),worker]).finally(()=>{done=true;});
   await pause();expect(done).toBe(false);await admin.query('COMMIT');await insert;
   await expect(client.query('COMMIT')).rejects.toThrow(/Legacy payroll insertion blocked/);
   expect((await admin.query('SELECT count(*)::int n FROM public.payroll WHERE id=$1',[id(3)])).rows).toEqual([{n:0}]);
   expect((await admin.query('SELECT status FROM public.payroll WHERE id=$1',[worker])).rows).toEqual([{status:'paid'}]);
  }finally{await client.query('ROLLBACK');await admin.query('ROLLBACK');}
 },15000);
 it('allows and commits the protected weekly flow and rejects legacy access to source evidence',async()=>{
  await client.query('BEGIN');try{
   expect((await client.query("SELECT public.create_weekly_worker_draft($1,$2,'2024-11-03') v",[id(4),worker])).rows[0].v.calculation).toMatchObject({gross:'600.00',bale:'0.00',net:'600.00'});
   await client.query('COMMIT');
   await client.query('SELECT public.approve_weekly_worker_draft($1,0)',[id(4)]);
   expect((await client.query("SELECT public.record_weekly_worker_payment($1,'2024-11-09',0) v",[id(4)])).rows[0].v.outcome).toBe('updated');
   expect((await admin.query('SELECT status,gross_pay::text,net_pay::text FROM public.payroll WHERE id=$1',[id(4)])).rows).toEqual([{status:'paid',gross_pay:'600.00',net_pay:'600.00'}]);
   expect((await admin.query('SELECT gross::text FROM public.weekly_worker_paid_allocations WHERE payroll_id=$1',[id(4)])).rows).toEqual([{gross:'600.00'}]);
   expect((await admin.query("SELECT has_table_privilege('authenticated','public.weekly_worker_draft_sources','INSERT') client_write,has_table_privilege('service_role','public.weekly_worker_draft_sources','INSERT') service_write")).rows).toEqual([{client_write:false,service_write:false}]);
   await expect(admin.query("UPDATE public.payroll SET status='draft' WHERE id=$1",[worker])).rejects.toThrow(/Legacy paid payroll status is preserved/);
  }finally{await client.query('ROLLBACK');}
 },15000);
 it('waits for an in-flight legacy Bale and refuses installation rather than missing it',async()=>{
  await client.query('RESET ROLE');await admin.query('BEGIN');await client.query('BEGIN');try{
   await admin.query("INSERT INTO public.advances(id,worker_id,project_id,date,amount,amount_deducted,status,reason) VALUES($1,$2,$3,'2024-11-13',100,0,'active','Legacy')",[id(9),worker,site]);
   let done=false;const install=client.query(readFileSync('supabase/drafts/weekly_bale_legacy_cutover_guard.sql','utf8')).then(()=>({message:'success'}),(e:Error)=>({message:e.message})).finally(()=>{done=true;});
   await pause();expect(done).toBe(false);await admin.query('COMMIT');expect((await install).message).toMatch(/Unresolved legacy open requests or outstanding Bale/);await client.query('ROLLBACK');
   expect((await admin.query('SELECT status FROM public.advances WHERE id=$1',[id(9)])).rows).toEqual([{status:'active'}]);
   // Synthetic cleanup only; real outstanding Bale needs human reconciliation.
   await admin.query('DELETE FROM public.advances WHERE id=$1',[id(9)]);
  }finally{await admin.query('ROLLBACK');await client.query('ROLLBACK');await client.query(`SET ROLE authenticated; SET test.uid='${founder}'`);}
 },15000);
 it('blocks manual Bale creation and partial deduction while allowing one controlled release and full weekly deduction',async()=>{
  await admin.query(`BEGIN; ${readFileSync('supabase/drafts/weekly_bale_legacy_cutover_guard.sql','utf8')} COMMIT;`);
  await expect(admin.query("INSERT INTO public.advances(id,worker_id,project_id,date,amount,amount_deducted,status,reason) VALUES($1,$2,$3,'2024-11-13',100.25,0,'active','Old manual writer')",[id(5),worker,site])).rejects.toThrow(/Legacy Bale insertion blocked/);
  expect((await admin.query('SELECT count(*)::int n FROM public.advances WHERE id=$1',[id(5)])).rows).toEqual([{n:0}]);
  const other=id(6);await admin.query("INSERT INTO public.workers(id,name,position,contact_number,pay_rate,pay_rate_type,active) VALUES($1,'Worker Two','Mason','none',600,'daily',true)",[other]);
  await admin.query('INSERT INTO public.project_worker_assignments VALUES($1,$2,true)',[site,other]);await admin.query("INSERT INTO public.attendance(id,worker_id,project_id,date,status,hours_worked,submitted_at) VALUES($1,$2,$3,'2024-11-10','present',8,'2024-11-10T08:00:00Z')",[id(7),other,site]);
  await client.query(`SET test.uid='${supervisor}';SET test.clock='2024-11-10T04:00:00Z'`);const req=(await client.query('INSERT INTO public.advance_requests(worker_id,project_id,requested_amount,submitted_by) VALUES($1,$2,100.25,$3) RETURNING id',[other,site,supervisor])).rows[0].id;
  await client.query(`SET test.uid='${founder}';SET test.clock='2024-11-12T04:00:00Z'`);await client.query("SELECT public.review_advance_request($1,'approve')",[req]);
  await client.query(`SET test.uid='${supervisor}';SET test.clock='2024-11-13T04:00:00Z'`);const advance=(await client.query('SELECT public.record_weekly_bale_release($1) v',[req])).rows[0].v.advance_id;
  await client.query(`SET test.uid='${founder}'`);await expect(client.query('SELECT public.record_advance_deduction_atomic($1,10)',[advance])).rejects.toThrow(/Weekly Bale is immutable/);
  expect((await admin.query('SELECT status,amount_deducted::text FROM public.advances WHERE id=$1',[advance])).rows).toEqual([{status:'active',amount_deducted:'0.00'}]);
  expect((await client.query("SELECT public.create_weekly_worker_draft($1,$2,'2024-11-10') v",[id(8),other])).rows[0].v.calculation).toMatchObject({gross:'600.00',bale:'100.25',net:'499.75'});
  await client.query('SELECT public.approve_weekly_worker_draft($1,0)',[id(8)]);await client.query("SELECT public.record_weekly_worker_payment($1,'2024-11-16',0)",[id(8)]);
  expect((await admin.query('SELECT status,amount_deducted::text FROM public.advances WHERE id=$1',[advance])).rows).toEqual([{status:'fully_deducted',amount_deducted:'100.25'}]);
  expect((await admin.query('SELECT gross::text FROM public.weekly_worker_paid_allocations WHERE payroll_id=$1',[id(8)])).rows).toEqual([{gross:'600.00'}]);
 },15000);
});
