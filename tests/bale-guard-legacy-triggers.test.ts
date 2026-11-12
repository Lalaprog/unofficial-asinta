import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
const id=(n:number)=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
const [founder,supervisor,worker,project,otherProject]=[1,2,3,4,5].map(id);
const migration=(name:string)=>readFileSync(`supabase/migrations/${name}`,'utf8');

describe('Bale site guard with legacy audit and notification triggers',()=>{
 it('keeps legitimate request and review transactional without creating an advance',async()=>{
  const db=new PGlite();try{
   await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('test.uid',true),'')::uuid$$;
    CREATE TABLE public.users(id uuid primary key,name text,email text,role text);
    CREATE TABLE public.workers(id uuid primary key,name text,active boolean);
    CREATE TABLE public.projects(id uuid primary key,name text);
    CREATE TABLE public.project_supervisors(project_id uuid,supervisor_id uuid,primary key(project_id,supervisor_id));
    CREATE TABLE public.project_worker_assignments(project_id uuid,worker_id uuid,active boolean,primary key(project_id,worker_id));
    CREATE TABLE public.advances(id uuid primary key default gen_random_uuid(),worker_id uuid,project_id uuid,amount numeric,amount_deducted numeric,reason text,date date,status text);
    CREATE TABLE public.audit_log(id uuid primary key default gen_random_uuid(),actor_id uuid,actor_email text,action text,table_name text,record_id uuid,before_row jsonb,after_row jsonb);
    CREATE FUNCTION public.session_assurance_satisfied() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT current_setting('test.assurance',true)='yes'$$;
    CREATE FUNCTION public.current_user_role() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT role FROM public.users WHERE id=auth.uid()$$;
    CREATE FUNCTION public.is_founder() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT public.session_assurance_satisfied() AND public.current_user_role()='founder'$$;
    CREATE FUNCTION public.is_supervisor_assigned(p uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT public.session_assurance_satisfied() AND EXISTS(SELECT 1 FROM public.project_supervisors WHERE project_id=p AND supervisor_id=auth.uid())$$;
    GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role;
    GRANT SELECT ON public.workers TO authenticated;
    INSERT INTO public.users VALUES ('${founder}','Founder','founder@example.invalid','founder'),('${supervisor}','Supervisor','supervisor@example.invalid','supervisor');
    INSERT INTO public.workers VALUES ('${worker}','Worker',true); INSERT INTO public.projects VALUES ('${project}','Site'),('${otherProject}','Other site');
    INSERT INTO public.project_supervisors VALUES ('${project}','${supervisor}'); INSERT INTO public.project_worker_assignments VALUES ('${project}','${worker}',true);`);
   await db.exec(migration('20261013000000_advance_requests.sql'));
   await db.exec(migration('20261013000001_advance_request_notifications.sql'));
   await db.exec(migration('20261113000004_bale_request_site_guard.sql'));
   await db.exec(`SET test.uid='${supervisor}'; SET test.assurance='yes'; SET ROLE authenticated;`);
   const insert=await db.query<{id:string}>(`INSERT INTO public.advance_requests(worker_id,project_id,requested_amount,submitted_by) VALUES ($1,$2,123.45,$3) RETURNING id`,[worker,project,supervisor]);
   const requestId=insert.rows[0].id;
   await expect(db.query(`INSERT INTO public.advance_requests(worker_id,project_id,requested_amount,submitted_by) VALUES ($1,$2,123.45,$3)`,[worker,otherProject,supervisor])).rejects.toThrow(/Project access/);
   await expect(db.query(`INSERT INTO public.advance_requests(worker_id,project_id,requested_amount,submitted_by,created_at) VALUES ($1,$2,123.45,$3,now())`,[worker,project,supervisor])).rejects.toThrow(/permission denied/);
   await db.exec(`SET test.uid='${founder}'`);
   await db.query(`SELECT public.review_advance_request($1,'approve')`,[requestId]);
   await db.exec('RESET ROLE');
   const audit=await db.query<{action:string;actor_id:string;table_name:string}>('SELECT action,actor_id,table_name FROM public.audit_log ORDER BY CASE action WHEN \'insert\' THEN 0 ELSE 1 END');
   expect(audit.rows).toEqual([{action:'insert',actor_id:supervisor,table_name:'advance_requests'},{action:'update',actor_id:founder,table_name:'advance_requests'}]);
   expect((await db.query<{recipient_id:string;event_type:string}>('SELECT recipient_id,event_type FROM public.user_notifications ORDER BY event_type')).rows).toEqual([{recipient_id:supervisor,event_type:'advance_request_approved'},{recipient_id:founder,event_type:'advance_request_submitted'}]);
   expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.advances')).rows[0].n).toBe(0);
   expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.advance_requests')).rows[0].n).toBe(1);
  }finally{await db.close();}
 },30000);
});
