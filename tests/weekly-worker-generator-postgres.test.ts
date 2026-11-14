// Opt-in only: synthetic rows in an EMPTY local disposable PostgreSQL database.
import {readFileSync} from 'node:fs';
import {Client} from 'pg';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {baseFixture} from './helpers/pr103-fixture';
const url=process.env.WEEKLY_GENERATOR_TEST_DATABASE_URL;
const suite=url?describe:describe.skip;
const founder='00000000-0000-0000-0000-000000000001',worker='00000000-0000-0000-0000-000000000003',site='00000000-0000-0000-0000-000000000004';
const id=(n:number)=>`20000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
const pause=()=>new Promise(resolve=>setTimeout(resolve,150));
let admin:Client,first:Client,second:Client;
const generate=(c:Client,key:string,start:string)=>c.query('SELECT public.create_weekly_worker_draft($1,$2,$3) result',[key,worker,start]);
suite('weekly generator concurrency on disposable PostgreSQL',()=>{
 beforeAll(async()=>{
  const parsed=new URL(url!);if(!['localhost','127.0.0.1','[::1]'].includes(parsed.hostname)||!parsed.pathname.slice(1).startsWith('asinta_test_')||parsed.search||parsed.hash)throw new Error('Use an empty local disposable database named asinta_test_* without URL options.');
  admin=new Client({connectionString:url});first=new Client({connectionString:url});second=new Client({connectionString:url});await Promise.all([admin.connect(),first.connect(),second.connect()]);
  const existing=(await admin.query(`SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S'))::int objects, (SELECT count(*) FROM pg_namespace WHERE nspname IN ('auth','app_private','storage'))::int schemas`)).rows[0];
  if(existing.objects||existing.schemas)throw new Error('Use an empty disposable database.');
  await admin.query(`DO $$BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF; END$$;`);
  const roles='CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; ';if(!baseFixture.startsWith(roles))throw new Error('Fixture role bootstrap changed');
  await admin.query(baseFixture.slice(roles.length));
  await admin.query(`ALTER TABLE public.users ADD COLUMN email text; UPDATE public.users SET email='founder@example.invalid'; ALTER TABLE public.payroll ADD COLUMN notes text;
   ALTER TABLE public.advances ADD COLUMN reason text; ALTER TABLE public.advances ADD COLUMN created_at timestamptz DEFAULT now();
   DROP TABLE public.audit_log; CREATE TABLE public.audit_log(actor_id uuid,actor_email text,action text,table_name text,record_id uuid,before_row jsonb,after_row jsonb);
   CREATE POLICY test_founder_payroll_write ON public.payroll FOR ALL TO authenticated USING (public.is_founder()) WITH CHECK (public.is_founder());
   CREATE POLICY test_founder_attendance_write ON public.attendance FOR ALL TO authenticated USING (public.is_founder()) WITH CHECK (public.is_founder());
   INSERT INTO public.attendance(id,worker_id,project_id,date,status,hours_worked,submitted_at) VALUES
    ('${id(10)}','${worker}','${site}','2024-11-03','present',8,'2024-11-03T08:00:00Z'),
    ('${id(11)}','${worker}','${site}','2024-11-10','present',8,'2024-11-10T08:00:00Z'),
    ('${id(12)}','${worker}','${site}','2024-11-17','present',8,'2024-11-17T08:00:00Z'),
    ('${id(13)}','${worker}','${site}','2024-11-24','present',8,'2024-11-24T08:00:00Z');`);
  for(const path of ['supabase/migrations/20261102000000_atomic_payroll_payments.sql','supabase/migrations/20261113000000_weekly_worker_preview.sql','supabase/migrations/20261113000001_attendance_time_detail.sql','supabase/migrations/20261113000002_worker_allowances.sql','supabase/migrations/20261113000003_weekly_payroll_context.sql','supabase/drafts/weekly_worker_generator.sql','supabase/drafts/weekly_worker_approval.sql'])await admin.query(readFileSync(path,'utf8'));
  await Promise.all([first.query(`SET ROLE authenticated; SET test.uid='${founder}'; SET test.assurance='yes'; SET lock_timeout='4s'`),second.query(`SET ROLE authenticated; SET test.uid='${founder}'; SET test.assurance='yes'; SET lock_timeout='4s'`)]);
 },30000);
 afterAll(async()=>{await Promise.all([admin?.end(),first?.end(),second?.end()]);});
 it('serializes matching retries and rejects another draft for the same period',async()=>{
  await first.query('BEGIN');await second.query('BEGIN');try{
   expect((await generate(first,id(1),'2024-11-03')).rows[0].result.replayed).toBe(false);
   let finished=false;const retry=generate(second,id(1),'2024-11-03').finally(()=>{finished=true});
   await pause();expect(finished).toBe(false);await first.query('COMMIT');expect((await retry).rows[0].result.replayed).toBe(true);await second.query('COMMIT');
   await expect(generate(second,id(2),'2024-11-03')).rejects.toThrow(/existing voucher|overlapping voucher/);
   expect((await admin.query<{n:number}>('SELECT count(*)::int n FROM public.weekly_worker_draft_sources WHERE worker_id=$1 AND period_start=$2',[worker,'2024-11-03'])).rows[0].n).toBe(1);
  }finally{await first.query('ROLLBACK');await second.query('ROLLBACK');}
 },15000);
 it('waits for an in-flight legacy attendance edit and then refuses the stale draft',async()=>{
  await generate(first,id(4),'2024-11-17');await first.query('BEGIN');await second.query('BEGIN');try{
   await first.query('UPDATE public.attendance SET hours_worked=4 WHERE id=$1',[id(12)]);
   let finished=false;const approval=second.query('SELECT public.approve_weekly_worker_draft($1)',[id(4)]).then(()=>({code:'success'}),(e:{code:string})=>({code:e.code})).finally(()=>{finished=true});
   await pause();expect(finished).toBe(false);await first.query('COMMIT');expect((await approval).code).toBe('40001');await second.query('ROLLBACK');
   expect((await admin.query('SELECT status FROM public.payroll WHERE id=$1',[id(4)])).rows).toEqual([{status:'draft'}]);
  }finally{await first.query('ROLLBACK');await second.query('ROLLBACK');}
 },15000);
 it('serializes matching approval retries without allowing payment',async()=>{
  await generate(first,id(5),'2024-11-24');await first.query('BEGIN');await second.query('BEGIN');try{
   expect((await first.query('SELECT public.approve_weekly_worker_draft($1) result',[id(5)])).rows[0].result.outcome).toBe('updated');
   let finished=false;const retry=second.query('SELECT public.approve_weekly_worker_draft($1) result',[id(5)]).finally(()=>{finished=true});
   await pause();expect(finished).toBe(false);await first.query('COMMIT');expect((await retry).rows[0].result.outcome).toBe('already_approved');await second.query('COMMIT');
   expect((await admin.query<{n:number}>("SELECT count(*)::int n FROM public.audit_log WHERE table_name='payroll' AND record_id=$1 AND action='update'",[id(5)])).rows[0].n).toBe(1);
   await expect(first.query("SELECT public.set_payroll_status_atomic($1,'paid')",[id(5)])).rejects.toThrow(/frozen/);
  }finally{await first.query('ROLLBACK');await second.query('ROLLBACK');}
 },15000);
 it('takes a consistent snapshot while legacy attendance edits wait; the stale draft cannot be approved',async()=>{
  await first.query('BEGIN');await second.query('BEGIN');try{
   await generate(first,id(3),'2024-11-10');let finished=false;
   const edit=second.query('UPDATE public.attendance SET hours_worked=4 WHERE id=$1',[id(11)]).finally(()=>{finished=true});
   await pause();expect(finished).toBe(false);await first.query('COMMIT');expect((await edit).rowCount).toBe(1);await second.query('COMMIT');
   const recorded=await admin.query("SELECT source_snapshot->'attendance'->0->'record'->>'hours_worked' hours FROM public.weekly_worker_draft_sources WHERE payroll_id=$1",[id(3)]);
   expect(recorded.rows[0].hours).toBe('8');
   await expect(first.query("SELECT public.set_payroll_status_atomic($1,'approved')",[id(3)])).rejects.toThrow(/frozen/);
  }finally{await first.query('ROLLBACK');await second.query('ROLLBACK');}
 },15000);
});
