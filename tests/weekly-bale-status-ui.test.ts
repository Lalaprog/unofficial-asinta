// @vitest-environment jsdom
import React from 'react';
import {act,cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const mock=vi.hoisted(()=>({rpc:vi.fn(),review:vi.fn(),batch:vi.fn(),issue:vi.fn(),rows:[] as object[]}));
vi.mock('next/navigation',()=>({useRouter:()=>({replace:vi.fn()}),useSearchParams:()=>new URLSearchParams('tab=requests')}));
vi.mock('@/lib/auth/authContext',()=>({useAuth:()=>({user:{id:'founder'},isFounder:true,isSupervisor:false})}));
vi.mock('@/lib/supabase/client',()=>({createClient:()=>({rpc:mock.rpc})}));
vi.mock('@/components/ui/Toast',()=>({useToast:()=>({showToast:vi.fn()})}));
vi.mock('@/lib/attendance/useBaleProjectWorkers',()=>({useBaleProjectWorkers:()=>({status:'idle',workers:[]})}));
const projects=[{id:'site',name:'Test Site'}],workers=[{id:'worker',name:'Ada',position:'Mason',active:true}],users=[{id:'sup',name:'Supervisor'}];
vi.mock('@/lib/data/store',()=>({useDataStore:()=>({advanceRequests:mock.rows,projects,workers,users,getProjectsForSupervisor:()=>projects,createAdvanceRequest:vi.fn(),reviewAdvanceRequest:mock.review,approveAdvanceRequests:mock.batch,issueAdvanceRequest:mock.issue})}));
import {AdvanceRequestsPanel} from '@/components/advances/AdvanceRequestsPanel';
const request=(id:string,status='pending_approval')=>({id,worker_id:'worker',project_id:'site',requested_amount:100,submitted_by:'sup',status,created_at:'2026-11-15T04:00:00Z',updated_at:'2026-11-15T04:00:00Z',approved_at:null,rejected_at:status==='rejected'?'2026-11-18T00:00:00Z':null,issued_at:null});
const status=(id:string,stored_status:string,effective_status:string,can_review:boolean,auto_expired=false)=>({id,kind:'weekly',period_start:'2026-11-15',stored_status,effective_status,can_review,auto_expired});
const response=(items:object[])=>({data:{as_of:'2026-11-18T00:00:00Z',items},error:null});
beforeEach(()=>{mock.rpc.mockReset();mock.review.mockReset();mock.batch.mockReset();mock.issue.mockReset();mock.rows=[request('r1')];vi.stubEnv('NEXT_PUBLIC_FINANCE_FOUNDATION_PREVIEW','true');vi.stubEnv('NEXT_PUBLIC_WEEKLY_BALE_RELEASE_PREVIEW','true');});
afterEach(()=>{cleanup();vi.unstubAllEnvs();});
describe('weekly request status in legacy list',()=>{
 it('labels expired pending requests and blocks all approval paths',async()=>{
  mock.rpc.mockResolvedValue(response([status('r1','pending_approval','expired_unapproved',false)]));render(React.createElement(AdvanceRequestsPanel));
  await screen.findByText('Expired · awaiting recorded rejection');expect(screen.getByText(/recorded rejection may be pending/)).toBeTruthy();
  expect((screen.getByRole('button',{name:'Approve'}) as HTMLButtonElement).disabled).toBe(true);expect((screen.getByRole('button',{name:'Reject'}) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('checkbox',{name:/Select Ada request/}) as HTMLInputElement).disabled).toBe(true);expect(mock.review).not.toHaveBeenCalled();expect(mock.batch).not.toHaveBeenCalled();
 });
 it('distinguishes recorded automatic rejection and hides the old issue path',async()=>{
  mock.rows=[request('r1','rejected'),request('r2','approved_pending_payment')];mock.rpc.mockResolvedValue(response([status('r1','rejected','rejected',false,true),status('r2','approved_pending_payment','approved_pending_payment',false)]));
  render(React.createElement(AdvanceRequestsPanel));fireEvent.change(screen.getByLabelText('Request status'),{target:{value:'all'}});
  await screen.findByText('Automatically rejected');expect(screen.getByText(/Automatically rejected after the approval window/)).toBeTruthy();expect(screen.queryByRole('button',{name:'Confirm paid & issue'})).toBeNull();expect(mock.issue).not.toHaveBeenCalled();
 });
 it('permits a verified in-window review but disables it after a failed refresh',async()=>{
  mock.rpc.mockResolvedValueOnce(response([status('r1','pending_approval','pending_approval',true)])).mockResolvedValueOnce({data:null,error:{message:'Unavailable'}});mock.review.mockResolvedValue(true);
  render(React.createElement(AdvanceRequestsPanel));await screen.findByText(/Weekly decision status/);
  const approve=screen.getByRole('button',{name:'Approve'}) as HTMLButtonElement;await act(async()=>{await Promise.resolve();});expect(approve.disabled).toBe(false);
  fireEvent.click(screen.getByRole('button',{name:'Refresh weekly status'}));await screen.findByRole('alert');expect(approve.disabled).toBe(true);fireEvent.click(approve);expect(mock.review).not.toHaveBeenCalled();
 });
 it('retains old UI without making a status request when flags are off',()=>{
  vi.stubEnv('NEXT_PUBLIC_WEEKLY_BALE_RELEASE_PREVIEW','false');render(React.createElement(AdvanceRequestsPanel));expect(mock.rpc).not.toHaveBeenCalled();expect((screen.getByRole('button',{name:'Approve'}) as HTMLButtonElement).disabled).toBe(false);
 });
 it('holds decisions and old issuance when cutover is on but the weekly Bale gate is missing',()=>{
  vi.stubEnv('NEXT_PUBLIC_WEEKLY_WORKER_CUTOVER_PREVIEW','true');vi.stubEnv('NEXT_PUBLIC_WEEKLY_BALE_RELEASE_PREVIEW','false');mock.rows=[request('r1'),request('r2','approved_pending_payment')];
  render(React.createElement(AdvanceRequestsPanel));expect(screen.getByRole('alert').textContent).toMatch(/Requests and decisions are held/);expect((screen.getByRole('button',{name:'Approve'}) as HTMLButtonElement).disabled).toBe(true);expect(screen.queryByRole('button',{name:'Confirm paid & issue'})).toBeNull();expect(mock.review).not.toHaveBeenCalled();expect(mock.issue).not.toHaveBeenCalled();
 });
 it('discards a previous request list response after the rows change',async()=>{
  let resolve!:(value:unknown)=>void;const old=new Promise(r=>{resolve=r;});mock.rpc.mockReturnValueOnce(old).mockResolvedValueOnce(response([status('r2','pending_approval','expired_unapproved',false)]));
  const view=render(React.createElement(AdvanceRequestsPanel));mock.rows=[request('r2')];view.rerender(React.createElement(AdvanceRequestsPanel));
  await screen.findByText('Expired · awaiting recorded rejection');await act(async()=>resolve(response([status('r1','pending_approval','pending_approval',true)])));
  expect((screen.getByRole('button',{name:'Approve'}) as HTMLButtonElement).disabled).toBe(true);
 });
 it('prevents stale server snapshots from authorizing a changed cached record',async()=>{
  mock.rpc.mockResolvedValue(response([status('r1','approved_pending_payment','approved_pending_payment',false)]));render(React.createElement(AdvanceRequestsPanel));
  await screen.findByText(/Weekly status unavailable or changed/);const row=screen.getByText('Ada').closest('article')!;expect((within(row).getByRole('button',{name:'Approve'}) as HTMLButtonElement).disabled).toBe(true);
 });
});
