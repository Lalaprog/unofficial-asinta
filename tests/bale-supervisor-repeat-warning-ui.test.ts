// @vitest-environment jsdom
import React from 'react';
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {AdvanceRequest} from '@/types';
import type {WeeklyBaleStatuses} from '@/lib/attendance/weeklyBaleStatus';

const mock=vi.hoisted(()=>({rows:[] as AdvanceRequest[],data:null as WeeklyBaleStatuses|null,submit:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({replace:vi.fn()}),useSearchParams:()=>new URLSearchParams('tab=requests')}));
vi.mock('@/lib/auth/authContext',()=>({useAuth:()=>({user:{id:'sup'},isFounder:false,isSupervisor:true})}));
vi.mock('@/components/ui/Toast',()=>({useToast:()=>({showToast:vi.fn()})}));
vi.mock('@/components/ui/Modal',()=>({Modal:({isOpen,title,children}:{isOpen:boolean;title:string;children:React.ReactNode})=>isOpen?React.createElement('div',{role:'dialog','aria-label':title},children):null}));
vi.mock('@/lib/finance/featureAvailability',()=>({weeklyBaleExpiryHealthPreviewEnabled:()=>false,weeklyBaleReleasePreviewEnabled:()=>true,weeklyBaleIdempotentSubmissionPreviewEnabled:()=>false,weeklyWorkerCutoverMode:()=>true}));
vi.mock('@/lib/attendance/useWeeklyBaleStatuses',()=>({useWeeklyBaleStatuses:()=>({data:mock.data,loading:!mock.data,error:'',refresh:vi.fn()})}));
vi.mock('@/lib/attendance/useBaleProjectWorkers',()=>({useBaleProjectWorkers:(_user:string,project:string,enabled:boolean)=>({status:enabled&&project?'ready':'idle',workers:[{id:'w1',name:'Ada',position:'Mason'},{id:'w2',name:'Ben',position:'Mason'}],someDetailsUnavailable:false,reload:vi.fn()})}));
const projects=[{id:'site',name:'Site A'},{id:'oldsite',name:'Previous Site'}];
vi.mock('@/lib/data/store',()=>({useDataStore:()=>({advanceRequests:mock.rows,projects,workers:[],users:[],getProjectsForSupervisor:()=>[projects[0]],createAdvanceRequest:mock.submit,reviewAdvanceRequest:vi.fn(),approveAdvanceRequests:vi.fn(),issueAdvanceRequest:vi.fn()})}));
import {AdvanceRequestsPanel} from '@/components/advances/AdvanceRequestsPanel';
const request=(id:string,worker:string,submitted='sup',status:AdvanceRequest['status']='pending_approval'):AdvanceRequest=>({id,worker_id:worker,project_id:'oldsite',submitted_by:submitted,status,requested_amount:125.5,approved_by:null,approved_at:null,rejected_by:null,rejected_at:null,issued_by:null,issued_at:null,issued_advance_id:null,created_at:'2026-11-15T00:00:00Z',updated_at:'2026-11-15T00:00:00Z'});
const statuses=(rows:AdvanceRequest[]):WeeklyBaleStatuses=>({as_of:'2026-11-14T16:30:00Z',items:rows.map(row=>({id:row.id,kind:'weekly',stored_status:row.status,effective_status:row.status,period_start:'2026-11-15',auto_expired:false,can_review:row.status==='pending_approval'}))});
beforeEach(()=>{sessionStorage.clear();mock.rows=[];mock.data=statuses([]);mock.submit.mockReset();});
afterEach(()=>{cleanup();sessionStorage.clear();});
function openForm(){fireEvent.click(screen.getByRole('button',{name:'New Bale Request'}));return screen.getByRole('dialog',{name:'New Bale Request'});}
describe('Supervisor possible earlier Bale request hint',()=>{
 it('warns for own non-rejected worker-week records, using the Manila date at the server snapshot',()=>{
  mock.rows=[request('own','w1'),request('other','w1','another-supervisor'),request('rejected','w1','sup','rejected')];mock.data=statuses(mock.rows);
  render(React.createElement(AdvanceRequestsPanel));const form=openForm();fireEvent.change(within(form).getByLabelText('Worker'),{target:{value:'w1'}});
  expect(within(form).getByText('Check earlier requests for this worker')).toBeTruthy();expect(within(form).getByText(/1 non-rejected request for the week starting 2026-11-15/)).toBeTruthy();
  expect(within(form).getByText(/Previous Site/)).toBeTruthy();expect(within(form).getByText(/Other Supervisors, old records or in-flight requests may not appear/)).toBeTruthy();
  fireEvent.change(within(form).getByLabelText('Worker'),{target:{value:'w2'}});expect(within(form).queryByText('Check earlier requests for this worker')).toBeNull();expect(within(form).getByText(/an empty list does not prove/)).toBeTruthy();expect(mock.submit).not.toHaveBeenCalled();
 });
 it('never claims no prior request when status data is unavailable or changed',()=>{
  mock.rows=[request('own','w1')];mock.data=null;const view=render(React.createElement(AdvanceRequestsPanel));const form=openForm();fireEvent.change(within(form).getByLabelText('Worker'),{target:{value:'w1'}});
  expect(within(form).queryByText('Check earlier requests for this worker')).toBeNull();expect(within(form).getByText(/Weekly status is unavailable/)).toBeTruthy();expect(within(form).getByText(/an empty list does not prove/)).toBeTruthy();
  mock.data=statuses(mock.rows);mock.data.items[0].stored_status='issued';view.rerender(React.createElement(AdvanceRequestsPanel));expect(within(form).queryByText('Check earlier requests for this worker')).toBeNull();expect(mock.submit).not.toHaveBeenCalled();
 });
 it('does not count expired, legacy or previous-week records, and does not block a deliberate request',async()=>{
  mock.rows=[request('expired','w1'),request('legacy','w1'),request('old','w1'),request('current','w1')];mock.data=statuses(mock.rows);
  mock.data.items[0].effective_status='expired_unapproved';mock.data.items[0].can_review=false;
  mock.data.items[1].kind='legacy';mock.data.items[1].period_start=null;mock.data.items[1].can_review=false;
  mock.data.items[2].period_start='2026-11-08';mock.submit.mockResolvedValue(null);
  render(React.createElement(AdvanceRequestsPanel));const form=openForm();fireEvent.change(within(form).getByLabelText('Worker'),{target:{value:'w1'}});
  expect(within(form).getByText(/1 non-rejected request for the week starting 2026-11-15/)).toBeTruthy();
  fireEvent.change(within(form).getByLabelText('Requested amount (₱)'),{target:{value:'75'}});fireEvent.click(within(form).getByRole('button',{name:'Send to Founder'}));
  expect(mock.submit).toHaveBeenCalledTimes(1);await screen.findByText(/A Bale request may have been sent/);
 });
});
