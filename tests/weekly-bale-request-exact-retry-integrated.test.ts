// @vitest-environment jsdom
// Synthetic SQL and mocked client transport; not hosted authentication or payment.
import React from 'react';
import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {cleanup,fireEvent,render,screen,within,waitFor} from '@testing-library/react';
import {afterEach,describe,expect,it,vi} from 'vitest';
const ids={founder:'10000000-0000-4000-8000-000000000001',supervisor:'10000000-0000-4000-8000-000000000002',worker:'10000000-0000-4000-8000-000000000003',site:'10000000-0000-4000-8000-000000000004'};
const mock=vi.hoisted(()=>({submit:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({replace:vi.fn()}),useSearchParams:()=>new URLSearchParams('tab=requests')}));
vi.mock('@/lib/auth/authContext',()=>({useAuth:()=>({user:{id:'10000000-0000-4000-8000-000000000002'},isFounder:false,isSupervisor:true})}));
vi.mock('@/lib/reminders/scheduler',()=>({getManilaClock:()=>({dateIso:'2026-11-15'})}));
vi.mock('@/components/ui/Toast',()=>({useToast:()=>({showToast:vi.fn()})}));
vi.mock('@/components/ui/Modal',()=>({Modal:({isOpen,title,children}:{isOpen:boolean;title:string;children:React.ReactNode})=>isOpen?React.createElement('div',{role:'dialog','aria-label':title},children):null}));
vi.mock('@/lib/finance/featureAvailability',()=>({weeklyBaleExpiryHealthPreviewEnabled:()=>false,weeklyBaleReleasePreviewEnabled:()=>true,weeklyBaleIdempotentSubmissionPreviewEnabled:()=>true,weeklyWorkerCutoverMode:()=>true}));
vi.mock('@/lib/attendance/useWeeklyBaleStatuses',()=>({useWeeklyBaleStatuses:()=>({data:{items:[]},loading:false,error:'',refresh:vi.fn()})}));
vi.mock('@/lib/attendance/useBaleProjectWorkers',()=>({useBaleProjectWorkers:(_u:string,p:string,enabled:boolean)=>({status:enabled&&p?'ready':'idle',workers:[{id:'10000000-0000-4000-8000-000000000003',name:'Synthetic worker',position:'Mason'}],someDetailsUnavailable:false,reload:vi.fn()})}));
vi.mock('@/lib/data/store',()=>({useDataStore:()=>({advanceRequests:[],projects:[{id:'10000000-0000-4000-8000-000000000004',name:'Synthetic site'}],workers:[],users:[],getProjectsForSupervisor:()=>[{id:'10000000-0000-4000-8000-000000000004',name:'Synthetic site'}],createAdvanceRequest:mock.submit,reviewAdvanceRequest:vi.fn(),approveAdvanceRequests:vi.fn(),issueAdvanceRequest:vi.fn()})}));
import {AdvanceRequestsPanel} from '@/components/advances/AdvanceRequestsPanel';
const sql=(p:string)=>readFileSync(p,'utf8');
afterEach(()=>{cleanup();sessionStorage.clear();vi.restoreAllMocks();});
async function fixture(){
 const db=new PGlite();
 await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE SCHEMA auth;
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('test.uid',true),'')::uuid$$;
 CREATE TABLE public.users(id uuid primary key,name text,email text,role text);CREATE TABLE public.workers(id uuid primary key,name text,active boolean);
 CREATE TABLE public.projects(id uuid primary key,name text);CREATE TABLE public.project_supervisors(project_id uuid,supervisor_id uuid,primary key(project_id,supervisor_id));
 CREATE TABLE public.project_worker_assignments(project_id uuid,worker_id uuid,active boolean,primary key(project_id,worker_id));
 CREATE TABLE public.advances(id uuid primary key default gen_random_uuid(),worker_id uuid,project_id uuid,amount numeric(10,2),amount_deducted numeric(10,2),reason text,date date,status text);
 CREATE TABLE public.payroll(id uuid primary key,worker_id uuid,period_start date,period_end date,status text);
 CREATE TABLE public.audit_log(actor_id uuid,actor_email text,action text,table_name text,record_id uuid,before_row jsonb,after_row jsonb);
 CREATE FUNCTION public.session_assurance_satisfied() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT current_setting('test.assurance',true)='yes'$$;
 CREATE FUNCTION public.current_user_role() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT role FROM public.users WHERE id=auth.uid()$$;
 CREATE FUNCTION public.is_founder() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT public.session_assurance_satisfied() AND public.current_user_role()='founder'$$;
 CREATE FUNCTION public.is_supervisor_assigned(p uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT public.session_assurance_satisfied() AND EXISTS(SELECT 1 FROM public.project_supervisors WHERE project_id=p AND supervisor_id=auth.uid())$$;
 GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role;GRANT SELECT ON public.workers TO authenticated;
 INSERT INTO public.users VALUES ('${ids.founder}','Founder','f@example.invalid','founder'),('${ids.supervisor}','Supervisor','s@example.invalid','supervisor');
 INSERT INTO public.workers VALUES ('${ids.worker}','Worker',true);INSERT INTO public.projects VALUES ('${ids.site}','Site');
 INSERT INTO public.project_supervisors VALUES ('${ids.site}','${ids.supervisor}');INSERT INTO public.project_worker_assignments VALUES ('${ids.site}','${ids.worker}',true);`);
 for(const p of ['supabase/migrations/20261013000000_advance_requests.sql','supabase/migrations/20261013000001_advance_request_notifications.sql','supabase/migrations/20261113000004_bale_request_site_guard.sql'])await db.exec(sql(p));
 const guard=sql('supabase/drafts/guard_legacy_bale_payment.sql');await db.exec(guard.slice(guard.indexOf('CREATE FUNCTION public.guard_new_advance_finalized_payroll()'),guard.indexOf('-- Keep the atomic implementation')));
 await db.exec(sql('supabase/drafts/weekly_bale_schedule.sql'));
 await db.exec(`BEGIN;SET LOCAL app.weekly_bale_idempotent_submission_reviewed='yes';${sql('supabase/drafts/weekly_bale_idempotent_submission.sql')} COMMIT;`);
 await db.exec(`CREATE OR REPLACE FUNCTION public.weekly_bale_clock() RETURNS timestamptz LANGUAGE sql VOLATILE SET search_path='' AS $$SELECT '2026-11-15T04:00:00Z'::timestamptz$$;
 SET test.uid='${ids.supervisor}';SET test.assurance='yes';SET ROLE authenticated;`);
 return db;
}
describe('exact Bale retry UI with synthetic SQL',()=>{
 it('replays the same committed request after a lost response and remount without a second notification',async()=>{
  const db=await fixture();let lost=true;const calls:string[]=[];
  try{
   mock.submit.mockImplementation(async(input:{request_id:string;worker_id:string;project_id:string;requested_amount:number;request_period_start:string})=>{
    calls.push(input.request_id);const r=(await db.query<{v:{request:Record<string,unknown>}}>('SELECT public.submit_weekly_bale_request($1,$2,$3,$4,$5) v',[input.request_id,input.worker_id,input.project_id,input.requested_amount,input.request_period_start])).rows[0].v;
    if(lost){lost=false;return null;}return {...r.request,requested_amount:Number(r.request.requested_amount)};
   });
   const view=render(React.createElement(AdvanceRequestsPanel));fireEvent.click(screen.getByRole('button',{name:'New Bale Request'}));
   const form=screen.getByRole('dialog',{name:'New Bale Request'});fireEvent.change(within(form).getByLabelText('Worker'),{target:{value:ids.worker}});fireEvent.change(within(form).getByLabelText('Requested amount (₱)'),{target:{value:'125.50'}});fireEvent.click(within(form).getByRole('button',{name:'Send to Founder'}));
   await screen.findByRole('button',{name:'Retry exact Bale request'});view.unmount();render(React.createElement(AdvanceRequestsPanel));fireEvent.click(await screen.findByRole('button',{name:'Retry exact Bale request'}));
   await waitFor(()=>expect(sessionStorage.getItem(`bale-request-unconfirmed-v1:${ids.supervisor}`)).toBeNull());expect(calls).toHaveLength(2);expect(calls[1]).toBe(calls[0]);
   await db.exec('RESET ROLE');expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.advance_requests WHERE id=$1',[calls[0]])).rows[0].n).toBe(1);
   expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.user_notifications WHERE advance_request_id=$1',[calls[0]])).rows[0].n).toBe(1);
   expect((await db.query<{n:number}>("SELECT count(*)::int n FROM public.audit_log WHERE table_name='advance_requests' AND record_id=$1",[calls[0]])).rows[0].n).toBe(1);
  }finally{await db.close();}
 },30000);
});
