// Opt-in only: creates synthetic schema in an EMPTY local disposable database.
import {readFileSync} from 'node:fs';
import {Client} from 'pg';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {baseFixture} from './helpers/pr103-fixture';
const url=process.env.HISTORICAL_PAID_DATE_TEST_DATABASE_URL;
const suite=url?describe:describe.skip;
const founder='00000000-0000-0000-0000-000000000001',worker='00000000-0000-0000-0000-000000000003',site='00000000-0000-0000-0000-000000000004',other='00000000-0000-0000-0000-000000000005';
const id=(n:number)=>`30000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
const pause=()=>new Promise(resolve=>setTimeout(resolve,150));
let admin:Client,first:Client,second:Client;
suite('historical paid-date annotation concurrency',()=>{
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
  for(const path of ['supabase/migrations/20261102000000_atomic_payroll_payments.sql','supabase/migrations/20261113000000_weekly_worker_preview.sql','supabase/migrations/20261113000001_attendance_time_detail.sql','supabase/migrations/20261113000002_worker_allowances.sql','supabase/migrations/20261113000003_weekly_payroll_context.sql','supabase/drafts/guard_legacy_bale_payment.sql','supabase/drafts/weekly_payment_date.sql','supabase/drafts/weekly_worker_generator.sql','supabase/drafts/weekly_worker_approval.sql','supabase/drafts/weekly_worker_paid_allocation.sql','supabase/drafts/weekly_worker_draft_details.sql','supabase/drafts/weekly_worker_draft_refresh.sql','supabase/drafts/weekly_worker_return_to_draft.sql','supabase/drafts/historical_paid_date_annotation.sql'])await admin.query(readFileSync(path,'utf8'));
  await admin.query(`INSERT INTO public.payroll(id,worker_id,period_start,period_end,status,gross_pay,bale_deduction,other_deductions,net_pay) VALUES ('${id(60)}','${worker}','2024-09-01','2024-09-07','paid',1000,200,0,800),('${id(61)}','${worker}','2024-09-08','2024-09-14','paid',600,0,0,600)`);
  await Promise.all([first.query(`SET ROLE authenticated; SET test.uid='${founder}'; SET test.assurance='yes'; SET lock_timeout='4s'`),second.query(`SET ROLE authenticated; SET test.uid='${founder}'; SET test.assurance='yes'; SET lock_timeout='4s'`)]);
 },30000);
 afterAll(async()=>{await Promise.all([admin?.end(),first?.end(),second?.end()]);});
 it('serializes identical retries without changing payroll or Bale',async()=>{
  const snapshot=(await admin.query('SELECT public.historical_paid_voucher_snapshot(p) v FROM public.payroll p WHERE id=$1',[id(60)])).rows[0].v;
  const call=(c:Client)=>c.query("SELECT public.annotate_historical_paid_date($1,$2,$3,'2024-09-07','Ledger reviewed') result",[id(70),id(60),snapshot]);
  await first.query('BEGIN');await second.query('BEGIN');try{
   expect((await call(first)).rows[0].result.replayed).toBe(false);let done=false;const retry=call(second).finally(()=>{done=true});await pause();expect(done).toBe(false);await first.query('COMMIT');expect((await retry).rows[0].result.replayed).toBe(true);await second.query('COMMIT');
   expect((await admin.query('SELECT status,gross_pay::text,bale_deduction::text FROM public.payroll WHERE id=$1',[id(60)])).rows).toEqual([{status:'paid',gross_pay:'1000',bale_deduction:'200'}]);
   expect((await admin.query<{n:number}>('SELECT count(*)::int n FROM public.historical_paid_date_annotations WHERE payroll_id=$1',[id(60)])).rows[0].n).toBe(1);
  }finally{await first.query('ROLLBACK');await second.query('ROLLBACK');}
 },15000);
 it('serializes competing dates and fails the second without replacing evidence',async()=>{
  const snapshot=(await admin.query('SELECT public.historical_paid_voucher_snapshot(p) v FROM public.payroll p WHERE id=$1',[id(61)])).rows[0].v;
  await first.query('BEGIN');await second.query('BEGIN');try{
   await first.query("SELECT public.annotate_historical_paid_date($1,$2,$3,'2024-09-14','Ledger reviewed')",[id(71),id(61),snapshot]);let done=false;
   const conflict=second.query("SELECT public.annotate_historical_paid_date($1,$2,$3,'2024-09-13','Another date')",[id(72),id(61),snapshot]).then(()=>({code:'success'}),(e:{code:string})=>({code:e.code})).finally(()=>{done=true});await pause();expect(done).toBe(false);await first.query('COMMIT');expect((await conflict).code).toBe('22023');await second.query('ROLLBACK');
   expect((await admin.query('SELECT payment_date::text FROM public.historical_paid_date_annotations WHERE payroll_id=$1',[id(61)])).rows).toEqual([{payment_date:'2024-09-14'}]);
  }finally{await first.query('ROLLBACK');await second.query('ROLLBACK');}
 },15000);
});
