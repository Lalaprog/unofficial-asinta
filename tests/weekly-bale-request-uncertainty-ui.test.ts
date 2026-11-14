// @vitest-environment jsdom
import React from 'react';
import {PGlite} from '@electric-sql/pglite';
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';

const mock=vi.hoisted(()=>({submit:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({replace:vi.fn()}),useSearchParams:()=>new URLSearchParams('tab=requests')}));
vi.mock('@/lib/auth/authContext',()=>({useAuth:()=>({user:{id:'sup'},isFounder:false,isSupervisor:true})}));
vi.mock('@/components/ui/Toast',()=>({useToast:()=>({showToast:vi.fn()})}));
vi.mock('@/components/ui/Modal',()=>({Modal:({isOpen,title,children}:{isOpen:boolean;title:string;children:React.ReactNode})=>isOpen?React.createElement('div',{role:'dialog','aria-label':title},children):null}));
vi.mock('@/lib/finance/featureAvailability',()=>({weeklyBaleExpiryHealthPreviewEnabled:()=>false,weeklyBaleReleasePreviewEnabled:()=>true,weeklyWorkerCutoverMode:()=>true}));
vi.mock('@/lib/attendance/useWeeklyBaleStatuses',()=>({useWeeklyBaleStatuses:()=>({data:{items:[]},loading:false,error:'',refresh:vi.fn()})}));
vi.mock('@/lib/attendance/useBaleProjectWorkers',()=>({useBaleProjectWorkers:(_user:string,project:string,enabled:boolean)=>({status:enabled&&project?'ready':'idle',workers:[{id:'w1',name:'Ada',position:'Mason'}],someDetailsUnavailable:false,reload:vi.fn()})}));
const projects=[{id:'a',name:'Site A'}];
vi.mock('@/lib/data/store',()=>({useDataStore:()=>({advanceRequests:[],projects,workers:[],users:[],getProjectsForSupervisor:()=>projects,createAdvanceRequest:mock.submit,reviewAdvanceRequest:vi.fn(),approveAdvanceRequests:vi.fn(),issueAdvanceRequest:vi.fn()})}));
import {AdvanceRequestsPanel} from '@/components/advances/AdvanceRequestsPanel';
const markerKey='bale-request-unconfirmed-v1:sup';
beforeEach(()=>{sessionStorage.clear();mock.submit.mockReset();});
afterEach(()=>{cleanup();vi.restoreAllMocks();sessionStorage.clear();});
async function submit(){
 fireEvent.click(screen.getByRole('button',{name:'New Bale Request'}));
 const form=screen.getByRole('dialog',{name:'New Bale Request'});
 fireEvent.change(within(form).getByLabelText('Worker'),{target:{value:'w1'}});
 fireEvent.change(within(form).getByLabelText('Requested amount (₱)'),{target:{value:'125.50'}});
 fireEvent.click(within(form).getByRole('button',{name:'Send to Founder'}));
 await waitFor(()=>expect(mock.submit).toHaveBeenCalledTimes(1));
}
describe('weekly Bale submission uncertainty',()=>{
 it('retains an uncertainty warning across remount and requires deliberate review before another request',async()=>{
  mock.submit.mockResolvedValue(null);
  const view=render(React.createElement(AdvanceRequestsPanel));await submit();
  await screen.findByText(/A Bale request may have been sent/);
  expect(sessionStorage.getItem(markerKey)).toBeTruthy();expect((screen.getByRole('button',{name:'New Bale Request'}) as HTMLButtonElement).disabled).toBe(true);
  view.unmount();render(React.createElement(AdvanceRequestsPanel));
  await screen.findByText(/A Bale request may have been sent/);
  const clear=screen.getByRole('button',{name:'Clear warning after review'}) as HTMLButtonElement;expect(clear.disabled).toBe(true);
  fireEvent.click(screen.getByLabelText(/I investigated the earlier request/));fireEvent.click(clear);
  expect(sessionStorage.getItem(markerKey)).toBeNull();expect((screen.getByRole('button',{name:'New Bale Request'}) as HTMLButtonElement).disabled).toBe(false);
  expect(mock.submit).toHaveBeenCalledTimes(1);
 });
 it('holds a second submission when a synthetic database commit succeeds but its response is lost',async()=>{
  const db=new PGlite();try{
   await db.exec('CREATE TABLE requests (worker text, project text, amount numeric)');
   mock.submit.mockImplementation(async(input:{worker_id:string;project_id:string;requested_amount:number})=>{
    await db.query('INSERT INTO requests VALUES ($1,$2,$3)',[input.worker_id,input.project_id,input.requested_amount]);return null;
   });
   const view=render(React.createElement(AdvanceRequestsPanel));await submit();await screen.findByText(/A Bale request may have been sent/);
   view.unmount();render(React.createElement(AdvanceRequestsPanel));await screen.findByText(/A Bale request may have been sent/);
   fireEvent.click(screen.getByRole('button',{name:'New Bale Request'}));
   expect(mock.submit).toHaveBeenCalledTimes(1);expect((await db.query('SELECT count(*)::int n FROM requests')).rows[0]).toEqual({n:1});
  }finally{await db.close();}
 },30000);
 it('removes the warning only after a matching successful response',async()=>{
  mock.submit.mockResolvedValue({id:'request',worker_id:'w1',project_id:'a',submitted_by:'sup',requested_amount:125.5});
  render(React.createElement(AdvanceRequestsPanel));await submit();
  await waitFor(()=>expect(screen.queryByRole('dialog',{name:'New Bale Request'})).toBeNull());
  expect(sessionStorage.getItem(markerKey)).toBeNull();expect(screen.queryByText(/A Bale request may have been sent/)).toBeNull();
 });
 it('keeps the warning for a mismatched response instead of claiming confirmation',async()=>{
  mock.submit.mockResolvedValue({id:'request',worker_id:'other',project_id:'a',submitted_by:'sup',requested_amount:125.5});
  render(React.createElement(AdvanceRequestsPanel));await submit();
  await screen.findByText(/A Bale request may have been sent/);expect(sessionStorage.getItem(markerKey)).toBeTruthy();
 });
 it('does not discard a changed warning after an apparently successful response',async()=>{
  let resolve!:(value:unknown)=>void;mock.submit.mockReturnValue(new Promise(r=>{resolve=r;}));
  render(React.createElement(AdvanceRequestsPanel));await submit();
  expect(sessionStorage.getItem(markerKey)).toBeTruthy();
  sessionStorage.setItem(markerKey,'changed-by-another-operation');
  resolve({id:'request',worker_id:'w1',project_id:'a',submitted_by:'sup',requested_amount:125.5});
  await screen.findByText(/This tab cannot safely check/);
  expect(sessionStorage.getItem(markerKey)).toBe('changed-by-another-operation');
  expect((screen.getByRole('button',{name:'New Bale Request'}) as HTMLButtonElement).disabled).toBe(true);
 });
 it('does not send if browser storage cannot preserve the marker',async()=>{
  const spy=vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw Error('blocked');});
  render(React.createElement(AdvanceRequestsPanel));fireEvent.click(screen.getByRole('button',{name:'New Bale Request'}));
  const form=screen.getByRole('dialog',{name:'New Bale Request'});fireEvent.change(within(form).getByLabelText('Worker'),{target:{value:'w1'}});fireEvent.change(within(form).getByLabelText('Requested amount (₱)'),{target:{value:'125.50'}});fireEvent.click(within(form).getByRole('button',{name:'Send to Founder'}));
  await screen.findByText(/This tab cannot safely check/);expect(mock.submit).not.toHaveBeenCalled();spy.mockRestore();
 });
});
