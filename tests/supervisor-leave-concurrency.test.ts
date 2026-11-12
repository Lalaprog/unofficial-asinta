// Opt-in: synthetic data in an empty disposable local PostgreSQL database only.
import {readFileSync} from 'node:fs';
import {Client} from 'pg';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
const url=process.env.SUPERVISOR_LEAVE_TEST_DATABASE_URL;
const suite=url?describe:describe.skip;
const founder='00000000-0000-0000-0000-000000000001',sup='00000000-0000-0000-0000-000000000002',firstId='00000000-0000-0000-0000-000000000003',secondId='00000000-0000-0000-0000-000000000004';
let admin:Client,first:Client,second:Client;
const pause=()=>new Promise(resolve=>setTimeout(resolve,150));
const submit=(c:Client,id:string)=>c.query('SELECT public.submit_supervisor_leave($1,$2,$3,$4,$5) data',[id,'2020-01-01','2020-01-02','emergency','Fixture']);
const review=(c:Client,decision:string)=>c.query('SELECT public.review_supervisor_leave($1,$2) data',[firstId,decision]);
suite('Supervisor leave concurrency on local PostgreSQL',()=>{
 beforeAll(async()=>{
  const parsed=new URL(url!);if(!['localhost','127.0.0.1','[::1]'].includes(parsed.hostname)||!parsed.pathname.slice(1).startsWith('asinta_test_'))throw new Error('Use an empty local disposable database named asinta_test_*.');
  admin=new Client({connectionString:url});first=new Client({connectionString:url});second=new Client({connectionString:url});await Promise.all([admin.connect(),first.connect(),second.connect()]);
  const objects=await admin.query("SELECT count(*)::int n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S')");
  if(objects.rows[0].n!==0||(await admin.query("SELECT 1 FROM pg_namespace WHERE nspname IN ('auth','app_private')")).rowCount)throw new Error('Test database must be empty.');
  await admin.query(`DO $$BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; END$$;
   CREATE SCHEMA auth; CREATE SCHEMA app_private;
   CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('test.uid',true),'')::uuid$$;
   CREATE FUNCTION public.session_assurance_satisfied() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT current_setting('test.assurance',true)='yes'$$;
   CREATE TABLE public.users(id uuid primary key,name text,role text); CREATE TABLE public.workers(id uuid primary key,name text);
   CREATE TABLE public.payroll(id uuid primary key,worker_id uuid,period_start date,period_end date,status text);
   CREATE FUNCTION public.is_founder() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT public.session_assurance_satisfied() AND EXISTS(SELECT 1 FROM public.users WHERE id=auth.uid() AND role='founder')$$;
   INSERT INTO public.users VALUES ('${founder}','Founder','founder'),('${sup}','Supervisor','supervisor'); GRANT USAGE ON SCHEMA public,auth TO authenticated;`);
  await admin.query(readFileSync('supabase/migrations/20261113000005_supervisor_leave.sql','utf8'));
  await Promise.all([first.query(`SET ROLE authenticated; SET test.uid='${sup}'; SET test.assurance='yes'; SET lock_timeout='4s'`),second.query(`SET ROLE authenticated; SET test.uid='${sup}'; SET test.assurance='yes'; SET lock_timeout='4s'`)]);
 },30000);
 beforeEach(async()=>{await admin.query('DELETE FROM public.supervisor_leave_requests');await Promise.all([first.query(`SET test.uid='${sup}'`),second.query(`SET test.uid='${sup}'`)]);});
 afterAll(async()=>{await Promise.all([admin?.end(),first?.end(),second?.end()]);});
 it('serializes the same retry and records only one request',async()=>{
  await first.query('BEGIN');await second.query('BEGIN');try{
   expect((await submit(first,firstId)).rows[0].data.replayed).toBe(false);let settled=false;const pending=submit(second,firstId).finally(()=>{settled=true});await pause();expect(settled).toBe(false);
   await first.query('COMMIT');expect((await pending).rows[0].data.replayed).toBe(true);await second.query('COMMIT');expect((await admin.query('SELECT count(*)::int n FROM public.supervisor_leave_requests')).rows[0].n).toBe(1);
  }finally{await first.query('ROLLBACK');await second.query('ROLLBACK');}
 },15000);
 it('serializes overlapping requests with different IDs',async()=>{
  await first.query('BEGIN');await second.query('BEGIN');try{
   await submit(first,firstId);let settled=false;const pending=submit(second,secondId).then(()=>({code:'success'}),(e:{code:string})=>({code:e.code})).finally(()=>{settled=true});await pause();expect(settled).toBe(false);await first.query('COMMIT');expect((await pending).code).toBe('22023');await second.query('ROLLBACK');
   expect((await admin.query('SELECT count(*)::int n FROM public.supervisor_leave_requests')).rows[0].n).toBe(1);
  }finally{await first.query('ROLLBACK');await second.query('ROLLBACK');}
 },15000);
 it('serializes contradictory Founder decisions',async()=>{
  await submit(first,firstId);await Promise.all([first.query(`SET test.uid='${founder}'`),second.query(`SET test.uid='${founder}'`)]);await first.query('BEGIN');await second.query('BEGIN');try{
   await review(first,'approved');let settled=false;const pending=review(second,'rejected').then(()=>({code:'success'}),(e:{code:string})=>({code:e.code})).finally(()=>{settled=true});await pause();expect(settled).toBe(false);await first.query('COMMIT');expect((await pending).code).toBe('22023');await second.query('ROLLBACK');expect((await admin.query('SELECT status FROM public.supervisor_leave_requests')).rows[0].status).toBe('approved');
  }finally{await first.query('ROLLBACK');await second.query('ROLLBACK');}
 },15000);
 it('rejects repeatable-read submission',async()=>{
  await first.query('BEGIN ISOLATION LEVEL REPEATABLE READ');try{await expect(submit(first,firstId)).rejects.toMatchObject({code:'P1002'});}finally{await first.query('ROLLBACK');}
 });
});
