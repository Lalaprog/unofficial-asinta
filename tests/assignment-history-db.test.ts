import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
const sql=(name:string)=>readFileSync(name,'utf8');
const founder='00000000-0000-0000-0000-000000000001',supervisor='00000000-0000-0000-0000-000000000002',worker='00000000-0000-0000-0000-000000000003',site='00000000-0000-0000-0000-000000000004',other='00000000-0000-0000-0000-000000000005';
async function setup(){const db=new PGlite();await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE SCHEMA auth;CREATE SCHEMA app_private;
 ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon,authenticated,service_role;
 ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon,authenticated,service_role;
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('test.uid',true),'')::uuid$$;
 CREATE FUNCTION public.session_assurance_satisfied() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT current_setting('test.assurance',true)='yes'$$;
 CREATE TABLE public.users(id uuid primary key,role text,email text);INSERT INTO public.users VALUES('${founder}','founder','f@example.invalid'),('${supervisor}','supervisor',NULL);
 CREATE FUNCTION public.is_founder() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT EXISTS(SELECT FROM public.users WHERE id=auth.uid() AND role='founder')$$;
 CREATE TABLE public.projects(id uuid primary key,name text);INSERT INTO public.projects VALUES('${site}','A'),('${other}','B');
 CREATE TABLE public.workers(id uuid primary key,name text,active boolean);INSERT INTO public.workers VALUES('${worker}','Ada',true);
 CREATE TABLE public.project_worker_assignments(project_id uuid references public.projects(id) on delete cascade,worker_id uuid references public.workers(id),active boolean,updated_at timestamptz,updated_by uuid,primary key(project_id,worker_id));
 INSERT INTO public.project_worker_assignments VALUES('${site}','${worker}',true,now(),'${founder}');
 CREATE TABLE public.audit_log(actor_id uuid,actor_email text,action text,table_name text,record_id uuid,before_row jsonb,after_row jsonb);
 CREATE FUNCTION app_private.lock_founder_guard() RETURNS void LANGUAGE sql AS $$SELECT$$;
 CREATE FUNCTION app_private.lock_project_worker_access(uuid,uuid) RETURNS void LANGUAGE plpgsql AS $$BEGIN IF $1<>'${founder}' THEN RAISE EXCEPTION 'access required'; END IF; END$$;
 GRANT USAGE ON SCHEMA public,auth,app_private TO anon,authenticated,service_role;`);
 await db.exec(sql('supabase/migrations/20261107000006_guarded_worker_removal.sql'));await db.exec(sql('supabase/migrations/20261112000000_guarded_single_project_worker.sql'));return db;}
describe('assignment history candidate',()=>{
 it('observes baseline without inventing intervals and records transitions, moves and archive',async()=>{
  const db=await setup();try{await db.exec(`BEGIN; ${sql('supabase/drafts/project_assignment_history.sql')} COMMIT`);
   expect((await db.query('SELECT project_id,event_type,actor_id FROM public.project_assignment_history')).rows).toEqual([{project_id:site,event_type:'baseline_active',actor_id:null}]);
   await db.exec('SET ROLE service_role');const change=(project:string,on:boolean)=>db.query('SELECT public.set_project_worker_guarded($1,$2,$3,$4)',[founder,project,worker,on]);
   await change(site,true);await expect(change(other,true)).rejects.toThrow(/already has/);await change(site,false);await change(other,true);await change(other,true);
   await db.query('SELECT public.set_workers_removed_guarded($1,$2::uuid[],true)',[founder,[worker]]);
   await db.query('SELECT public.set_workers_removed_guarded($1,$2::uuid[],false)',[founder,[worker]]);
   await db.exec('RESET ROLE');
   expect((await db.query('SELECT project_id,event_type,actor_id FROM public.project_assignment_history ORDER BY occurred_at,id')).rows).toEqual([
    {project_id:site,event_type:'baseline_active',actor_id:null},{project_id:site,event_type:'unassigned',actor_id:founder},{project_id:other,event_type:'assigned',actor_id:founder},{project_id:other,event_type:'unassigned',actor_id:founder}]);
   expect((await db.query('SELECT active,removed_at FROM public.workers WHERE id=$1',[worker])).rows[0]).toEqual({active:false,removed_at:null});
   await expect(db.query('DELETE FROM public.project_worker_assignments WHERE worker_id=$1',[worker])).rejects.toThrow(/must not be deleted/);
   await expect(db.query('DELETE FROM public.project_assignment_history')).rejects.toThrow(/immutable/);
   await db.exec(`SET ROLE authenticated;SET test.uid='${founder}';SET test.assurance='yes'`);
   const history=(await db.query<{v:{items:unknown[]}}>('SELECT public.founder_assignment_history($1) v',[worker])).rows[0].v;expect(history.items).toHaveLength(4);
   await expect(db.query('SELECT * FROM public.project_assignment_history')).rejects.toThrow(/permission denied/);
   await db.exec(`SET test.uid='${supervisor}'`);await expect(db.query('SELECT public.founder_assignment_history($1)',[worker])).rejects.toThrow(/Founder/);
   await db.exec(`SET test.uid='${founder}';SET test.assurance='no'`);await expect(db.query('SELECT public.founder_assignment_history($1)',[worker])).rejects.toThrow(/Founder/);
  }finally{await db.close();}
 },30000);
 it('rolls back a transition if history insertion fails and refuses extra or disabled triggers during archive',async()=>{
  const db=await setup();try{await db.exec(`BEGIN; ${sql('supabase/drafts/project_assignment_history.sql')} COMMIT`);
   await db.exec(`CREATE FUNCTION public.fail_history() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'history failure'; END$$;CREATE TRIGGER fail_history BEFORE INSERT ON public.project_assignment_history FOR EACH ROW EXECUTE FUNCTION public.fail_history()`);
   await expect(db.query('SELECT public.set_project_worker_guarded($1,$2,$3,false)',[founder,site,worker])).rejects.toThrow(/history failure/);
   expect((await db.query('SELECT active FROM public.project_worker_assignments WHERE worker_id=$1',[worker])).rows[0]).toEqual({active:true});await db.exec('DROP TRIGGER fail_history ON public.project_assignment_history');
   await db.exec('ALTER TABLE public.project_worker_assignments DISABLE TRIGGER record_project_assignment_history');await expect(db.query('SELECT public.set_workers_removed_guarded($1,$2::uuid[],true)',[founder,[worker]])).rejects.toThrow(/SCHEMA_REVIEW/);
   await db.exec('ALTER TABLE public.project_worker_assignments ENABLE TRIGGER record_project_assignment_history');
   await db.exec(`CREATE FUNCTION public.extra_assignment_trigger() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$;CREATE TRIGGER extra_assignment_trigger BEFORE UPDATE ON public.project_worker_assignments FOR EACH ROW EXECUTE FUNCTION public.extra_assignment_trigger()`);
   await expect(db.query('SELECT public.set_workers_removed_guarded($1,$2::uuid[],true)',[founder,[worker]])).rejects.toThrow(/SCHEMA_REVIEW/);
  }finally{await db.close();}
 },30000);
 it('aborts installation with unfamiliar removal guard or other existing triggers',async()=>{
  const db=await setup();try{
   await db.exec(`CREATE FUNCTION public.extra_trigger() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$;CREATE TRIGGER extra_trigger BEFORE UPDATE ON public.workers FOR EACH ROW EXECUTE FUNCTION public.extra_trigger()`);
   await expect(db.exec(`BEGIN; ${sql('supabase/drafts/project_assignment_history.sql')} COMMIT`)).rejects.toThrow(/triggers require review/);await db.exec('ROLLBACK');
   expect((await db.query<{x:string|null}>("SELECT to_regclass('public.project_assignment_history')::text x")).rows[0].x).toBeNull();
   await db.exec('DROP TRIGGER extra_trigger ON public.workers;CREATE OR REPLACE FUNCTION public.set_workers_removed_guarded(p_actor uuid,p_ids uuid[],p_remove boolean) RETURNS jsonb LANGUAGE sql AS $$SELECT NULL::jsonb$$');
   await expect(db.exec(`BEGIN; ${sql('supabase/drafts/project_assignment_history.sql')} COMMIT`)).rejects.toThrow(/Removal guard differs/);await db.exec('ROLLBACK');
   expect((await db.query<{x:string|null}>("SELECT to_regclass('public.project_assignment_history')::text x")).rows[0].x).toBeNull();
  }finally{await db.close();}
 },30000);
});
