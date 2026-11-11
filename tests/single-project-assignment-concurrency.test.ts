// Opt-in, destructive fixture on a disposable local PostgreSQL database ONLY.
import {readFileSync} from 'node:fs';
import {Client} from 'pg';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
const url=process.env.ASSIGNMENT_TEST_DATABASE_URL;
const suite=url?describe:describe.skip;
const founder='00000000-0000-0000-0000-000000000001',p1='10000000-0000-0000-0000-000000000001',p2='10000000-0000-0000-0000-000000000002',worker='20000000-0000-0000-0000-000000000001';
let admin:Client,first:Client,second:Client;
const call=(client:Client,project:string,active:boolean)=>client.query('SELECT public.set_project_worker_guarded($1,$2,$3,$4)',[founder,project,worker,active]);
const delay=()=>new Promise(resolve=>setTimeout(resolve,150));
suite('single-project worker assignment on real PostgreSQL',()=>{
 beforeAll(async()=>{
  const parsed=new URL(url!);
  if(!['localhost','127.0.0.1','[::1]'].includes(parsed.hostname)||!parsed.pathname.slice(1).startsWith('asinta_test_')) throw new Error('Use an empty local disposable database named asinta_test_*.');
  admin=new Client({connectionString:url});first=new Client({connectionString:url});second=new Client({connectionString:url});
  await Promise.all([admin.connect(),first.connect(),second.connect()]);
  const existing=await admin.query("SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S')");
  if(existing.rows[0].n!==0 || (await admin.query("SELECT 1 FROM pg_namespace WHERE nspname='app_private'")).rowCount)throw new Error('Test database must be empty.');
  await admin.query(`DO $$ BEGIN
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF;
   END $$;
   CREATE SCHEMA app_private; GRANT USAGE ON SCHEMA public TO authenticated,service_role;
   CREATE TABLE public.users(id uuid primary key,role text not null);
   CREATE TABLE public.projects(id uuid primary key);
   CREATE TABLE public.workers(id uuid primary key,name text not null,position text not null,contact_number text not null,pay_rate numeric not null,pay_rate_type text not null,active boolean not null);
   CREATE TABLE public.project_supervisors(project_id uuid,supervisor_id uuid,unique(project_id,supervisor_id));
   CREATE FUNCTION public.is_founder() RETURNS boolean LANGUAGE sql AS $$SELECT false$$;
   CREATE FUNCTION public.is_supervisor_assigned(uuid) RETURNS boolean LANGUAGE sql AS $$SELECT false$$;
   CREATE FUNCTION public.session_assurance_satisfied() RETURNS boolean LANGUAGE sql AS $$SELECT false$$;
   INSERT INTO public.users VALUES ('${founder}','founder'); INSERT INTO public.projects VALUES ('${p1}'),('${p2}');
   INSERT INTO public.workers VALUES ('${worker}','Fixture Worker','Mason','none',600,'daily',true);`);
  await admin.query(readFileSync('supabase/migrations/20261107000002_project_worker_lists.sql','utf8'));
  await admin.query(readFileSync('supabase/migrations/20261112000000_guarded_single_project_worker.sql','utf8'));
  await Promise.all([first.query("SET ROLE service_role; SET lock_timeout='4s'"),second.query("SET ROLE service_role; SET lock_timeout='4s'")]);
 },30000);
 beforeEach(async()=>{await admin.query('DELETE FROM public.project_worker_assignments')});
 afterAll(async()=>{await Promise.all([admin?.end(),first?.end(),second?.end()])});
 it('serializes competing site assignments and rejects the second after commit',async()=>{
  await first.query('BEGIN');await second.query('BEGIN');
  try{
   await call(first,p1,true);let settled=false;
   const pending=call(second,p2,true).then(()=>({code:''}),error=>({code:String(error.code)})).finally(()=>{settled=true});
   await delay();expect(settled).toBe(false);await first.query('COMMIT');
   expect((await pending).code).toBe('P1003');await second.query('ROLLBACK');
   expect((await admin.query('SELECT project_id FROM public.project_worker_assignments WHERE worker_id=$1 AND active',[worker])).rows).toEqual([{project_id:p1}]);
  } finally {await first.query('ROLLBACK');await second.query('ROLLBACK');}
 },15000);
 it('permits a waiting assignment if the first transaction rolls back',async()=>{
  await first.query('BEGIN');await second.query('BEGIN');
  try{
   await call(first,p1,true);let settled=false;
   const pending=call(second,p2,true).finally(()=>{settled=true});await delay();expect(settled).toBe(false);
   await first.query('ROLLBACK');await pending;await second.query('COMMIT');
   expect((await admin.query('SELECT project_id FROM public.project_worker_assignments WHERE worker_id=$1 AND active',[worker])).rows).toEqual([{project_id:p2}]);
  } finally {await first.query('ROLLBACK');await second.query('ROLLBACK');}
 },15000);
 it('allows a move after concurrent removal commits but never before it',async()=>{
  await call(first,p1,true);await first.query('BEGIN');await second.query('BEGIN');
  try{
   await call(first,p1,false);let settled=false;const pending=call(second,p2,true).finally(()=>{settled=true});await delay();expect(settled).toBe(false);
   await first.query('COMMIT');await pending;await second.query('COMMIT');
   expect((await admin.query('SELECT project_id FROM public.project_worker_assignments WHERE worker_id=$1 AND active',[worker])).rows).toEqual([{project_id:p2}]);
  } finally {await first.query('ROLLBACK');await second.query('ROLLBACK');}
 },15000);
 it('rejects stale repeatable-read assignment transactions',async()=>{
  await first.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  try {await expect(call(first,p1,true)).rejects.toMatchObject({code:'P1002'});} finally {await first.query('ROLLBACK');}
 });
});
