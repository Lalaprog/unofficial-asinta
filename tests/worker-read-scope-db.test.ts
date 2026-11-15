import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';

const release=readFileSync('supabase/release/development-worker-read-scope.sql','utf8');
const f='10000000-0000-4000-8000-000000000001',s='10000000-0000-4000-8000-000000000002',s2='10000000-0000-4000-8000-000000000003',site='20000000-0000-4000-8000-000000000001',other='20000000-0000-4000-8000-000000000002';
const id=(n:number)=>`30000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
async function setup(){const db=new PGlite();await db.exec(`
 CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;CREATE SCHEMA auth;CREATE SCHEMA app_private;
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('test.uid',true),'')::uuid$$;
 CREATE FUNCTION public.session_assurance_satisfied() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT coalesce(current_setting('test.assurance',true)='yes',false)$$;
 CREATE TABLE public.users(id uuid primary key,role text,name text);INSERT INTO public.users VALUES ('${f}','founder','Founder'),('${s}','supervisor','Supervisor One'),('${s2}','supervisor','Supervisor Two');
 ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
 GRANT SELECT ON public.users TO authenticated;
 CREATE POLICY own_user ON public.users FOR SELECT TO authenticated USING(id=auth.uid());
 CREATE FUNCTION public.current_user_role() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT role FROM public.users WHERE id=auth.uid()$$;
 CREATE FUNCTION public.is_founder() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT public.session_assurance_satisfied() AND public.current_user_role()='founder'$$;
 CREATE TABLE public.projects(id uuid primary key,name text);INSERT INTO public.projects VALUES('${site}','A'),('${other}','B');
 CREATE TABLE public.project_supervisors(project_id uuid,supervisor_id uuid,unique(project_id,supervisor_id));INSERT INTO public.project_supervisors VALUES('${site}','${s}'),('${other}','${s2}');
 CREATE FUNCTION public.is_supervisor_assigned(p uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT public.session_assurance_satisfied() AND EXISTS(SELECT FROM public.project_supervisors WHERE project_id=p AND supervisor_id=auth.uid())$$;
 CREATE TABLE public.workers(id uuid primary key,name text,position text,contact_number text,active boolean);INSERT INTO public.workers VALUES
 ('${s}','Supervisor One','Supervisor','',true),('${id(1)}','Assigned A','Mason','',true),('${id(2)}','Assigned B','Mason','',true),('${id(3)}','Available','Mason','',true),('${id(4)}','Moved','Mason','',true),('${id(5)}','Inactive historical','Mason','',false),('${id(6)}','Unrelated inactive','Mason','',false),('${id(7)}','Requested worker','Mason','',false),('${id(8)}',' supervisor one ','Mason','',true);
 CREATE TABLE public.attendance(id uuid primary key,project_id uuid,worker_id uuid,date date,status text);INSERT INTO public.attendance VALUES
 ('${id(101)}','${site}','${id(4)}','2024-01-01','present'),('${id(102)}','${site}','${id(5)}','2024-01-01','present'),('${id(103)}','${other}','${id(2)}','2024-01-01','present');
 CREATE TABLE public.project_worker_assignments(project_id uuid,worker_id uuid,active boolean,unique(project_id,worker_id));INSERT INTO public.project_worker_assignments VALUES
 ('${site}','${id(1)}',true),('${other}','${id(2)}',true),('${site}','${id(4)}',false),('${other}','${id(4)}',true);
 CREATE TABLE public.advance_requests(worker_id uuid,project_id uuid,submitted_by uuid);
 INSERT INTO public.advance_requests VALUES ('${id(7)}','${site}','${s}');
 ALTER TABLE public.advance_requests ENABLE ROW LEVEL SECURITY;
 CREATE POLICY request_read ON public.advance_requests FOR SELECT TO authenticated USING (public.is_founder() OR submitted_by=auth.uid());
 CREATE POLICY request_insert ON public.advance_requests FOR INSERT TO authenticated WITH CHECK (EXISTS(SELECT FROM public.workers WHERE workers.id=advance_requests.worker_id AND workers.active));
 ALTER TABLE public.workers ENABLE ROW LEVEL SECURITY;ALTER TABLE public.attendance ENABLE ROW LEVEL SECURITY;ALTER TABLE public.project_worker_assignments ENABLE ROW LEVEL SECURITY;
 GRANT USAGE ON SCHEMA auth,public TO authenticated,anon,service_role;GRANT SELECT ON public.workers,public.attendance,public.project_worker_assignments,public.advance_requests TO authenticated;GRANT SELECT ON public.workers TO service_role;
 CREATE POLICY "Founders full access to workers" ON public.workers FOR ALL TO authenticated USING (public.is_founder());
 CREATE POLICY "Supervisors can view active workers" ON public.workers FOR SELECT TO authenticated USING (auth.uid() IS NOT NULL AND active = true);
 CREATE POLICY "mfa_session_required" ON public.workers AS RESTRICTIVE FOR ALL TO authenticated USING ((SELECT public.session_assurance_satisfied())) WITH CHECK ((SELECT public.session_assurance_satisfied()));
 CREATE POLICY attendance_read ON public.attendance FOR SELECT TO authenticated USING(public.is_founder() OR public.is_supervisor_assigned(project_id));
 CREATE POLICY assignment_read ON public.project_worker_assignments FOR SELECT TO authenticated USING(public.is_founder() OR public.is_supervisor_assigned(project_id));
 CREATE FUNCTION app_private.lock_project_worker_access(p_actor uuid,p_project uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$DECLARE r text;BEGIN SELECT role INTO r FROM public.users WHERE id=p_actor;IF r='supervisor' AND NOT EXISTS(SELECT FROM public.project_supervisors WHERE supervisor_id=p_actor AND project_id=p_project) THEN RAISE EXCEPTION 'Project access required' USING ERRCODE='42501'; ELSIF r IS NULL OR r NOT IN ('founder','supervisor') THEN RAISE EXCEPTION 'Project access required' USING ERRCODE='42501'; END IF;END$$;
 `);
 const guarded=readFileSync('supabase/migrations/20261112000000_guarded_single_project_worker.sql','utf8');const start=guarded.indexOf('CREATE FUNCTION public.available_project_workers_guarded(');if(start<0)throw Error('Missing guarded availability function');await db.exec(guarded.slice(start));return db;}
const ids=async(db:PGlite)=>(await db.query<{id:string}>('SELECT id FROM public.workers ORDER BY id')).rows.map(r=>r.id);
describe('worker visibility scoped to authorized project and historical attendance',()=>{
 it('restricts direct reads while preserving team, history, self, Founder, and guarded discovery',async()=>{const db=await setup();try{
  await db.exec(`BEGIN;${release}COMMIT;SET ROLE authenticated;SET test.uid='${s}';SET test.assurance='yes'`);
  expect(await ids(db)).toEqual([s,id(1),id(4),id(5),id(7),id(8)]);
  const history=await db.query<{name:string}>("SELECT w.name FROM public.attendance a LEFT JOIN public.workers w ON w.id=a.worker_id WHERE a.project_id=$1 ORDER BY w.name",[site]);expect(history.rows).toEqual([{name:'Inactive historical'},{name:'Moved'}]);
  const team=await db.query<{id:string}>('SELECT w.id FROM public.project_worker_assignments a JOIN public.workers w ON w.id=a.worker_id WHERE a.project_id=$1 AND a.active',[site]);expect(team.rows).toEqual([{id:id(1)}]);
  await expect(db.query('SELECT public.available_project_workers_guarded($1,$2)',[s,site])).rejects.toThrow(/permission denied/);
  await db.exec('RESET ROLE;SET ROLE service_role');const available=(await db.query<{v:{id:string}[]}>('SELECT public.available_project_workers_guarded($1,$2) v',[s,site])).rows[0].v;expect(available.map(w=>w.id).sort()).toEqual([id(3),id(8)]);
  await expect(db.query('SELECT public.available_project_workers_guarded($1,$2)',[s,other])).rejects.toThrow(/Project access required/);
  await db.exec(`RESET ROLE;SET ROLE authenticated;SET test.uid='${f}'`);expect(await ids(db)).toEqual([s,id(1),id(2),id(3),id(4),id(5),id(6),id(7),id(8)]);
  await db.exec(`SET test.uid='${s2}'`);expect(await ids(db)).toEqual([id(2),id(4)]);
  await db.exec("SET test.assurance='no'");expect(await ids(db)).toEqual([]);
  await db.exec(`RESET ROLE;DELETE FROM public.project_supervisors WHERE supervisor_id='${s}';SET ROLE authenticated;SET test.uid='${s}';SET test.assurance='yes'`);expect(await ids(db)).toEqual([s,id(7),id(8)]);
 }finally{await db.close();}},30000);
 it('refuses an unknown extra permissive read policy without changing the old policy',async()=>{const db=await setup();try{
  await db.exec('CREATE POLICY unexpected ON public.workers FOR SELECT TO authenticated USING (true)');
  await expect(db.exec(`BEGIN;${release}COMMIT;`)).rejects.toThrow(/policies changed/);await db.exec('ROLLBACK');
  expect((await db.query("SELECT policyname FROM pg_policies WHERE tablename='workers' AND policyname='Supervisors can view active workers'")).rows).toHaveLength(1);
 }finally{await db.close();}},30000);
});
