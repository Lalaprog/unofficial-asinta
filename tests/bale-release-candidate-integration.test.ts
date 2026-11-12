// @vitest-environment jsdom
import React from 'react';
import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const mock=vi.hoisted(()=>({submit:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({replace:vi.fn()}),useSearchParams:()=>new URLSearchParams('tab=requests')}));
vi.mock('@/lib/auth/authContext',()=>({useAuth:()=>({user:{id:'sup'},isFounder:false,isSupervisor:true})}));
vi.mock('@/components/ui/Toast',()=>({useToast:()=>({showToast:vi.fn()})}));
vi.mock('@/components/ui/Modal',()=>({Modal:({isOpen,title,children}:{isOpen:boolean;title:string;children:React.ReactNode})=>isOpen?React.createElement('div',{role:'dialog','aria-label':title},children):null}));
const projects=[{id:'a',name:'Site A'},{id:'b',name:'Site B'}];
vi.mock('@/lib/data/store',()=>({useDataStore:()=>({advanceRequests:[],projects,workers:[{id:'w1',name:'Ada',position:'Mason',active:true},{id:'w2',name:'Ben',position:'Carpenter',active:true}],users:[],getProjectsForSupervisor:()=>projects,createAdvanceRequest:mock.submit,reviewAdvanceRequest:vi.fn(),approveAdvanceRequests:vi.fn(),issueAdvanceRequest:vi.fn()})}));
import {AdvanceRequestsPanel} from '@/components/advances/AdvanceRequestsPanel';
const response=(ids:string[],ok=true)=>({ok,json:async()=>({workerIds:ids})});
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}
beforeEach(()=>{mock.submit.mockReset().mockResolvedValue({id:'synthetic'});});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
function open(){render(React.createElement(AdvanceRequestsPanel));fireEvent.click(screen.getByRole('button',{name:'New Bale Request'}));return screen.getByRole('dialog',{name:'New Bale Request'});}
describe('default-off candidate Bale form with real scoped-team hook',()=>{
 it('fetches the selected site, ignores stale responses, and only submits the current site worker',async()=>{
  const a=deferred<ReturnType<typeof response>>(),b=deferred<ReturnType<typeof response>>();const fetchMock=vi.fn().mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);vi.stubGlobal('fetch',fetchMock);
  const form=open();fireEvent.change(within(form).getByLabelText('Project site'),{target:{value:'a'}});await waitFor(()=>expect(fetchMock).toHaveBeenCalledTimes(1));
  fireEvent.change(within(form).getByLabelText('Project site'),{target:{value:'b'}});await waitFor(()=>expect(fetchMock).toHaveBeenCalledTimes(2));
  expect(fetchMock.mock.calls.map(c=>c[0])).toEqual(['/api/projects/a/workers','/api/projects/b/workers']);
  expect((within(form).getByRole('button',{name:'Send to Founder'}) as HTMLButtonElement).disabled).toBe(true);
  await act(async()=>b.resolve(response(['w2'])));await waitFor(()=>expect(within(form).getByRole('option',{name:'Ben · Carpenter'})).toBeTruthy());
  await act(async()=>a.resolve(response(['w1'])));expect(within(form).queryByRole('option',{name:'Ada · Mason'})).toBeNull();
  fireEvent.change(within(form).getByLabelText('Worker'),{target:{value:'w2'}});fireEvent.change(within(form).getByLabelText('Requested amount (₱)'),{target:{value:'125.50'}});fireEvent.click(within(form).getByRole('button',{name:'Send to Founder'}));
  await waitFor(()=>expect(mock.submit).toHaveBeenCalledWith({worker_id:'w2',project_id:'b',requested_amount:125.5}));
 });
 it('warns when only some assigned workers have loaded details instead of presenting the list as complete',async()=>{
  const fetchMock=vi.fn().mockResolvedValue(response(['w1','missing-worker']));vi.stubGlobal('fetch',fetchMock);
  const form=open();fireEvent.change(within(form).getByLabelText('Project site'),{target:{value:'a'}});
  await within(form).findByRole('option',{name:'Ada · Mason'});
  expect(within(form).getByText(/Some assigned worker details are not in the loaded list/)).toBeTruthy();
  expect(mock.submit).not.toHaveBeenCalled();
 });
 it('fails closed on a duplicate, incomplete, or failed team response and can retry',async()=>{
  const fetchMock=vi.fn().mockResolvedValueOnce(response(['w1','w1'])).mockResolvedValueOnce(response([],false)).mockResolvedValueOnce(response(['w1']));vi.stubGlobal('fetch',fetchMock);
  const form=open();fireEvent.change(within(form).getByLabelText('Project site'),{target:{value:'a'}});await within(form).findByRole('alert');
  expect((within(form).getByRole('button',{name:'Send to Founder'}) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(within(form).getByRole('button',{name:'Try again'}));await waitFor(()=>expect(fetchMock).toHaveBeenCalledTimes(2));await within(form).findByRole('alert');
  fireEvent.click(within(form).getByRole('button',{name:'Try again'}));await within(form).findByRole('option',{name:'Ada · Mason'});expect(mock.submit).not.toHaveBeenCalled();
 });
});
