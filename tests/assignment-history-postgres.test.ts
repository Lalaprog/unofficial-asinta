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
  CREATE TABLE public.users(id uuid primary key,role text,email text);INSERT INTO public.users VALUES('${founder}','founder','f@example.invalid');
  CREATE FUNCTION public.is_founder() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT EXISTS(SELECT FROM public.users WHERE id=auth.uid() AND role='founder')$$;
  CREATE TABLE public.projects(id uuid primary key,name text);INSERT INTO public.projects VALUES('${site}','A'),('${other}','B');
  CREATE TABLE public.workers(id uuid primary key,name text,active boolean);INSERT INTO public.workers VALUES('${worker}','Ada',true);
  CREATE TABLE public.project_worker_assignments(project_id uuid references public.projects(id) on delete cascade,worker_id uuid references public.workers(id),active boolean,updated_at timestamptz,updated_by uuid,primary key(project_id,worker_id));
  INSERT INTO public.project_worker_assignments VALUES('${site}','${worker}',true,now(),'${founder}');
  CREATE TABLE public.audit_log(actor_id uuid,actor_email text,action text,table_name text,record_id uuid,before_row jsonb,after_row jsonb);
  CREATE FUNCTION app_private.lock_founder_guard() RETURNS void LANGUAGE sql AS $$SELECT$$;
  CREATE FUNCTION app_private.lock_project_worker_access(uuid,uuid) RETURNS void LANGUAGE sql AS $$SELECT$$;
  GRANT USAGE ON SCHEMA public,auth,app_private TO anon,authenticated,service_role;`);
  for(const path of ['supabase/migrations/20261107000006_guarded_worker_removal.sql','supabase/migrations/20261112000000_guarded_single_project_worker.sql'])await admin.query(readFileSync(path,'utf8'));
  await admin.query(`BEGIN; ${readFileSync('supabase/drafts/project_assignment_history.sql','utf8')} COMMIT`);
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
 it('serializes worker archive and a competing assignment, retaining archive evidence',async()=>{
  await a.query('BEGIN');await b.query('BEGIN');try{
   await a.query('SELECT public.set_workers_removed_guarded($1,$2::uuid[],true)',[founder,[worker]]);let settled=false;
   const next=b.query('SELECT public.set_project_worker_guarded($1,$2,$3,true)',[founder,site,worker]).then(()=>({code:'success'}),(e:{code:string})=>({code:e.code})).finally(()=>{settled=true;});
   await pause();expect(settled).toBe(false);await a.query('COMMIT');expect((await next).code).toBe('22023');await b.query('ROLLBACK');
   expect((await admin.query("SELECT count(*)::int n FROM public.project_assignment_history WHERE project_id=$1 AND event_type='unassigned'",[other])).rows[0].n).toBe(1);
  }finally{await a.query('ROLLBACK');await b.query('ROLLBACK');}
 },15000);
});
