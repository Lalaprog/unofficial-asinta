// Opt-in, synthetic records in an empty disposable local PostgreSQL DB only.
import {readFileSync} from 'node:fs';
import {Client} from 'pg';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
const url=process.env.SUPERVISOR_DAY_TEST_DATABASE_URL;
const suite=url?describe:describe.skip;
const founder='00000000-0000-0000-0000-000000000001',sup='00000000-0000-0000-0000-000000000002',day='00000000-0000-0000-0000-000000000003',otherDay='00000000-0000-0000-0000-000000000004',leave='00000000-0000-0000-0000-000000000005';
let admin:Client,first:Client,second:Client;
const pause=()=>new Promise(resolve=>setTimeout(resolve,150));
const submit=(c:Client,id:string)=>c.query("SELECT public.submit_supervisor_day($1,'2020-01-01','present') data",[id]);
const approveDay=(c:Client)=>c.query("SELECT public.review_supervisor_day($1,'approved') data",[day]);
const approveLeave=(c:Client)=>c.query("SELECT public.review_supervisor_leave($1,'approved') data",[leave]);
suite('Supervisor day and leave concurrency on PostgreSQL',()=>{
 beforeAll(async()=>{
  const parsed=new URL(url!);if(!['localhost','127.0.0.1','[::1]'].includes(parsed.hostname)||!parsed.pathname.slice(1).startsWith('asinta_test_'))throw new Error('Use an empty local disposable database named asinta_test_*.');
  admin=new Client({connectionString:url});first=new Client({connectionString:url});second=new Client({connectionString:url});await Promise.all([admin.connect(),first.connect(),second.connect()]);
  const objects=await admin.query("SELECT count(*)::int n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S')");if(objects.rows[0].n!==0||(await admin.query("SELECT 1 FROM pg_namespace WHERE nspname IN ('auth','app_private')")).rowCount)throw new Error('Test database must be empty.');
  await admin.query(`DO $$BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; END$$;
   CREATE SCHEMA auth; CREATE SCHEMA app_private;
   CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('test.uid',true),'')::uuid$$;
   CREATE FUNCTION public.session_assurance_satisfied() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT current_setting('test.assurance',true)='yes'$$;
   CREATE TABLE public.users(id uuid primary key,name text,role text); CREATE TABLE public.workers(id uuid primary key,name text);
   CREATE TABLE public.projects(id uuid primary key,name text); CREATE TABLE public.project_supervisors(project_id uuid,supervisor_id uuid);
   CREATE TABLE public.attendance(id uuid primary key,worker_id uuid,project_id uuid,date date); CREATE TABLE public.payroll(id uuid primary key,worker_id uuid,period_start date,period_end date,status text);
   CREATE FUNCTION public.is_founder() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT public.session_assurance_satisfied() AND EXISTS(SELECT 1 FROM public.users WHERE id=auth.uid() AND role='founder')$$;
   INSERT INTO public.users VALUES ('${founder}','Founder','founder'),('${sup}','Supervisor','supervisor'); GRANT USAGE ON SCHEMA public,auth TO authenticated;`);
  await admin.query(readFileSync('supabase/migrations/20261113000005_supervisor_leave.sql','utf8'));await admin.query(readFileSync('supabase/migrations/20261113000006_supervisor_daily_attendance.sql','utf8'));
  await Promise.all([first.query(`SET ROLE authenticated; SET test.uid='${sup}'; SET test.assurance='yes'; SET lock_timeout='4s'`),second.query(`SET ROLE authenticated; SET test.uid='${sup}'; SET test.assurance='yes'; SET lock_timeout='4s'`)]);
 },30000);
 beforeEach(async()=>{await admin.query('DELETE FROM public.supervisor_daily_attendance; DELETE FROM public.supervisor_leave_requests');await Promise.all([first.query(`SET test.uid='${sup}'`),second.query(`SET test.uid='${sup}'`)]);});
 afterAll(async()=>{await Promise.all([admin?.end(),first?.end(),second?.end()]);});
 it('serializes different requests for the same person and date',async()=>{
  await first.query('BEGIN');await second.query('BEGIN');try{await submit(first,day);let settled=false;const pending=submit(second,otherDay).then(()=>({code:'success'}),(e:{code:string})=>({code:e.code})).finally(()=>{settled=true});await pause();expect(settled).toBe(false);await first.query('COMMIT');expect((await pending).code).toBe('22023');await second.query('ROLLBACK');expect((await admin.query('SELECT count(*)::int n FROM public.supervisor_daily_attendance')).rows[0].n).toBe(1);}finally{await first.query('ROLLBACK');await second.query('ROLLBACK');}
 },15000);
 it('serializes identical retry IDs without creating another day',async()=>{
  await first.query('BEGIN');await second.query('BEGIN');try{expect((await submit(first,day)).rows[0].data.replayed).toBe(false);let settled=false;const pending=submit(second,day).finally(()=>{settled=true});await pause();expect(settled).toBe(false);await first.query('COMMIT');expect((await pending).rows[0].data.replayed).toBe(true);await second.query('COMMIT');}finally{await first.query('ROLLBACK');await second.query('ROLLBACK');}
 },15000);
 for(const firstType of ['day','leave'] as const)it(`prevents contradictory approvals when ${firstType} approval commits first`,async()=>{
  await submit(first,day);await first.query("SELECT public.submit_supervisor_leave($1,'2020-01-01','2020-01-01','emergency','')",[leave]);await Promise.all([first.query(`SET test.uid='${founder}'`),second.query(`SET test.uid='${founder}'`)]);await first.query('BEGIN');await second.query('BEGIN');
  try{await (firstType==='day'?approveDay(first):approveLeave(first));let settled=false;const pending=(firstType==='day'?approveLeave(second):approveDay(second)).then(()=>({code:'success'}),(e:{code:string})=>({code:e.code})).finally(()=>{settled=true});await pause();expect(settled).toBe(false);await first.query('COMMIT');expect((await pending).code).toBe('22023');await second.query('ROLLBACK');const states=await admin.query('SELECT (SELECT status FROM public.supervisor_daily_attendance) AS day_status,(SELECT status FROM public.supervisor_leave_requests) AS leave_status');expect(states.rows[0]).toEqual(firstType==='day'?{day_status:'approved',leave_status:'pending'}:{day_status:'pending',leave_status:'approved'});}finally{await first.query('ROLLBACK');await second.query('ROLLBACK');}
 },15000);
 it('rejects repeatable-read submission',async()=>{await first.query('BEGIN ISOLATION LEVEL REPEATABLE READ');try{await expect(submit(first,day)).rejects.toMatchObject({code:'P1002'});}finally{await first.query('ROLLBACK');}});
});
