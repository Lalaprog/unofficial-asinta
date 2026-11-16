// @vitest-environment jsdom
import React from 'react';
import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const mock=vi.hoisted(()=>({rpc:vi.fn()}));
vi.mock('@/lib/supabase/client',()=>({createClient:()=>({rpc:mock.rpc})}));
import {WorkerCategoryManager} from '@/components/workforce/WorkerCategoryManager';
const id=(n:number)=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
const founder=id(1),cat={id:id(2),label:'Mason',archived:false,revision:1};
const open=()=>fireEvent.click(screen.getByRole('button',{name:/Worker category catalog/}));
const event={request_id:id(3),actor_id:founder,action:'add',before_label:null,before_archived:null,after_label:'Mason',after_archived:false,after_revision:1,occurred_at:'2026-10-15T12:00:00+00:00'};
beforeEach(()=>{mock.rpc.mockReset();sessionStorage.clear();});
afterEach(()=>{cleanup();vi.restoreAllMocks();});
describe('draft category manager',()=>{
 it('loads only on request, confirms archive, and displays read-only change history',async()=>{
  mock.rpc.mockImplementation(async(name:string)=>name==='worker_category_catalog'?{data:[cat],error:null}:name==='worker_category_history'?{data:{items:[event],has_more:false},error:null}:{data:{...cat,archived:true,revision:2,replayed:false},error:null});
  render(React.createElement(WorkerCategoryManager,{userId:founder}));expect(mock.rpc).not.toHaveBeenCalled();open();
  expect(screen.getByText(/does not change existing worker positions/)).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:'Load catalog'}));await screen.findByText('Mason');
  fireEvent.click(screen.getByRole('button',{name:'Category change history'}));fireEvent.click(screen.getByRole('button',{name:'Load history'}));await screen.findByText(/New → Mason/);
  fireEvent.click(screen.getByRole('button',{name:'Archive Mason'}));expect(mock.rpc).toHaveBeenCalledTimes(2);expect(screen.getByText(/Existing workers will not be changed/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'Confirm archive'}));await screen.findByText(/Change recorded/);
  expect(mock.rpc).toHaveBeenLastCalledWith('change_worker_category',expect.objectContaining({p_category_id:cat.id,p_action:'archive',p_label:null,p_expected_revision:1,p_request_id:expect.any(String)}));
 });
 it('recovers an uncertain change with the same request ID after reopening, allowing read-only inspection',async()=>{
  let calls=0;
  mock.rpc.mockImplementation(async(name:string,p:Record<string,unknown>)=>{
   if(name==='worker_category_catalog')return {data:[cat],error:null};
   if(name==='worker_category_history')return {data:{items:[event],has_more:false},error:null};
   calls++;return calls===1?{data:null,error:{message:'network timeout'}}:{data:{id:p.p_category_id,label:p.p_label,archived:false,revision:2,replayed:true},error:null};
  });
  render(React.createElement(WorkerCategoryManager,{userId:founder}));open();fireEvent.click(screen.getByRole('button',{name:'Load catalog'}));await screen.findByText('Mason');
  fireEvent.click(screen.getByRole('button',{name:'Rename Mason'}));fireEvent.change(screen.getByLabelText('Rename Mason'),{target:{value:'Senior Mason'}});fireEvent.click(screen.getByRole('button',{name:'Save name'}));
  await screen.findByText(/outcome is not confirmed/);const first=mock.rpc.mock.calls.find(([name])=>name==='change_worker_category')![1];
  expect(sessionStorage.getItem(`worker-category-attempt:${founder}`)).toBeTruthy();
  open();open();expect(screen.getByText(/Unconfirmed rename request/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'Load catalog'}));await screen.findByText('Mason');
  fireEvent.click(screen.getByRole('button',{name:'Category change history'}));fireEvent.click(screen.getByRole('button',{name:'Load history'}));await screen.findByText(/New → Mason/);
  expect((screen.getByRole('button',{name:'Add category'}) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button',{name:'Retry same request'}));await screen.findByText(/original request was confirmed/);
  const changeCalls=mock.rpc.mock.calls.filter(([name])=>name==='change_worker_category');expect(changeCalls).toHaveLength(2);expect(changeCalls[1][1]).toEqual(first);expect(sessionStorage.getItem(`worker-category-attempt:${founder}`)).toBeNull();
 });
 it('refuses new changes if catalog read fails or local recovery data is invalid',async()=>{
  mock.rpc.mockResolvedValue({data:null,error:{message:'missing'}});const view=render(React.createElement(WorkerCategoryManager,{userId:founder}));open();fireEvent.click(screen.getByRole('button',{name:'Load catalog'}));await screen.findByRole('alert');expect(screen.queryByRole('button',{name:'Add category'})).toBeNull();
  view.unmount();sessionStorage.setItem(`worker-category-attempt:${founder}`,'{bad json');render(React.createElement(WorkerCategoryManager,{userId:founder}));open();await screen.findByRole('alert');expect((screen.getByRole('button',{name:'Load catalog'}) as HTMLButtonElement).disabled).toBe(false);
 });
 it('prevents duplicate sends while the first request is in flight',async()=>{
  let resolve!:(result:unknown)=>void;const deferred=new Promise(r=>{resolve=r;});
  mock.rpc.mockImplementation((name:string)=>name==='worker_category_catalog'?Promise.resolve({data:[cat],error:null}):deferred);
  render(React.createElement(WorkerCategoryManager,{userId:founder}));open();fireEvent.click(screen.getByRole('button',{name:'Load catalog'}));await screen.findByText('Mason');
  fireEvent.change(screen.getByLabelText('New category'),{target:{value:'Carpenter'}});const button=screen.getByRole('button',{name:'Add category'});fireEvent.click(button);fireEvent.click(button);
  expect(mock.rpc.mock.calls.filter(([name])=>name==='change_worker_category')).toHaveLength(1);
  const args=mock.rpc.mock.calls.find(([name])=>name==='change_worker_category')![1];await act(async()=>resolve({data:{id:args.p_category_id,label:'Carpenter',revision:1,archived:false,replayed:false},error:null}));
  await waitFor(()=>expect(screen.getByText(/Change recorded/)).toBeTruthy());
 });
 it('requires explicit confirmation before stopping an unconfirmed retry',async()=>{
  sessionStorage.setItem(`worker-category-attempt:${founder}`,JSON.stringify({requestId:id(9),categoryId:cat.id,action:'archive',label:null,expectedRevision:1}));
  render(React.createElement(WorkerCategoryManager,{userId:founder}));open();await screen.findByText(/Unconfirmed archive request/);
  fireEvent.click(screen.getByRole('button',{name:'Review before stopping retry'}));const button=screen.getByRole('button',{name:'I checked; stop retrying'});expect(within(button).getByText('I checked; stop retrying')).toBeTruthy();expect(screen.getByText(/does not undo any server change/)).toBeTruthy();fireEvent.click(button);
  expect(sessionStorage.getItem(`worker-category-attempt:${founder}`)).toBeNull();expect(screen.getByText(/Retry stopped/)).toBeTruthy();
 });
});
