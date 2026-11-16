// @vitest-environment jsdom
import React from 'react';
import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {describe,expect,it,vi} from 'vitest';
const {rpc}=vi.hoisted(()=>({rpc:vi.fn()}));
vi.mock('@/lib/supabase/client',()=>({createClient:()=>({rpc})}));
import {ProjectWorkerMove} from '@/components/projects/ProjectWorkerMove';
const founder='00000000-0000-0000-0000-000000000001',worker='00000000-0000-0000-0000-000000000003',site='00000000-0000-0000-0000-000000000004',other='00000000-0000-0000-0000-000000000005';
const sql=(p:string)=>readFileSync(p,'utf8');
describe('atomic move UI with synthetic database',()=>{
 it('recovers a lost response by replaying one real move with one history pair',async()=>{
  const db=new PGlite();try{
   await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE SCHEMA auth;CREATE SCHEMA app_private;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('test.uid',true),'')::uuid$$;
    CREATE FUNCTION public.session_assurance_satisfied() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT current_setting('test.assurance',true)='yes'$$;
    CREATE TABLE public.users(id uuid primary key,role text,email text);INSERT INTO public.users VALUES('${founder}','founder','f@example.invalid');
    CREATE FUNCTION public.is_founder() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT EXISTS(SELECT FROM public.users WHERE id=auth.uid() AND role='founder')$$;
    CREATE TABLE public.projects(id uuid primary key,name text);INSERT INTO public.projects VALUES('${site}','A'),('${other}','B');
    CREATE TABLE public.workers(id uuid primary key,name text,active boolean);INSERT INTO public.workers VALUES('${worker}','Ada',true);
    CREATE TABLE public.project_worker_assignments(project_id uuid REFERENCES public.projects(id),worker_id uuid REFERENCES public.workers(id),active boolean,updated_at timestamptz,updated_by uuid,PRIMARY KEY(project_id,worker_id));INSERT INTO public.project_worker_assignments VALUES('${site}','${worker}',true,now(),'${founder}');
    CREATE TABLE public.audit_log(actor_id uuid,actor_email text,action text,table_name text,record_id uuid,before_row jsonb,after_row jsonb);
    CREATE FUNCTION app_private.lock_founder_guard() RETURNS void LANGUAGE sql AS $$SELECT$$;CREATE FUNCTION app_private.lock_project_worker_access(uuid,uuid) RETURNS void LANGUAGE sql AS $$SELECT$$;
    GRANT USAGE ON SCHEMA public,auth,app_private TO anon,authenticated,service_role;`);
   await db.exec(sql('supabase/migrations/20261107000006_guarded_worker_removal.sql'));await db.exec(sql('supabase/migrations/20261112000000_guarded_single_project_worker.sql'));
   await db.exec(`BEGIN;${sql('supabase/drafts/project_assignment_history.sql')} COMMIT;BEGIN;${sql('supabase/drafts/atomic_worker_move.sql')} COMMIT;SET ROLE authenticated;SET test.uid='${founder}';SET test.assurance='yes'`);
   sessionStorage.clear();rpc.mockReset();let first=true;
   rpc.mockImplementation(async(name:string,args:{p_request:string;p_worker:string;p_from:string;p_to:string})=>{
    if(name!=='move_worker_project')throw Error('unexpected RPC');
    const result=(await db.query<{v:unknown}>('SELECT public.move_worker_project($1,$2,$3,$4) v',[args.p_request,args.p_worker,args.p_from,args.p_to])).rows[0].v;
    if(first){first=false;return {data:null,error:{message:'synthetic lost response'}};}return {data:result,error:null};
   });
   const done=vi.fn().mockResolvedValue(true);
   render(React.createElement(ProjectWorkerMove,{actorId:founder,projectId:site,workers:[{id:worker,name:'Ada'}],projects:[{id:site,name:'A'},{id:other,name:'B'}],onCompleted:done}));
   fireEvent.click(screen.getByRole('button',{name:'Move a worker to another project'}));fireEvent.change(screen.getByLabelText('Worker on this project'),{target:{value:worker}});fireEvent.change(screen.getByLabelText('Destination project'),{target:{value:other}});fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(screen.getByRole('button',{name:'Confirm move'}));
   fireEvent.click(await screen.findByRole('button',{name:'Retry same move'}));await screen.findByText(/original move was confirmed/);
   expect(rpc.mock.calls[0][1]).toEqual(rpc.mock.calls[1][1]);expect(done).toHaveBeenCalledOnce();
   await db.exec('RESET ROLE');expect((await db.query('SELECT project_id FROM public.project_worker_assignments WHERE worker_id=$1 AND active',[worker])).rows).toEqual([{project_id:other}]);
   expect((await db.query('SELECT event_type FROM public.project_assignment_history ORDER BY event_type')).rows).toEqual([{event_type:'assigned'},{event_type:'baseline_active'},{event_type:'unassigned'}]);
   expect((await db.query('SELECT count(*)::int n FROM public.worker_move_requests')).rows[0]).toEqual({n:1});
  }finally{cleanup();sessionStorage.clear();await db.close();}
 },30000);
});
