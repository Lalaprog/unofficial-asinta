// @vitest-environment jsdom
import React from 'react';
import {act,cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const mock=vi.hoisted(()=>({rpc:vi.fn(),review:vi.fn(),batch:vi.fn(),issue:vi.fn(),rows:[] as object[],coverage:null as null | {openOmitted:number;historyOmitted:number}}));
vi.mock('next/navigation',()=>({useRouter:()=>({replace:vi.fn()}),useSearchParams:()=>new URLSearchParams('tab=requests')}));
vi.mock('@/lib/auth/authContext',()=>({useAuth:()=>({user:{id:'founder'},isFounder:true,isSupervisor:false})}));
vi.mock('@/lib/supabase/client',()=>({createClient:()=>({rpc:mock.rpc})}));
vi.mock('@/components/ui/Toast',()=>({useToast:()=>({showToast:vi.fn()})}));
vi.mock('@/lib/attendance/useBaleProjectWorkers',()=>({useBaleProjectWorkers:()=>({status:'idle',workers:[]})}));
const projects=[{id:'site',name:'Test Site'}],workers=[{id:'worker',name:'Ada',position:'Mason',active:true}],users=[{id:'sup',name:'Supervisor'}];
vi.mock('@/lib/data/store',()=>({useDataStore:()=>({advanceRequests:mock.rows,baleRequestCoverage:mock.coverage,projects,workers,users,getProjectsForSupervisor:()=>projects,createAdvanceRequest:vi.fn(),reviewAdvanceRequest:mock.review,approveAdvanceRequests:mock.batch,issueAdvanceRequest:mock.issue})}));
import {AdvanceRequestsPanel} from '@/components/advances/AdvanceRequestsPanel';
const request=(id:string,status='pending_approval')=>({id,worker_id:'worker',project_id:'site',requested_amount:100,submitted_by:'sup',status,created_at:'2026-11-15T04:00:00Z',updated_at:'2026-11-15T04:00:00Z',approved_at:null,rejected_at:status==='rejected'?'2026-11-18T00:00:00Z':null,issued_at:null});
const status=(id:string,stored_status:string,effective_status:string,can_review:boolean,auto_expired=false)=>({id,kind:'weekly',period_start:'2026-11-15',stored_status,effective_status,can_review,auto_expired});
const response=(items:object[])=>({data:{as_of:'2026-11-18T00:00:00Z',items},error:null});
beforeEach(()=>{sessionStorage.clear();mock.rpc.mockReset();mock.review.mockReset();mock.batch.mockReset();mock.issue.mockReset();mock.coverage=null;mock.rows=[request('r1')];vi.stubEnv('NEXT_PUBLIC_FINANCE_FOUNDATION_PREVIEW','true');vi.stubEnv('NEXT_PUBLIC_WEEKLY_BALE_RELEASE_PREVIEW','true');vi.stubEnv('NEXT_PUBLIC_WEEKLY_WORKER_ACTIONS_PREVIEW','true');vi.stubEnv('NEXT_PUBLIC_WEEKLY_WORKER_CUTOVER_PREVIEW','true');});
afterEach(()=>{cleanup();sessionStorage.clear();vi.restoreAllMocks();vi.unstubAllEnvs();});
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
  vi.stubEnv('NEXT_PUBLIC_WEEKLY_WORKER_CUTOVER_PREVIEW','false');vi.stubEnv('NEXT_PUBLIC_WEEKLY_BALE_RELEASE_PREVIEW','false');render(React.createElement(AdvanceRequestsPanel));expect(mock.rpc).not.toHaveBeenCalled();expect((screen.getByRole('button',{name:'Approve'}) as HTMLButtonElement).disabled).toBe(false);
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
 it('warns the Founder about another loaded request in the same week on the row and batch confirmation',async()=>{
  mock.rows=[request('r1'),request('r2','approved_pending_payment')];mock.rpc.mockResolvedValue(response([status('r1','pending_approval','pending_approval',true),status('r2','approved_pending_payment','approved_pending_payment',false)]));
  render(React.createElement(AdvanceRequestsPanel));
  await screen.findAllByText(/Possible repeated requests: 2/);const row=document.getElementById('advance-request-r1')!;
  fireEvent.click(within(row).getByRole('checkbox'));fireEvent.click(screen.getByRole('button',{name:'Approve selected (1)'}));
  const dialog=screen.getByRole('dialog',{name:'Approve selected Bale requests?'});expect(within(dialog).getByText('Check possible repeated requests before approval')).toBeTruthy();expect(within(dialog).getByText(/Ada · week of 2026-11-15 · 2 requests/)).toBeTruthy();expect(mock.batch).not.toHaveBeenCalled();
 });
 it('warns when the loaded queue omits open or historical requests',async()=>{
  mock.coverage={openOmitted:8,historyOmitted:600};mock.rpc.mockResolvedValue(response([status('r1','pending_approval','pending_approval',true)]));
  render(React.createElement(AdvanceRequestsPanel));
  expect(screen.getByText(/8 open and 600 historical requests were outside this loaded view/)).toBeTruthy();
  expect(screen.getByText(/filters and duplicate hints cannot find omitted records/)).toBeTruthy();
 });
 it('checks more than 500 loaded requests and holds every decision if a later batch fails',async()=>{
  mock.rows=Array.from({length:501},(_,i)=>request(`r${String(i).padStart(3,'0')}`,i===500?'pending_approval':i===0?'approved_pending_payment':'rejected'));
  let failing=false;
  mock.rpc.mockImplementation(async(_name:string,{p_ids}:{p_ids:string[]})=>{
   if(failing && p_ids.length===1)return {data:null,error:{message:'offline'}};
   return response(p_ids.map(id=>{const row=mock.rows.find((r:any)=>r.id===id) as {status:string};return status(id,row.status,row.status,row.status==='pending_approval');}));
  });
  render(React.createElement(AdvanceRequestsPanel));
  await screen.findAllByText(/Possible repeated requests: 2/);
  expect(mock.rpc.mock.calls.map(call=>call[1].p_ids.length)).toEqual([500,1]);
  const row=document.getElementById('advance-request-r500')!;
  expect((within(row).getByRole('button',{name:'Approve'}) as HTMLButtonElement).disabled).toBe(false);
  failing=true;fireEvent.click(screen.getByRole('button',{name:'Refresh weekly status'}));
  await screen.findByText(/Weekly status unavailable: offline/);
  expect((within(row).getByRole('button',{name:'Approve'}) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(within(row).getByRole('button',{name:'Approve'}));expect(mock.review).not.toHaveBeenCalled();
 });
 it('clears a saved warning after a confirmed response in the same view',async()=>{
  mock.rpc.mockResolvedValue(response([status('r1','pending_approval','pending_approval',true)]));mock.review.mockResolvedValue(true);
  render(React.createElement(AdvanceRequestsPanel));await screen.findByRole('button',{name:'Approve'});await act(async()=>{await Promise.resolve();});
  fireEvent.click(screen.getByRole('button',{name:'Approve'}));
  await act(async()=>{await Promise.resolve();});
  expect(mock.review).toHaveBeenCalledWith('r1','approve');
  expect(sessionStorage.getItem(JSON.stringify(['weekly-bale-review-unconfirmed-v1','founder']))).toBeNull();
  expect(screen.queryByText(/A Bale review may have been recorded/)).toBeNull();
 });
 it('holds a lost review across remount until the Founder investigates',async()=>{
  mock.rpc.mockResolvedValue(response([status('r1','pending_approval','pending_approval',true)]));mock.review.mockResolvedValue(false);
  const view=render(React.createElement(AdvanceRequestsPanel));const approve=await screen.findByRole('button',{name:'Approve'});
  await act(async()=>{await Promise.resolve();});expect((approve as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(approve);await screen.findByText(/A Bale review may have been recorded/);
  expect(mock.review).toHaveBeenCalledTimes(1);expect((approve as HTMLButtonElement).disabled).toBe(true);
  view.unmount();render(React.createElement(AdvanceRequestsPanel));await screen.findByText(/A Bale review may have been recorded/);
  expect(screen.getByText(/request IDs: r1/)).toBeTruthy();
  fireEvent.click(screen.getByRole('checkbox',{name:/I investigated each request/}));
  fireEvent.click(screen.getByRole('button',{name:'Clear Bale review warning'}));
  expect(screen.queryByText(/A Bale review may have been recorded/)).toBeNull();
 });
 it('holds a failed batch and identifies every affected request',async()=>{
  mock.rows=[request('r1'),request('r2')];mock.rpc.mockResolvedValue(response([status('r1','pending_approval','pending_approval',true),status('r2','pending_approval','pending_approval',true)]));mock.batch.mockResolvedValue(false);
  render(React.createElement(AdvanceRequestsPanel));await screen.findAllByText(/Possible repeated requests: 2/);
  fireEvent.click(within(document.getElementById('advance-request-r1')!).getByRole('checkbox'));
  fireEvent.click(within(document.getElementById('advance-request-r2')!).getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button',{name:'Approve selected (2)'}));fireEvent.click(within(screen.getByRole('dialog')).getByRole('button',{name:'Approve 2 requests'}));
  await screen.findByText(/A Bale review may have been recorded/);
  expect(screen.getByText(/request IDs: r1, r2/)).toBeTruthy();expect(mock.batch).toHaveBeenCalledWith(['r1','r2']);
  expect((within(document.getElementById('advance-request-r1')!).getByRole('button',{name:'Approve'}) as HTMLButtonElement).disabled).toBe(true);
 });
 it('keeps a warning on unmount even when the response later succeeds',async()=>{
  mock.rpc.mockResolvedValue(response([status('r1','pending_approval','pending_approval',true)]));let resolve!:(success:boolean)=>void;mock.review.mockReturnValue(new Promise(r=>{resolve=r}));
  const view=render(React.createElement(AdvanceRequestsPanel));await screen.findByRole('button',{name:'Approve'});await act(async()=>{await Promise.resolve();});
  fireEvent.click(screen.getByRole('button',{name:'Approve'}));await screen.findByText(/A Bale review may have been recorded/);
  const key=JSON.stringify(['weekly-bale-review-unconfirmed-v1','founder']),raw=sessionStorage.getItem(key);view.unmount();
  await act(async()=>resolve(true));expect(sessionStorage.getItem(key)).toBe(raw);
 });
 it('does not submit a review when tab storage cannot save its warning',async()=>{
  mock.rpc.mockResolvedValue(response([status('r1','pending_approval','pending_approval',true)]));render(React.createElement(AdvanceRequestsPanel));
  await screen.findByRole('button',{name:'Approve'});await act(async()=>{await Promise.resolve();});
  vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw Error('unavailable')});
  fireEvent.click(screen.getByRole('button',{name:'Approve'}));await screen.findByText(/cannot safely check its Bale review warning/);expect(mock.review).not.toHaveBeenCalled();
 });
 it('does not clear changed warning evidence after a matching response',async()=>{
  mock.rpc.mockResolvedValue(response([status('r1','pending_approval','pending_approval',true)]));let resolve!:(success:boolean)=>void;mock.review.mockReturnValue(new Promise(r=>{resolve=r}));
  render(React.createElement(AdvanceRequestsPanel));await screen.findByRole('button',{name:'Approve'});await act(async()=>{await Promise.resolve();});fireEvent.click(screen.getByRole('button',{name:'Approve'}));
  const key=JSON.stringify(['weekly-bale-review-unconfirmed-v1','founder']);sessionStorage.setItem(key,'changed');
  await act(async()=>resolve(true));await screen.findByText(/cannot safely check its Bale review warning/);expect(sessionStorage.getItem(key)).toBe('changed');
 });
 it('prevents stale server snapshots from authorizing a changed cached record',async()=>{
  mock.rpc.mockResolvedValue(response([status('r1','approved_pending_payment','approved_pending_payment',false)]));render(React.createElement(AdvanceRequestsPanel));
  await screen.findByText(/Weekly status unavailable or changed/);const row=screen.getByText('Ada').closest('article')!;expect((within(row).getByRole('button',{name:'Approve'}) as HTMLButtonElement).disabled).toBe(true);
 });
});
