import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let db:PGlite;
const sql=readFileSync('supabase/migrations/20261112000001_payslip_batch_snapshot.sql','utf8');
beforeEach(async()=>{
 db=new PGlite();
 await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE SCHEMA auth;
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub', true),'')::uuid$$;
 CREATE TABLE public.users(id uuid primary key,name text,role text);
 CREATE FUNCTION public.is_founder() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT EXISTS (SELECT 1 FROM public.users WHERE id=auth.uid() AND role='founder')$$;
 CREATE TABLE public.workers(id uuid primary key,name text,position text);
 CREATE TABLE public.projects(id uuid primary key,name text);
 CREATE TABLE public.attendance(id uuid primary key, worker_id uuid, project_id uuid, date date);
 CREATE TABLE public.payroll(id uuid primary key, worker_id uuid, period_start date, period_end date, status text, days_worked numeric, hours_worked numeric, gross_pay numeric, bale_deduction numeric, other_deductions numeric, net_pay numeric);
 GRANT USAGE ON SCHEMA public,auth TO authenticated,anon;
 GRANT SELECT ON public.users, public.workers, public.projects, public.attendance, public.payroll TO authenticated;
 INSERT INTO public.users VALUES ('00000000-0000-0000-0000-000000000001','Founder','founder'),('00000000-0000-0000-0000-000000000002','Supervisor','supervisor');
 INSERT INTO public.workers VALUES ('00000000-0000-0000-0000-000000000003','Alba','Mason'), ('00000000-0000-0000-0000-000000000002','Supervisor','Supervisor');
 INSERT INTO public.projects VALUES ('00000000-0000-0000-0000-000000000004','Site A');
 INSERT INTO public.attendance VALUES ('00000000-0000-0000-0000-000000000005','00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000004','2026-10-25');
 INSERT INTO public.payroll VALUES ('00000000-0000-0000-0000-000000000006','00000000-0000-0000-0000-000000000003','2026-10-25','2026-10-31','paid',1,8,500.25,10.10,0,490.15), ('00000000-0000-0000-0000-000000000007','00000000-0000-0000-0000-000000000002','2026-10-25','2026-10-31','paid',1,8,1000,0,0,1000);`);
 await db.exec(sql);
 await db.exec(`SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',false); SET ROLE authenticated`);
},30000);
afterEach(async()=>{await db.close()});
const batch=()=>db.query<{data:Record<string,unknown>[] }>("SELECT public.payslip_batch_snapshot('2026-10-25','2026-10-31') AS data");
describe('payslip batch SQL',()=>{
 it('returns exact-period workers and excludes linked supervisors without changing records',async()=>{
  const result=await batch(); expect(result.rows[0].data).toHaveLength(1);
  expect(result.rows[0].data[0]).toMatchObject({worker_name:'Alba',status:'paid',gross_pay:500.25});
  expect((await db.query('SELECT * FROM public.payroll')).rows).toHaveLength(2);
 });
 it('refuses Supervisor access and invalid periods',async()=>{
  await db.exec("SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',false)");
  await expect(batch()).rejects.toThrow(/Founder/);
  await db.exec("SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',false)");
  await expect(db.query("SELECT public.payslip_batch_snapshot('2026-10-31','2026-10-25')")).rejects.toThrow(/valid period/);
 });
 it('stops for duplicates and ambiguous legacy Supervisor profiles',async()=>{
  await db.exec("RESET ROLE; INSERT INTO public.payroll SELECT '00000000-0000-0000-0000-000000000008',worker_id,period_start,period_end,status,days_worked,hours_worked,gross_pay,bale_deduction,other_deductions,net_pay FROM public.payroll WHERE id='00000000-0000-0000-0000-000000000006'; SET ROLE authenticated");
  await expect(batch()).rejects.toThrow(/Duplicate/);
  await db.exec("RESET ROLE; DELETE FROM public.payroll WHERE id='00000000-0000-0000-0000-000000000008'; UPDATE public.workers SET position='Site Supervisor' WHERE name='Alba'; SET ROLE authenticated");
  await expect(batch()).rejects.toThrow(/unlinked Supervisor/);
 });
});
