// Opt-in: this creates objects and synthetic data ONLY in an empty disposable local DB.
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
const url=process.env.TIME_DETAIL_TEST_DATABASE_URL;
const suite=url?describe:describe.skip;
const founder='00000000-0000-0000-0000-000000000001',worker='00000000-0000-0000-0000-000000000002',site='00000000-0000-0000-0000-000000000003',att='00000000-0000-0000-0000-000000000004',pay='00000000-0000-0000-0000-000000000005',req='00000000-0000-0000-0000-000000000006', sup='00000000-0000-0000-0000-000000000007', allowance='00000000-0000-0000-0000-000000000008';
let admin:Client,first:Client,second:Client;
const sleep=()=>new Promise(resolve=>setTimeout(resolve,150));
const save=(c:Client)=>c.query('SELECT public.record_attendance_time_detail($1,$2,$3,8,2,$4) AS result',[req,att,'2026-11-01T08:00:00Z','Synthetic timesheet']);
const approve=(c:Client)=>c.query("SELECT public.set_payroll_status_atomic($1,'approved') AS result",[pay]);
suite('attendance time detail concurrency on real PostgreSQL',()=>{
 beforeAll(async()=>{
  const parsed=new URL(url!);
  if(!['localhost','127.0.0.1','[::1]'].includes(parsed.hostname)||!parsed.pathname.slice(1).startsWith('asinta_test_'))throw new Error('Use an empty local disposable database named asinta_test_*.');
  admin=new Client({connectionString:url});first=new Client({connectionString:url});second=new Client({connectionString:url});
  await Promise.all([admin.connect(),first.connect(),second.connect()]);
  const objects=await admin.query("SELECT count(*)::int n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S')");
  if(objects.rows[0].n!==0||(await admin.query("SELECT 1 FROM pg_namespace WHERE nspname='auth'")).rowCount)throw new Error('Test database must be empty.');
  await admin.query(`DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; END $$;
   CREATE SCHEMA auth;
   CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('test.uid',true),'')::uuid$$;
   CREATE FUNCTION public.session_assurance_satisfied() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT current_setting('test.assurance',true)='yes'$$;
   CREATE TABLE public.users(id uuid primary key,name text,role text,email text);
   CREATE TABLE public.workers(id uuid primary key,name text,position text);
   CREATE TABLE public.projects(id uuid primary key,name text);
   CREATE TABLE public.project_supervisors(project_id uuid,supervisor_id uuid,unique(project_id,supervisor_id));
   CREATE TABLE public.attendance(id uuid primary key,worker_id uuid,project_id uuid,date date,status text,hours_worked numeric,submitted_at timestamptz,recorded_by uuid,notes text);
   CREATE TABLE public.payroll(id uuid primary key,worker_id uuid,period_start date,period_end date,gross_pay numeric,bale_deduction numeric,other_deductions numeric,net_pay numeric,status text,days_worked numeric,hours_worked numeric,notes text);
   CREATE TABLE public.advances(id uuid primary key,worker_id uuid,date date,amount numeric,amount_deducted numeric,status text);
   CREATE TABLE public.audit_log(actor_id uuid,actor_email text,action text,table_name text,record_id uuid,before_row jsonb,after_row jsonb);
   CREATE FUNCTION public.is_founder() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT public.session_assurance_satisfied() AND EXISTS(SELECT 1 FROM public.users WHERE id=auth.uid() AND role='founder')$$;
   CREATE FUNCTION public.is_supervisor_assigned(p uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT public.session_assurance_satisfied() AND EXISTS(SELECT 1 FROM public.project_supervisors WHERE supervisor_id=auth.uid() AND project_id=p)$$;
   CREATE FUNCTION public.weekly_worker_preview_inputs(p date) RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT jsonb_build_object('attendance','[]'::jsonb)$$;
   INSERT INTO public.users VALUES ('${founder}','Founder','founder','fixture@example.invalid'),('${sup}','Supervisor','supervisor','supervisor@example.invalid');
   INSERT INTO public.workers VALUES ('${worker}','Worker','Mason'); INSERT INTO public.projects VALUES ('${site}','Site'); INSERT INTO public.project_supervisors VALUES ('${site}','${sup}');
   INSERT INTO public.attendance VALUES ('${att}','${worker}','${site}','2026-11-01','present',8,'2026-11-01T08:00:00Z',NULL,NULL);
   INSERT INTO public.payroll VALUES ('${pay}','${worker}','2026-11-01','2026-11-07',600,0,0,600,'draft',1,8,'fixture');
   GRANT USAGE ON SCHEMA public,auth TO authenticated; GRANT SELECT ON public.attendance TO authenticated;`);
  await admin.query(readFileSync('supabase/migrations/20261102000000_atomic_payroll_payments.sql','utf8'));
  await admin.query(readFileSync('supabase/migrations/20261113000001_attendance_time_detail.sql','utf8'));
  await admin.query(readFileSync('supabase/migrations/20261113000002_worker_allowances.sql','utf8'));
  await Promise.all([first.query(`SET ROLE authenticated; SET test.uid='${founder}'; SET test.assurance='yes'; SET lock_timeout='4s'`),second.query(`SET ROLE authenticated; SET test.uid='${founder}'; SET test.assurance='yes'; SET lock_timeout='4s'`)]);
 },30000);
 beforeEach(async()=>{await admin.query(`DELETE FROM public.attendance_time_details; DELETE FROM public.worker_allowances; DELETE FROM public.audit_log; UPDATE public.payroll SET status='draft' WHERE id='${pay}';`)});
 afterAll(async()=>{await Promise.all([admin?.end(),first?.end(),second?.end()]);});
 it('waits for a concurrent approval and then rejects new details for the approved period',async()=>{
  await first.query('BEGIN');await second.query('BEGIN');
  try{
   await approve(first);let settled=false;
   const pending=save(second).then(()=>({code:'success'}),(error:{code:string})=>({code:error.code})).finally(()=>{settled=true});
   await sleep();expect(settled).toBe(false);await first.query('COMMIT');expect((await pending).code).toBe('22023');await second.query('ROLLBACK');
   expect((await admin.query('SELECT count(*)::int n FROM public.attendance_time_details')).rows[0].n).toBe(0);
   expect((await admin.query('SELECT status FROM public.payroll')).rows[0].status).toBe('approved');
  }finally{await first.query('ROLLBACK');await second.query('ROLLBACK');}
 },15000);
 it('serializes retry of the same request and records one detail',async()=>{
  await first.query('BEGIN');await second.query('BEGIN');
  try{
   expect((await save(first)).rows[0].result.replayed).toBe(false);let settled=false;
   const pending=save(second).finally(()=>{settled=true});await sleep();expect(settled).toBe(false);
   await first.query('COMMIT');expect((await pending).rows[0].result.replayed).toBe(true);await second.query('COMMIT');
   expect((await admin.query('SELECT count(*)::int n FROM public.attendance_time_details')).rows[0].n).toBe(1);
  }finally{await first.query('ROLLBACK');await second.query('ROLLBACK');}
 },15000);
 it('serializes allowance approval against a concurrently approved payroll',async()=>{
  await first.query(`SET test.uid='${sup}'`);
  await first.query('SELECT public.submit_worker_allowance($1,$2,$3,100.25,$4)',[allowance,att,'2026-11-01T08:00:00Z','Synthetic meals']);
  await first.query(`SET test.uid='${founder}'`);await first.query('BEGIN');await second.query('BEGIN');
  try{
   await approve(first);let settled=false;
   const pending=second.query("SELECT public.review_worker_allowance($1,'approved')",[allowance]).then(()=>({code:'success'}),(error:{code:string})=>({code:error.code})).finally(()=>{settled=true});
   await sleep();expect(settled).toBe(false);await first.query('COMMIT');expect((await pending).code).toBe('22023');await second.query('ROLLBACK');
   expect((await admin.query('SELECT status FROM public.worker_allowances')).rows[0].status).toBe('pending');
  }finally{await first.query('ROLLBACK');await second.query('ROLLBACK');}
 },15000);
 it('rejects repeatable-read transactions that could hide concurrent approval',async()=>{
  await first.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  try{await expect(save(first)).rejects.toMatchObject({code:'P1002'});}finally{await first.query('ROLLBACK');}
 });
});
