import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
const sql=(p:string)=>readFileSync(p,'utf8');
const founder='00000000-0000-0000-0000-000000000001', worker='00000000-0000-0000-0000-000000000003', site='00000000-0000-0000-0000-000000000004', other='00000000-0000-0000-0000-000000000005', created='00000000-0000-0000-0000-000000000006';
async function setup(){
 const db=new PGlite();
 await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE SCHEMA auth;CREATE SCHEMA app_private;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('test.uid',true),'')::uuid$$;
  CREATE FUNCTION public.session_assurance_satisfied() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT current_setting('test.assurance',true)='yes'$$;
  CREATE TABLE public.users(id uuid PRIMARY KEY,role text,email text);INSERT INTO public.users VALUES('${founder}','founder','fixture@example.invalid');
  CREATE FUNCTION public.is_founder() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT EXISTS(SELECT 1 FROM public.users WHERE id=auth.uid() AND role='founder')$$;
  CREATE TABLE public.projects(id uuid PRIMARY KEY,name text);INSERT INTO public.projects VALUES('${site}','A'),('${other}','B');
  CREATE TABLE public.workers(id uuid PRIMARY KEY,name text,position text,contact_number text,pay_rate numeric,pay_rate_type text,active boolean);
  INSERT INTO public.workers VALUES('${worker}','Ada','Mason','none',600,'daily',true);
  CREATE TABLE public.project_worker_assignments(project_id uuid REFERENCES public.projects,worker_id uuid REFERENCES public.workers,active boolean,updated_at timestamptz DEFAULT now(),updated_by uuid,PRIMARY KEY(project_id,worker_id));
  INSERT INTO public.project_worker_assignments VALUES('${site}','${worker}',true,now(),'${founder}');
  CREATE TABLE app_private.project_worker_create_requests(request_id uuid PRIMARY KEY,actor_id uuid,project_id uuid,worker_id uuid,fingerprint text,created_at timestamptz DEFAULT now());
  CREATE TABLE public.audit_log(actor_id uuid,actor_email text,action text,table_name text,record_id uuid,before_row jsonb,after_row jsonb);
  CREATE FUNCTION app_private.lock_founder_guard() RETURNS void LANGUAGE sql AS $$SELECT$$;
  CREATE FUNCTION app_private.lock_project_worker_access(p_actor uuid,p_project uuid) RETURNS void LANGUAGE plpgsql AS $$BEGIN IF p_actor<>'${founder}' OR NOT EXISTS(SELECT 1 FROM public.projects WHERE id=p_project) THEN RAISE EXCEPTION 'access required'; END IF; END$$;
  GRANT USAGE ON SCHEMA public,auth,app_private TO anon,authenticated,service_role;
  GRANT SELECT ON public.project_worker_assignments TO authenticated,service_role;
  GRANT ALL ON public.project_worker_assignments TO service_role;
  GRANT UPDATE(active) ON public.project_worker_assignments TO service_role;`);
 await db.exec(sql('supabase/migrations/20261107000006_guarded_worker_removal.sql'));
 await db.exec(sql('supabase/migrations/20261112000000_guarded_single_project_worker.sql'));
 const original=sql('supabase/migrations/20261107000002_project_worker_lists.sql');
 const start=original.indexOf('CREATE FUNCTION public.create_project_worker_guarded('),end=original.indexOf('REVOKE ALL ON FUNCTION public.create_project_worker_guarded',start);
 if(start<0||end<0)throw Error('Create function not found');
 await db.exec(original.slice(start,end));
 await db.exec('REVOKE ALL ON FUNCTION public.create_project_worker_guarded(uuid,uuid,uuid,text,text,text,numeric,text) FROM PUBLIC,anon,authenticated; GRANT EXECUTE ON FUNCTION public.create_project_worker_guarded(uuid,uuid,uuid,text,text,text,numeric,text) TO service_role');
 return db;
}
const candidate=()=>sql('supabase/drafts/assignment_writer_acl_cutover.sql');
describe('assignment writer ACL cutover candidate (not deployed)',()=>{
 it('blocks direct service writes but keeps guarded creation, assignment, move, archive, reads and history',async()=>{
  const db=await setup();try{
   await db.exec(`BEGIN;${sql('supabase/drafts/project_assignment_history.sql')} COMMIT;BEGIN;${sql('supabase/drafts/atomic_worker_move.sql')} COMMIT`);
   await db.exec(`BEGIN;${candidate()} COMMIT;SET ROLE service_role`);
   expect((await db.query('SELECT count(*)::int n FROM public.project_worker_assignments')).rows[0]).toEqual({n:1});
   await expect(db.query('UPDATE public.project_worker_assignments SET active=false WHERE worker_id=$1',[worker])).rejects.toThrow(/permission denied/);
   await expect(db.query('INSERT INTO public.project_worker_assignments(project_id,worker_id,active) VALUES($1,$2,true)',[other,worker])).rejects.toThrow(/permission denied/);
   await expect(db.query('DELETE FROM public.project_worker_assignments WHERE worker_id=$1',[worker])).rejects.toThrow(/permission denied/);
   await expect(db.exec('TRUNCATE public.project_worker_assignments')).rejects.toThrow(/permission denied/);
   const make=()=>db.query<{v:{worker_id:string;replayed:boolean}}>('SELECT public.create_project_worker_guarded($1,$2,$3,$4,$5,$6,$7,$8) v',[founder,other,created,'Ben','Mason','none',600,'daily']);
   expect((await make()).rows[0].v).toMatchObject({worker_id:created,replayed:false});expect((await make()).rows[0].v.replayed).toBe(true);
   await db.query('SELECT public.set_project_worker_guarded($1,$2,$3,false)',[founder,other,created]);
   await db.query('SELECT public.set_project_worker_guarded($1,$2,$3,true)',[founder,site,created]);
   await db.query('SELECT public.set_workers_removed_guarded($1,$2::uuid[],true)',[founder,[created]]);
   await db.query('SELECT public.set_workers_removed_guarded($1,$2::uuid[],false)',[founder,[created]]);
   await db.exec(`SET ROLE authenticated;SET test.uid='${founder}';SET test.assurance='yes'`);
   await expect(db.query('UPDATE public.project_worker_assignments SET active=false WHERE worker_id=$1',[worker])).rejects.toThrow(/permission denied/);
   await db.query('SELECT public.move_worker_project($1,$2,$3,$4)',['00000000-0000-0000-0000-000000000010',worker,site,other]);
   await db.exec('RESET ROLE');
   expect((await db.query('SELECT project_id FROM public.project_worker_assignments WHERE worker_id=$1 AND active',[worker])).rows).toEqual([{project_id:other}]);
   expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.project_assignment_history WHERE worker_id=$1',[created])).rows[0].n).toBe(4);
  }finally{await db.close();}
 },30000);
 it('rolls back revokes if an inherited column grant makes the cutover unsafe',async()=>{
  const db=await setup();try{
   await db.exec('CREATE ROLE inherited_assignment_writer; GRANT UPDATE(active) ON public.project_worker_assignments TO inherited_assignment_writer; GRANT inherited_assignment_writer TO service_role');
   await expect(db.exec(`BEGIN;${candidate()} COMMIT`)).rejects.toThrow(/Inherited assignment write/);await db.exec('ROLLBACK');
   expect((await db.query("SELECT has_table_privilege('service_role','public.project_worker_assignments','INSERT') has_insert")).rows[0]).toEqual({has_insert:true});
  }finally{await db.close();}
 },30000);
 it('refuses when an expected writer is missing and preserves existing access',async()=>{
  const db=await setup();try{
   await db.exec('DROP FUNCTION public.create_project_worker_guarded(uuid,uuid,uuid,text,text,text,numeric,text)');
   await expect(db.exec(`BEGIN;${candidate()} COMMIT`)).rejects.toThrow(/Reviewed assignment writer missing/);await db.exec('ROLLBACK');
   expect((await db.query("SELECT has_table_privilege('service_role','public.project_worker_assignments','INSERT') has_insert")).rows[0]).toEqual({has_insert:true});
  }finally{await db.close();}
 },30000);
});
