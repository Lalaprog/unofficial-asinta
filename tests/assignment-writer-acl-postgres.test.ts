// Opt-in: an empty local disposable asinta_test_* database only. Synthetic
// SECURITY DEFINER stand-ins test ACL/lock behavior, not hosted RPC semantics.
import {Client} from 'pg';
import {readFileSync} from 'node:fs';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
const url=process.env.ASSIGNMENT_WRITER_ACL_TEST_DATABASE_URL;
const suite=url?describe:describe.skip;
const draft=readFileSync('supabase/drafts/assignment_writer_acl_cutover.sql','utf8');
const pause=()=>new Promise(resolve=>setTimeout(resolve,150));
suite('assignment ACL cutover races in disposable PostgreSQL',()=>{
 let admin:Client,writer:Client;
 beforeAll(async()=>{
  const parsed=new URL(url!);if(!['localhost','127.0.0.1','[::1]'].includes(parsed.hostname)||!parsed.pathname.slice(1).startsWith('asinta_test_')||parsed.search||parsed.hash)throw Error('Use an empty local disposable asinta_test_* database');
  admin=new Client({connectionString:url});writer=new Client({connectionString:url});await Promise.all([admin.connect(),writer.connect()]);
  const existing=(await admin.query("SELECT count(*)::int n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S')")).rows[0].n;if(existing)throw Error('Database must be empty');
  await admin.query(`DO $$BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF; END$$;
   CREATE TABLE public.project_worker_assignments(worker_id integer primary key,active boolean NOT NULL);
   INSERT INTO public.project_worker_assignments VALUES(1,true);
   GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role;GRANT ALL ON public.project_worker_assignments TO service_role;
   CREATE FUNCTION public.set_project_worker_guarded(uuid,uuid,uuid,boolean) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$UPDATE public.project_worker_assignments SET active=$4 WHERE worker_id=1$$;
   CREATE FUNCTION public.create_project_worker_guarded(uuid,uuid,uuid,text,text,text,numeric,text) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$SELECT$$;
   CREATE FUNCTION public.set_workers_removed_guarded(uuid,uuid[],boolean) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$SELECT$$;
   REVOKE ALL ON FUNCTION public.set_project_worker_guarded(uuid,uuid,uuid,boolean),public.create_project_worker_guarded(uuid,uuid,uuid,text,text,text,numeric,text),public.set_workers_removed_guarded(uuid,uuid[],boolean) FROM PUBLIC,anon,authenticated;
   GRANT EXECUTE ON FUNCTION public.set_project_worker_guarded(uuid,uuid,uuid,boolean),public.create_project_worker_guarded(uuid,uuid,uuid,text,text,text,numeric,text),public.set_workers_removed_guarded(uuid,uuid[],boolean) TO service_role;`);
  await writer.query("SET ROLE service_role;SET lock_timeout='5s'");
 },30000);
 afterAll(async()=>{await Promise.all([admin?.end(),writer?.end()]);});
 it('waits for an already-running writer before revoking direct table rights',async()=>{
  await writer.query('BEGIN');await admin.query('BEGIN');try{
   await writer.query('UPDATE public.project_worker_assignments SET active=false WHERE worker_id=1');let finished=false;const pid=(await admin.query('SELECT pg_backend_pid() pid')).rows[0].pid;
   const cutover=admin.query(draft).finally(()=>{finished=true});await pause();expect(finished).toBe(false);
   expect((await writer.query('SELECT cardinality(pg_blocking_pids($1))::int n',[pid])).rows[0].n).toBeGreaterThan(0);
   await writer.query('COMMIT');await cutover;await admin.query('COMMIT');
   expect((await admin.query('SELECT active FROM public.project_worker_assignments WHERE worker_id=1')).rows).toEqual([{active:false}]);
   await expect(writer.query('UPDATE public.project_worker_assignments SET active=true WHERE worker_id=1')).rejects.toThrow(/permission denied/);
  }finally{await writer.query('ROLLBACK');await admin.query('ROLLBACK');}
 },15000);
 it('denies a direct writer that was waiting when cutover committed, while the guarded RPC still runs',async()=>{
  await admin.query('GRANT UPDATE ON public.project_worker_assignments TO service_role');await admin.query('BEGIN');await writer.query('BEGIN');try{
   await admin.query(draft);let finished=false;const pid=(await writer.query('SELECT pg_backend_pid() pid')).rows[0].pid;
   const pending=writer.query('UPDATE public.project_worker_assignments SET active=true WHERE worker_id=1').then(()=>({message:'success'}),(e:Error)=>({message:e.message})).finally(()=>{finished=true});
   await pause();expect(finished).toBe(false);expect((await admin.query('SELECT cardinality(pg_blocking_pids($1))::int n',[pid])).rows[0].n).toBeGreaterThan(0);await admin.query('COMMIT');expect((await pending).message).toMatch(/permission denied/);await writer.query('ROLLBACK');
   await writer.query("SELECT public.set_project_worker_guarded(NULL,NULL,NULL,true)");
   expect((await admin.query('SELECT active FROM public.project_worker_assignments WHERE worker_id=1')).rows).toEqual([{active:true}]);
  }finally{await writer.query('ROLLBACK');await admin.query('ROLLBACK');}
 },15000);
 it('rolls back all revokes when an inherited column privilege survives',async()=>{
  await admin.query('CREATE ROLE asinta_acl_inherited; GRANT UPDATE(active) ON public.project_worker_assignments TO asinta_acl_inherited; GRANT asinta_acl_inherited TO service_role; GRANT UPDATE ON public.project_worker_assignments TO service_role');
  try{
   await admin.query('BEGIN');await expect(admin.query(draft)).rejects.toThrow(/Inherited assignment write/);await admin.query('ROLLBACK');
   expect((await admin.query("SELECT has_table_privilege('service_role','public.project_worker_assignments','UPDATE') retained")).rows).toEqual([{retained:true}]);
  }finally{await admin.query('ROLLBACK');await admin.query('REVOKE asinta_acl_inherited FROM service_role; REVOKE ALL PRIVILEGES ON public.project_worker_assignments FROM asinta_acl_inherited; REVOKE UPDATE(active) ON public.project_worker_assignments FROM asinta_acl_inherited; DROP ROLE asinta_acl_inherited');}
 },15000);
});
