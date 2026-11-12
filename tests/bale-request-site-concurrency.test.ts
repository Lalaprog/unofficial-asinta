// Opt-in: synthetic objects only, in an empty local disposable PostgreSQL DB.
import {readFileSync} from 'node:fs';
import {Client} from 'pg';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
const url=process.env.BALE_SITE_TEST_DATABASE_URL;
const suite=url?describe:describe.skip;
const sup='00000000-0000-0000-0000-000000000001',founder='00000000-0000-0000-0000-000000000002',worker='00000000-0000-0000-0000-000000000003',project='00000000-0000-0000-0000-000000000004';
let admin:Client,first:Client,second:Client;
const pause=()=>new Promise(resolve=>setTimeout(resolve,150));
const submit=(c:Client)=>c.query('INSERT INTO public.advance_requests(worker_id,project_id,requested_amount,submitted_by) VALUES ($1,$2,100,$3)',[worker,project,sup]);
const remove=(c:Client)=>c.query('SELECT public.set_project_worker_guarded($1,$2,$3,false)',[founder,project,worker]);
suite('Bale request vs assignment changes on real PostgreSQL',()=>{
 beforeAll(async()=>{
  const parsed=new URL(url!);
  if(!['localhost','127.0.0.1','[::1]'].includes(parsed.hostname)||!parsed.pathname.slice(1).startsWith('asinta_test_')) throw new Error('Use an empty local disposable database named asinta_test_*.');
  admin=new Client({connectionString:url});first=new Client({connectionString:url});second=new Client({connectionString:url});
  await Promise.all([admin.connect(),first.connect(),second.connect()]);
  const objects=await admin.query("SELECT count(*)::int n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S')");
  if(objects.rows[0].n!==0||(await admin.query("SELECT 1 FROM pg_namespace WHERE nspname IN ('auth','app_private')")).rowCount)throw new Error('Test database must be empty.');
  await admin.query(`DO $$BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF; END$$;
   CREATE SCHEMA auth; CREATE SCHEMA app_private;
   CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('test.uid',true),'')::uuid$$;
   CREATE FUNCTION public.session_assurance_satisfied() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT current_setting('test.assurance',true)='yes'$$;
   CREATE TABLE public.users(id uuid primary key,role text); CREATE TABLE public.projects(id uuid primary key);
   CREATE TABLE public.workers(id uuid primary key,active boolean); CREATE TABLE public.project_supervisors(project_id uuid,supervisor_id uuid,unique(project_id,supervisor_id));
   CREATE TABLE public.project_worker_assignments(project_id uuid,worker_id uuid,active boolean,updated_by uuid,updated_at timestamptz default now(),primary key(project_id,worker_id));
   CREATE TABLE public.advance_requests(id uuid primary key default gen_random_uuid(),worker_id uuid,project_id uuid,requested_amount numeric,submitted_by uuid,status text default 'pending_approval');
   CREATE FUNCTION public.current_user_role() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT role FROM public.users WHERE id=auth.uid()$$;
   CREATE FUNCTION public.is_supervisor_assigned(p uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT EXISTS(SELECT 1 FROM public.project_supervisors WHERE project_id=p AND supervisor_id=auth.uid())$$;
   CREATE FUNCTION app_private.lock_project_worker_access(p_actor uuid,p_project uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN
    PERFORM 1 FROM public.users WHERE id=p_actor AND role IN ('founder','supervisor') FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Access'; END IF;
    PERFORM 1 FROM public.projects WHERE id=p_project FOR KEY SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Project'; END IF;
    IF EXISTS(SELECT 1 FROM public.users WHERE id=p_actor AND role='supervisor') THEN PERFORM 1 FROM public.project_supervisors WHERE supervisor_id=p_actor AND project_id=p_project FOR KEY SHARE; IF NOT FOUND THEN RAISE EXCEPTION 'Access'; END IF; END IF;
   END $$;
   ALTER TABLE public.advance_requests ENABLE ROW LEVEL SECURITY;
   CREATE POLICY requests_insert ON public.advance_requests FOR INSERT TO authenticated WITH CHECK (submitted_by=auth.uid() AND public.is_supervisor_assigned(project_id) AND status='pending_approval');
   GRANT USAGE ON SCHEMA public,auth TO authenticated,service_role; GRANT SELECT,INSERT ON public.advance_requests TO authenticated;
   INSERT INTO public.users VALUES ('${sup}','supervisor'),('${founder}','founder'); INSERT INTO public.projects VALUES ('${project}'); INSERT INTO public.workers VALUES ('${worker}',true); INSERT INTO public.project_supervisors VALUES ('${project}','${sup}');`);
  await admin.query(readFileSync('supabase/migrations/20261112000000_guarded_single_project_worker.sql','utf8'));
  await admin.query(readFileSync('supabase/migrations/20261113000004_bale_request_site_guard.sql','utf8'));
  await first.query(`SET ROLE service_role; SET lock_timeout='4s'`);
  await second.query(`SET ROLE authenticated; SET test.uid='${sup}'; SET test.assurance='yes'; SET lock_timeout='4s'`);
 },30000);
 beforeEach(async()=>{await admin.query(`DELETE FROM public.advance_requests; DELETE FROM public.project_worker_assignments; INSERT INTO public.project_worker_assignments(project_id,worker_id,active) VALUES ('${project}','${worker}',true);`)});
 afterAll(async()=>{await Promise.all([admin?.end(),first?.end(),second?.end()])});
 it('waits for removal then refuses a request for a worker no longer on the site',async()=>{
  await first.query('BEGIN');await second.query('BEGIN');
  try{
   await remove(first);let settled=false;
   const pending=submit(second).then(()=>({code:'success'}),(e:{code:string})=>({code:e.code})).finally(()=>{settled=true});
   await pause();expect(settled).toBe(false);await first.query('COMMIT');expect((await pending).code).toBe('22023');await second.query('ROLLBACK');
   expect((await admin.query('SELECT count(*)::int n FROM public.advance_requests')).rows[0].n).toBe(0);
  }finally{await first.query('ROLLBACK');await second.query('ROLLBACK');}
 },15000);
 it('allows removal after a valid request has committed, without deleting the request',async()=>{
  await first.query('BEGIN');await second.query('BEGIN');
  try{
   await submit(second);let settled=false;const pending=remove(first).finally(()=>{settled=true});await pause();expect(settled).toBe(false);
   await second.query('COMMIT');await pending;await first.query('COMMIT');
   expect((await admin.query('SELECT count(*)::int n FROM public.advance_requests')).rows[0].n).toBe(1);
   expect((await admin.query('SELECT active FROM public.project_worker_assignments')).rows[0].active).toBe(false);
  }finally{await first.query('ROLLBACK');await second.query('ROLLBACK');}
 },15000);
 it('waits for Supervisor site access revocation and refuses the request',async()=>{
  await first.query('RESET ROLE');await first.query('BEGIN');await second.query('BEGIN');
  try{
   await first.query('DELETE FROM public.project_supervisors WHERE project_id=$1 AND supervisor_id=$2',[project,sup]);let settled=false;
   const pending=submit(second).then(()=>({code:'success'}),(e:{code:string})=>({code:e.code})).finally(()=>{settled=true});
   await pause();expect(settled).toBe(false);await first.query('COMMIT');expect((await pending).code).toBe('42501');await second.query('ROLLBACK');
   expect((await admin.query('SELECT count(*)::int n FROM public.advance_requests')).rows[0].n).toBe(0);
  }finally{await first.query('ROLLBACK');await second.query('ROLLBACK');await admin.query('INSERT INTO public.project_supervisors VALUES ($1,$2) ON CONFLICT DO NOTHING',[project,sup]);await first.query('SET ROLE service_role');}
 },15000);
 it('rejects repeatable-read requests with potentially stale assignment snapshots',async()=>{
  await second.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  try{await expect(submit(second)).rejects.toMatchObject({code:'P1002'});}finally{await second.query('ROLLBACK');}
 });
});
