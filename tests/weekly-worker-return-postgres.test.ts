// Opt-in only: creates synthetic schema in an EMPTY local disposable database.
import {readFileSync} from 'node:fs';
import {Client} from 'pg';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {baseFixture} from './helpers/pr103-fixture';
const url=process.env.WEEKLY_RETURN_TEST_DATABASE_URL;
const suite=url?describe:describe.skip;
const founder='00000000-0000-0000-0000-000000000001',worker='00000000-0000-0000-0000-000000000003',site='00000000-0000-0000-0000-000000000004',other='00000000-0000-0000-0000-000000000005';
const id=(n:number)=>`30000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
const pause=()=>new Promise(resolve=>setTimeout(resolve,150));
let admin:Client,first:Client,second:Client;
const draft=(c:Client,key:string,start:string)=>c.query('SELECT public.create_weekly_worker_draft($1,$2,$3)',[key,worker,start]);
const approve=(c:Client,key:string,revision:number)=>c.query('SELECT public.approve_weekly_worker_draft($1,$2) result',[key,revision]);
const pay=(c:Client,key:string,date:string,revision:number)=>c.query('SELECT public.record_weekly_worker_payment($1,$2,$3) result',[key,date,revision]);
const back=(c:Client,key:string,req:string,revision:number)=>c.query("SELECT public.return_weekly_worker_to_draft($1,$2,$3,'review changed attendance') result",[req,key,revision]);
suite('approved voucher return and payment concurrency',()=>{
 beforeAll(async()=>{
  const parsed=new URL(url!);if(!['localhost','127.0.0.1','[::1]'].includes(parsed.hostname)||!parsed.pathname.slice(1).startsWith('asinta_test_')||parsed.search||parsed.hash)throw new Error('Use an empty local disposable database named asinta_test_* without URL options.');
  admin=new Client({connectionString:url});first=new Client({connectionString:url});second=new Client({connectionString:url});await Promise.all([admin.connect(),first.connect(),second.connect()]);
  const existing=(await admin.query(`SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S'))::int objects, (SELECT count(*) FROM pg_namespace WHERE nspname IN ('auth','app_private','storage'))::int schemas`)).rows[0];if(existing.objects||existing.schemas)throw new Error('Use an empty disposable database.');
  await admin.query(`DO $$BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF; END$$;`);
  const roles='CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; ';if(!baseFixture.startsWith(roles))throw new Error('Fixture role bootstrap changed');await admin.query(baseFixture.slice(roles.length));
  await admin.query(`ALTER TABLE public.users ADD COLUMN email text; UPDATE public.users SET email='founder@example.invalid'; ALTER TABLE public.payroll ADD COLUMN notes text;
   ALTER TABLE public.advances ADD COLUMN reason text; ALTER TABLE public.advances ADD COLUMN created_at timestamptz DEFAULT now();
   DROP TABLE public.audit_log; CREATE TABLE public.audit_log(actor_id uuid,actor_email text,action text,table_name text,record_id uuid,before_row jsonb,after_row jsonb);
   CREATE POLICY test_founder_payroll_write ON public.payroll FOR ALL TO authenticated USING (public.is_founder()) WITH CHECK (public.is_founder());
   CREATE POLICY test_founder_attendance_write ON public.attendance FOR ALL TO authenticated USING (public.is_founder()) WITH CHECK (public.is_founder());
   CREATE POLICY test_founder_advance_write ON public.advances FOR INSERT TO authenticated WITH CHECK (public.is_founder());
   INSERT INTO public.attendance(id,worker_id,project_id,date,status,hours_worked,submitted_at) VALUES
    ('${id(10)}','${worker}','${site}','2024-11-03','present',8,'2024-11-03T08:00:00Z'),
    ('${id(11)}','${worker}','${other}','2024-11-04','half_day',4,'2024-11-04T08:00:00Z'),
    ('${id(12)}','${worker}','${site}','2024-11-10','present',8,'2024-11-10T08:00:00Z'),
    ('${id(13)}','${worker}','${site}','2024-11-17','present',8,'2024-11-17T08:00:00Z'),
    ('${id(14)}','${worker}','${site}','2024-11-24','present',8,'2024-11-24T08:00:00Z');`);
  for(const path of ['supabase/migrations/20261102000000_atomic_payroll_payments.sql','supabase/migrations/20261113000000_weekly_worker_preview.sql','supabase/migrations/20261113000001_attendance_time_detail.sql','supabase/migrations/20261113000002_worker_allowances.sql','supabase/migrations/20261113000003_weekly_payroll_context.sql','supabase/drafts/guard_legacy_bale_payment.sql','supabase/drafts/weekly_payment_date.sql','supabase/drafts/weekly_worker_generator.sql','supabase/drafts/weekly_worker_approval.sql','supabase/drafts/weekly_worker_paid_allocation.sql','supabase/drafts/weekly_worker_draft_details.sql','supabase/drafts/weekly_worker_draft_refresh.sql','supabase/drafts/weekly_worker_return_to_draft.sql'])await admin.query(readFileSync(path,'utf8'));
  await Promise.all([first.query(`SET ROLE authenticated; SET test.uid='${founder}'; SET test.assurance='yes'; SET lock_timeout='4s'`),second.query(`SET ROLE authenticated; SET test.uid='${founder}'; SET test.assurance='yes'; SET lock_timeout='4s'`)]);
 },30000);
 afterAll(async()=>{await Promise.all([admin?.end(),first?.end(),second?.end()]);});
 it('serializes exact return retries and rejects stale approval',async()=>{
  await draft(first,id(1),'2024-11-03');await approve(first,id(1),0);await first.query('BEGIN');await second.query('BEGIN');try{
   expect((await back(first,id(1),id(40),0)).rows[0].result.replayed).toBe(false);let done=false;
   const retry=back(second,id(1),id(40),0).finally(()=>{done=true});await pause();expect(done).toBe(false);await first.query('COMMIT');expect((await retry).rows[0].result.replayed).toBe(true);await second.query('COMMIT');
   await expect(approve(second,id(1),0)).rejects.toThrow(/revision changed/);
   expect((await admin.query<{n:number}>('SELECT count(*)::int n FROM public.weekly_worker_approval_returns WHERE payroll_id=$1',[id(1)])).rows[0].n).toBe(1);
  }finally{await first.query('ROLLBACK');await second.query('ROLLBACK');}
 },15000);
 it('payment winning prevents return and does not undo payment',async()=>{
  await draft(first,id(2),'2024-11-10');await approve(first,id(2),0);await first.query('BEGIN');await second.query('BEGIN');try{
   await pay(first,id(2),'2024-11-16',0);let done=false;
   const attempt=back(second,id(2),id(41),0).then(()=>({code:'success'}),(e:{code:string})=>({code:e.code})).finally(()=>{done=true});await pause();expect(done).toBe(false);await first.query('COMMIT');expect((await attempt).code).toBe('22023');await second.query('ROLLBACK');
   expect((await admin.query('SELECT status FROM public.payroll WHERE id=$1',[id(2)])).rows).toEqual([{status:'paid'}]);
  }finally{await first.query('ROLLBACK');await second.query('ROLLBACK');}
 },15000);
 it('return winning prevents stale payment even after a later approval',async()=>{
  await draft(first,id(3),'2024-11-17');await approve(first,id(3),0);await first.query('BEGIN');await second.query('BEGIN');try{
   await back(first,id(3),id(42),0);let done=false;const attempt=pay(second,id(3),'2024-11-23',0).then(()=>({code:'success'}),(e:{code:string})=>({code:e.code})).finally(()=>{done=true});
   await pause();expect(done).toBe(false);await first.query('COMMIT');expect((await attempt).code).toBe('40001');await second.query('ROLLBACK');
   await approve(first,id(3),1);await expect(pay(second,id(3),'2024-11-23',0)).rejects.toThrow(/revision changed/);await pay(first,id(3),'2024-11-23',1);
  }finally{await first.query('ROLLBACK');await second.query('ROLLBACK');}
 },15000);
});
