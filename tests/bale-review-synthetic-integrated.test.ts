// @vitest-environment jsdom
// Disposable PGlite and mocked transport; no hosted accounts or payment.
import React from 'react';
import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,describe,expect,it,vi} from 'vitest';
import type {AdvanceRequest} from '@/types';
import {verifyBaleReviewRows} from '@/lib/attendance/baleReview';
const ids={founder:'10000000-0000-4000-8000-000000000001',supervisor:'10000000-0000-4000-8000-000000000002',worker:'10000000-0000-4000-8000-000000000003',site:'10000000-0000-4000-8000-000000000004',request:'10000000-0000-4000-8000-000000000005'};
const m=vi.hoisted(()=>({review:vi.fn(),row:null as AdvanceRequest|null}));
vi.mock('next/navigation',()=>({useRouter:()=>({replace:vi.fn()}),useSearchParams:()=>new URLSearchParams('tab=requests')}));
vi.mock('@/lib/auth/authContext',()=>({useAuth:()=>({user:{id:'10000000-0000-4000-8000-000000000001'},isFounder:true,isSupervisor:false})}));
vi.mock('@/components/ui/Toast',()=>({useToast:()=>({showToast:vi.fn()})}));
vi.mock('@/lib/finance/featureAvailability',()=>({weeklyBaleExpiryHealthPreviewEnabled:()=>false,weeklyBaleReleasePreviewEnabled:()=>true,weeklyBaleIdempotentSubmissionPreviewEnabled:()=>false,weeklyWorkerCutoverMode:()=>true}));
vi.mock('@/lib/attendance/useWeeklyBaleStatuses',()=>({useWeeklyBaleStatuses:()=>({data:{as_of:'2026-11-15T04:00:00Z',items:[{id:'10000000-0000-4000-8000-000000000005',kind:'weekly',stored_status:'pending_approval',effective_status:'pending_approval',period_start:'2026-11-15',auto_expired:false,can_review:true}]},loading:false,error:'',refresh:vi.fn()})}));
vi.mock('@/lib/attendance/useBaleProjectWorkers',()=>({useBaleProjectWorkers:()=>({status:'idle',workers:[]})}));
vi.mock('@/lib/data/store',()=>({useDataStore:()=>({advanceRequests:m.row?[m.row]:[],projects:[{id:'10000000-0000-4000-8000-000000000004',name:'Site'}],workers:[{id:'10000000-0000-4000-8000-000000000003',name:'Worker'}],users:[],getProjectsForSupervisor:()=>[],createAdvanceRequest:vi.fn(),reviewAdvanceRequest:m.review,approveAdvanceRequests:vi.fn(),issueAdvanceRequest:vi.fn()})}));
import {AdvanceRequestsPanel} from '@/components/advances/AdvanceRequestsPanel';
const sql=(p:string)=>readFileSync(p,'utf8');
afterEach(()=>{cleanup();sessionStorage.clear();vi.restoreAllMocks()});
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
 for(const p of ['supabase/migrations/20261013000000_advance_requests.sql','supabase/migrations/20261013000001_advance_request_notifications.sql','supabase/migrations/20261113000004_bale_request_site_guard.sql']) await db.exec(sql(p));
 // Model Supabase's authenticated table grant; RLS and triggers still apply.
 await db.exec('GRANT SELECT, INSERT ON public.advance_requests TO authenticated');
 const guard=sql('supabase/drafts/guard_legacy_bale_payment.sql');await db.exec(guard.slice(guard.indexOf('CREATE FUNCTION public.guard_new_advance_finalized_payroll()'),guard.indexOf('-- Keep the atomic implementation')));
 await db.exec(sql('supabase/drafts/weekly_bale_schedule.sql'));
 await db.exec(`CREATE OR REPLACE FUNCTION public.weekly_bale_clock() RETURNS timestamptz LANGUAGE sql VOLATILE SET search_path='' AS $$SELECT '2026-11-15T04:00:00Z'::timestamptz$$;
 SET test.uid='${ids.supervisor}';SET test.assurance='yes';SET ROLE authenticated;`);
 const row=(await db.query<{v:AdvanceRequest}>('INSERT INTO public.advance_requests(id,worker_id,project_id,requested_amount,submitted_by) VALUES($1,$2,$3,125.50,$4) RETURNING to_jsonb(advance_requests) v',[ids.request,ids.worker,ids.site,ids.supervisor])).rows[0].v;
 await db.exec(`SET test.uid='${ids.founder}'`);
 return {db,row:{...row,requested_amount:Number(row.requested_amount)}};
}
describe('Founder Bale review with synthetic database',()=>{
 it('holds review after SQL commits but its response is lost, and prevents a second decision',async()=>{
  sessionStorage.clear();const {db,row}=await fixture();m.row=row;m.review.mockReset();let observed:unknown;
  try{
   m.review.mockImplementation(async()=>{observed=(await db.query<{v:unknown}>('SELECT to_jsonb(public.review_advance_request($1,$2)) v',[ids.request,'approve'])).rows[0].v;return false;});
   const view=render(React.createElement(AdvanceRequestsPanel));await waitFor(()=>expect((screen.getByRole('button',{name:'Approve'}) as HTMLButtonElement).disabled).toBe(false));
   fireEvent.click(screen.getByRole('button',{name:'Approve'}));await screen.findByText(/A Bale review may have been recorded/);
   expect(verifyBaleReviewRows([observed],[row],'approve',ids.founder)[0].status).toBe('approved_pending_payment');
   view.unmount();render(React.createElement(AdvanceRequestsPanel));await screen.findByText(/A Bale review may have been recorded/);
   expect((screen.getByRole('button',{name:'Approve'}) as HTMLButtonElement).disabled).toBe(true);expect(m.review).toHaveBeenCalledTimes(1);
   const stored=await db.query<{status:string}>('SELECT status FROM public.advance_requests WHERE id=$1',[ids.request]);expect(stored.rows[0].status).toBe('approved_pending_payment');
  }finally{await db.close();}
 },30000);
});
