import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
const founder='00000000-0000-0000-0000-000000000001',worker='00000000-0000-0000-0000-000000000003',site='00000000-0000-0000-0000-000000000004';
const sql=(p:string)=>readFileSync(p,'utf8');
async function setup(){
 const db=new PGlite();
 await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE SCHEMA auth;CREATE SCHEMA app_private;
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('test.uid',true),'')::uuid$$;
 CREATE FUNCTION public.session_assurance_satisfied() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT current_setting('test.assurance',true)='yes'$$;
 CREATE TABLE public.users(id uuid primary key,role text,email text); INSERT INTO public.users VALUES('${founder}','founder','founder@example.invalid');
 CREATE FUNCTION public.is_founder() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT EXISTS(SELECT FROM public.users WHERE id=auth.uid() AND role='founder')$$;
 CREATE TABLE public.projects(id uuid primary key,name text);INSERT INTO public.projects VALUES('${site}','Site');
 CREATE TABLE public.workers(id uuid primary key,name text,position text,active boolean);INSERT INTO public.workers VALUES('${worker}','Worker','Mason',true);
 CREATE TABLE public.project_worker_assignments(project_id uuid references public.projects(id),worker_id uuid references public.workers(id),active boolean,updated_at timestamptz,updated_by uuid,primary key(project_id,worker_id));
 INSERT INTO public.project_worker_assignments VALUES('${site}','${worker}',true,now(),'${founder}');
 CREATE TABLE public.audit_log(actor_id uuid,actor_email text,action text,table_name text,record_id uuid,before_row jsonb,after_row jsonb);
 CREATE TABLE public.attendance(id uuid primary key,worker_id uuid,status text); INSERT INTO public.attendance VALUES('00000000-0000-0000-0000-000000000011','${worker}','present');
 CREATE TABLE public.payroll(id uuid primary key,worker_id uuid,status text);INSERT INTO public.payroll VALUES('00000000-0000-0000-0000-000000000012','${worker}','paid');
 CREATE FUNCTION app_private.lock_founder_guard() RETURNS void LANGUAGE sql AS $$SELECT$$;
 GRANT USAGE ON SCHEMA public,auth,app_private TO anon,authenticated,service_role;`);
 for(const path of ['supabase/migrations/20261107000006_guarded_worker_removal.sql','supabase/drafts/project_assignment_history.sql','supabase/drafts/worker_category_catalog.sql','supabase/drafts/worker_category_workforce_cutover.sql']) await db.exec(`BEGIN;${sql(path)} COMMIT;`);
 return db;
}
const repair=sql('supabase/drafts/worker_removal_category_compatibility.sql');
describe('category cutover and reversible worker removal',()=>{
 it('reproduces the conflict, then archives and restores without deleting history',async()=>{const db=await setup();try{
  await db.exec('SET ROLE service_role');const action=(remove:boolean)=>db.query<{v:{results:Array<{status:string}>}}>('SELECT public.set_workers_removed_guarded($1,$2::uuid[],$3) v',[founder,[worker],remove]);
  await expect(action(true)).rejects.toThrow(/SCHEMA_REVIEW/);await db.exec('RESET ROLE');await db.exec(`BEGIN;${repair} COMMIT`);await db.exec('SET ROLE service_role');
  expect((await action(true)).rows[0].v.results[0].status).toBe('removed');expect((await action(false)).rows[0].v.results[0].status).toBe('restored');await db.exec('RESET ROLE');
  expect((await db.query('SELECT active,removed_at,position,category_id IS NOT NULL category FROM public.workers WHERE id=$1',[worker])).rows[0]).toEqual({active:false,removed_at:null,position:'Mason',category:true});
  expect((await db.query('SELECT active FROM public.project_worker_assignments WHERE worker_id=$1',[worker])).rows[0]).toEqual({active:false});
  expect((await db.query('SELECT event_type FROM public.project_assignment_history WHERE worker_id=$1 ORDER BY event_type',[worker])).rows).toEqual([{event_type:'baseline_active'},{event_type:'unassigned'}]);
  expect((await db.query('SELECT status FROM public.attendance WHERE worker_id=$1',[worker])).rows[0]).toEqual({status:'present'});expect((await db.query('SELECT status FROM public.payroll WHERE worker_id=$1',[worker])).rows[0]).toEqual({status:'paid'});
  expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.audit_log')).rows[0].n).toBe(2);
 }finally{await db.close();}},30000);
 it('refuses unexpected, disabled or altered triggers and does not modify the worker',async()=>{const db=await setup();try{
  await db.exec(`BEGIN;${repair} COMMIT`);const action=()=>db.query('SELECT public.set_workers_removed_guarded($1,$2::uuid[],true)',[founder,[worker]]);
  await db.exec('ALTER TABLE public.workers DISABLE TRIGGER bind_worker_category');await expect(action()).rejects.toThrow(/SCHEMA_REVIEW/);await db.exec('ALTER TABLE public.workers ENABLE TRIGGER bind_worker_category');
  await db.exec('ALTER TABLE public.project_worker_assignments DISABLE TRIGGER record_project_assignment_history');await expect(action()).rejects.toThrow(/SCHEMA_REVIEW/);await db.exec('ALTER TABLE public.project_worker_assignments ENABLE TRIGGER record_project_assignment_history');
  await db.exec("CREATE FUNCTION public.extra_worker_trigger() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$; CREATE TRIGGER extra_worker_trigger BEFORE UPDATE ON public.workers FOR EACH ROW EXECUTE FUNCTION public.extra_worker_trigger()");await expect(action()).rejects.toThrow(/SCHEMA_REVIEW/);await db.exec('DROP TRIGGER extra_worker_trigger ON public.workers');
  await db.exec('DROP TRIGGER bind_worker_category ON public.workers; CREATE TRIGGER bind_worker_category BEFORE INSERT OR UPDATE OF position ON public.workers FOR EACH ROW EXECUTE FUNCTION public.bind_worker_category()');await expect(action()).rejects.toThrow(/SCHEMA_REVIEW/);
  expect((await db.query('SELECT active,removed_at FROM public.workers WHERE id=$1',[worker])).rows[0]).toEqual({active:true,removed_at:null});expect((await db.query('SELECT active FROM public.project_worker_assignments WHERE worker_id=$1',[worker])).rows[0]).toEqual({active:true});expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.audit_log')).rows[0].n).toBe(0);
 }finally{await db.close();}},30000);
 it('rejects changed archive function and disabled required category trigger during installation',async()=>{const db=await setup();try{
  await db.exec('ALTER TABLE public.workers DISABLE TRIGGER bind_worker_category');await expect(db.exec(`BEGIN;${repair} COMMIT`)).rejects.toThrow(/Category trigger differs/);await db.exec('ROLLBACK; ALTER TABLE public.workers ENABLE TRIGGER bind_worker_category');
  await db.exec('CREATE OR REPLACE FUNCTION public.set_workers_removed_guarded(p_actor uuid,p_ids uuid[],p_remove boolean) RETURNS jsonb LANGUAGE sql AS $$SELECT NULL::jsonb$$');await expect(db.exec(`BEGIN;${repair} COMMIT`)).rejects.toThrow(/Archive guard differs/);await db.exec('ROLLBACK');
 }finally{await db.close();}},30000);
});
