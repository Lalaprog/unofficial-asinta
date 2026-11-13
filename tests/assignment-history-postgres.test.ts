// Only the named empty local PostgreSQL database may be used.
import {readFileSync} from 'node:fs';
import {Client} from 'pg';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
const url=process.env.ASSIGNMENT_HISTORY_TEST_DATABASE_URL;
const founder='00000000-0000-0000-0000-000000000001',worker='00000000-0000-0000-0000-000000000003',site='00000000-0000-0000-0000-000000000004',other='00000000-0000-0000-0000-000000000005';
let admin:Client,a:Client,b:Client;const pause=()=>new Promise(r=>setTimeout(r,150));
(url?describe:describe.skip)('assignment history concurrent writes on isolated PostgreSQL',()=>{
 beforeAll(async()=>{
  const p=new URL(url!);if(!['localhost','127.0.0.1','[::1]'].includes(p.hostname)||p.pathname!=='/asinta_test_assignment_history'||p.search||p.hash)throw new Error('Use only the named empty local database');
  admin=new Client({connectionString:url});a=new Client({connectionString:url});b=new Client({connectionString:url});await Promise.all([admin.connect(),a.connect(),b.connect()]);
  const e=(await admin.query("SELECT (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S')) objects,(SELECT count(*)::int FROM pg_namespace WHERE nspname IN ('auth','app_private')) schemas")).rows[0];if(e.objects||e.schemas)throw new Error('Database must be empty');
  await admin.query(`DO $$BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF; IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF;END$$;
  CREATE SCHEMA auth;CREATE SCHEMA app_private;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('test.uid',true),'')::uuid$$;
  CREATE FUNCTION public.session_assurance_satisfied() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT current_setting('test.assurance',true)='yes'$$;
  CREATE TABLE public.users(id uuid primary key,role text,email text);INSERT INTO public.users VALUES('${founder}','founder','f@example.invalid'),('00000000-0000-0000-0000-000000000002','supervisor','s@example.invalid');
  CREATE FUNCTION public.is_founder() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT EXISTS(SELECT FROM public.users WHERE id=auth.uid() AND role='founder')$$;
  CREATE TABLE public.projects(id uuid primary key,name text);INSERT INTO public.projects VALUES('${site}','A'),('${other}','B');
  CREATE TABLE public.project_supervisors(project_id uuid,supervisor_id uuid,PRIMARY KEY(project_id,supervisor_id));INSERT INTO public.project_supervisors VALUES('${site}','00000000-0000-0000-0000-000000000002');
  CREATE FUNCTION public.is_supervisor_assigned(uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT EXISTS(SELECT FROM public.project_supervisors WHERE project_id=$1 AND supervisor_id=auth.uid())$$;
  CREATE TABLE public.attendance(id uuid primary key,worker_id uuid,project_id uuid,date date,status text);ALTER TABLE public.attendance ENABLE ROW LEVEL SECURITY;
  CREATE POLICY site_insert ON public.attendance FOR INSERT TO authenticated WITH CHECK(public.is_founder() OR public.is_supervisor_assigned(project_id));
  GRANT INSERT ON public.attendance TO authenticated;
  CREATE TABLE public.workers(id uuid primary key,name text,active boolean);INSERT INTO public.workers VALUES('${worker}','Ada',true);
  CREATE TABLE public.project_worker_assignments(project_id uuid references public.projects(id) on delete cascade,worker_id uuid references public.workers(id),active boolean,updated_at timestamptz,updated_by uuid,primary key(project_id,worker_id));
  INSERT INTO public.project_worker_assignments VALUES('${site}','${worker}',true,now(),'${founder}');
  CREATE TABLE public.audit_log(actor_id uuid,actor_email text,action text,table_name text,record_id uuid,before_row jsonb,after_row jsonb);
  CREATE FUNCTION app_private.lock_founder_guard() RETURNS void LANGUAGE sql AS $$SELECT$$;
  CREATE FUNCTION app_private.lock_project_worker_access(uuid,uuid) RETURNS void LANGUAGE sql AS $$SELECT$$;
  GRANT USAGE ON SCHEMA public,auth,app_private TO anon,authenticated,service_role;`);
  for(const path of ['supabase/migrations/20261107000006_guarded_worker_removal.sql','supabase/migrations/20261112000000_guarded_single_project_worker.sql'])await admin.query(readFileSync(path,'utf8'));
  await admin.query(`BEGIN; ${readFileSync('supabase/drafts/project_assignment_history.sql','utf8')} COMMIT`);
  await admin.query(`BEGIN; ${readFileSync('supabase/drafts/atomic_worker_move.sql','utf8')} COMMIT`);
  await admin.query(`BEGIN; ${readFileSync('supabase/drafts/attendance_assignment_guard.sql','utf8')} COMMIT`);
  await Promise.all([a.query('SET ROLE service_role;SET lock_timeout=\'4s\''),b.query('SET ROLE service_role;SET lock_timeout=\'4s\'')]);
 },30000);
 afterAll(async()=>{await Promise.all([admin?.end(),a?.end(),b?.end()]);});
 it('serializes removal and reassignment and preserves both events',async()=>{
  await a.query('BEGIN');await b.query('BEGIN');try{
   await a.query('SELECT public.set_project_worker_guarded($1,$2,$3,false)',[founder,site,worker]);let settled=false;
   const next=b.query('SELECT public.set_project_worker_guarded($1,$2,$3,true)',[founder,other,worker]).finally(()=>{settled=true;});await pause();expect(settled).toBe(false);await a.query('COMMIT');await next;await b.query('COMMIT');
   expect((await admin.query('SELECT project_id,event_type FROM public.project_assignment_history ORDER BY occurred_at,id')).rows).toEqual([{project_id:site,event_type:'baseline_active'},{project_id:site,event_type:'unassigned'},{project_id:other,event_type:'assigned'}]);
  }finally{await a.query('ROLLBACK');await b.query('ROLLBACK');}
 },15000);
 it('serializes competing atomic moves and never leaves the worker between sites',async()=>{
  const w='00000000-0000-0000-0000-000000000110',third='00000000-0000-0000-0000-000000000111',r1='00000000-0000-0000-0000-000000000112',r2='00000000-0000-0000-0000-000000000113';
  await admin.query("INSERT INTO public.projects VALUES($1,'C')",[third]);await admin.query("INSERT INTO public.workers VALUES($1,'Synthetic move',true)",[w]);
  await admin.query('INSERT INTO public.project_worker_assignments VALUES($1,$2,true,now(),$3)',[site,w,founder]);
  await Promise.all([a.query(`SET ROLE authenticated;SET test.uid='${founder}';SET test.assurance='yes'`),b.query(`SET ROLE authenticated;SET test.uid='${founder}';SET test.assurance='yes'`)]);
  await a.query('BEGIN');await b.query('BEGIN');try{
   await a.query('SELECT public.move_worker_project($1,$2,$3,$4)',[r1,w,site,other]);let settled=false;const pid=(await b.query('SELECT pg_backend_pid() pid')).rows[0].pid;
   const next=b.query('SELECT public.move_worker_project($1,$2,$3,$4)',[r2,w,site,third]).then(()=>({code:'success'}),(e:{code:string})=>({code:e.code})).finally(()=>{settled=true;});
   await pause();expect(settled).toBe(false);expect((await admin.query('SELECT cardinality(pg_blocking_pids($1))::int n',[pid])).rows[0].n).toBeGreaterThan(0);
   await a.query('COMMIT');expect((await next).code).toBe('40001');await b.query('ROLLBACK');
   expect((await admin.query('SELECT project_id FROM public.project_worker_assignments WHERE worker_id=$1 AND active',[w])).rows).toEqual([{project_id:other}]);
   expect((await admin.query('SELECT event_type,project_id FROM public.project_assignment_history WHERE worker_id=$1 ORDER BY occurred_at,id',[w])).rows).toEqual([{event_type:'assigned',project_id:site},{event_type:'unassigned',project_id:site},{event_type:'assigned',project_id:other}]);
  }finally{await a.query('ROLLBACK');await b.query('ROLLBACK');await Promise.all([a.query('SET ROLE service_role'),b.query('SET ROLE service_role')]);}
 },15000);
 it('coalesces concurrent identical move retries into one pair of history events',async()=>{
  const w='00000000-0000-0000-0000-000000000130',request='00000000-0000-0000-0000-000000000131';
  await admin.query("INSERT INTO public.workers VALUES($1,'Retry worker',true)",[w]);await admin.query('INSERT INTO public.project_worker_assignments VALUES($1,$2,true,now(),$3)',[site,w,founder]);
  await Promise.all([a.query(`SET ROLE authenticated;SET test.uid='${founder}';SET test.assurance='yes'`),b.query(`SET ROLE authenticated;SET test.uid='${founder}';SET test.assurance='yes'`)]);
  await a.query('BEGIN');await b.query('BEGIN');try{
   const first=await a.query('SELECT public.move_worker_project($1,$2,$3,$4) v',[request,w,site,other]);expect(first.rows[0].v.replayed).toBe(false);let settled=false;const pid=(await b.query('SELECT pg_backend_pid() pid')).rows[0].pid;
   const next=b.query('SELECT public.move_worker_project($1,$2,$3,$4) v',[request,w,site,other]).finally(()=>{settled=true;});await pause();expect(settled).toBe(false);expect((await admin.query('SELECT cardinality(pg_blocking_pids($1))::int n',[pid])).rows[0].n).toBeGreaterThan(0);
   await a.query('COMMIT');expect((await next).rows[0].v.replayed).toBe(true);await b.query('COMMIT');
   expect((await admin.query('SELECT count(*)::int n FROM public.project_assignment_history WHERE worker_id=$1',[w])).rows[0].n).toBe(3);
  }finally{await a.query('ROLLBACK');await b.query('ROLLBACK');await Promise.all([a.query('SET ROLE service_role'),b.query('SET ROLE service_role')]);}
 },15000);
 it('denies a move after a concurrent Founder demotion',async()=>{
  const w='00000000-0000-0000-0000-000000000140',request='00000000-0000-0000-0000-000000000141';
  await admin.query("INSERT INTO public.workers VALUES($1,'Revocation worker',true)",[w]);await admin.query('INSERT INTO public.project_worker_assignments VALUES($1,$2,true,now(),$3)',[site,w,founder]);
  await b.query(`SET ROLE authenticated;SET test.uid='${founder}';SET test.assurance='yes'`);await admin.query('BEGIN');await b.query('BEGIN');try{
   await admin.query("UPDATE public.users SET role='supervisor' WHERE id=$1",[founder]);let settled=false;const pid=(await b.query('SELECT pg_backend_pid() pid')).rows[0].pid;
   const next=b.query('SELECT public.move_worker_project($1,$2,$3,$4)',[request,w,site,other]).then(()=>({code:'success'}),(e:{code:string})=>({code:e.code})).finally(()=>{settled=true;});
   await pause();expect(settled).toBe(false);expect((await admin.query('SELECT cardinality(pg_blocking_pids($1))::int n',[pid])).rows[0].n).toBeGreaterThan(0);
   await admin.query('COMMIT');expect((await next).code).toBe('42501');await b.query('ROLLBACK');
   expect((await admin.query('SELECT project_id FROM public.project_worker_assignments WHERE worker_id=$1 AND active',[w])).rows).toEqual([{project_id:site}]);
  }finally{await admin.query('ROLLBACK');await b.query('ROLLBACK');await admin.query("UPDATE public.users SET role='founder' WHERE id=$1",[founder]);await b.query('SET ROLE service_role');}
 },15000);
 it('coordinates an atomic move with a former-site Supervisor Roll Call write',async()=>{
  const w='00000000-0000-0000-0000-000000000120',request='00000000-0000-0000-0000-000000000121',attendanceId='00000000-0000-0000-0000-000000000122',supervisor='00000000-0000-0000-0000-000000000002';
  await admin.query("INSERT INTO public.workers VALUES($1,'Synthetic roll call',true)",[w]);await admin.query('INSERT INTO public.project_worker_assignments VALUES($1,$2,true,now(),$3)',[site,w,founder]);
  await a.query(`SET ROLE authenticated;SET test.uid='${founder}';SET test.assurance='yes'`);await b.query(`SET ROLE authenticated;SET test.uid='${supervisor}';SET test.assurance='yes'`);
  await a.query('BEGIN');await b.query('BEGIN');try{
   await a.query('SELECT public.move_worker_project($1,$2,$3,$4)',[request,w,site,other]);let settled=false;const pid=(await b.query('SELECT pg_backend_pid() pid')).rows[0].pid;
   const next=b.query("INSERT INTO public.attendance VALUES($1,$2,$3,'2024-08-04','present')",[attendanceId,w,site]).then(()=>({code:'success'}),(e:{code:string})=>({code:e.code})).finally(()=>{settled=true;});
   await pause();expect(settled).toBe(false);expect((await admin.query('SELECT cardinality(pg_blocking_pids($1))::int n',[pid])).rows[0].n).toBeGreaterThan(0);
   await a.query('COMMIT');expect((await next).code).toBe('22023');await b.query('ROLLBACK');
   expect((await admin.query('SELECT count(*)::int n FROM public.attendance WHERE id=$1',[attendanceId])).rows[0].n).toBe(0);
   expect((await admin.query('SELECT project_id FROM public.project_worker_assignments WHERE worker_id=$1 AND active',[w])).rows).toEqual([{project_id:other}]);
  }finally{await a.query('ROLLBACK');await b.query('ROLLBACK');await Promise.all([a.query('SET ROLE service_role'),b.query('SET ROLE service_role')]);}
 },15000);
 it('serializes worker archive and a competing assignment, retaining archive evidence',async()=>{
  await a.query('BEGIN');await b.query('BEGIN');try{
   await a.query('SELECT public.set_workers_removed_guarded($1,$2::uuid[],true)',[founder,[worker]]);let settled=false;
   const next=b.query('SELECT public.set_project_worker_guarded($1,$2,$3,true)',[founder,site,worker]).then(()=>({code:'success'}),(e:{code:string})=>({code:e.code})).finally(()=>{settled=true;});
   await pause();expect(settled).toBe(false);await a.query('COMMIT');expect((await next).code).toBe('22023');await b.query('ROLLBACK');
   expect((await admin.query("SELECT count(*)::int n FROM public.project_assignment_history WHERE project_id=$1 AND event_type='unassigned'",[other])).rows[0].n).toBe(1);
  }finally{await a.query('ROLLBACK');await b.query('ROLLBACK');}
 },15000);
});
