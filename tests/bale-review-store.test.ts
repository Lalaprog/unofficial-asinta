// @vitest-environment jsdom
import React from 'react';
import {act,cleanup,render,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';

const m=vi.hoisted(()=>({decision:vi.fn(),toast:vi.fn(),rows:[] as any[],user:{id:'founder',role:'founder'},assurance:'ready'}));
vi.mock('@/lib/auth/authContext',()=>({useAuth:()=>({user:m.user,assurance:m.assurance,isLoading:false})}));
vi.mock('@/components/ui/Toast',()=>({useToast:()=>({showToast:m.toast})}));
vi.mock('@/lib/supabase/client',()=>({createClient:()=>({
 rpc:(name:string,args:unknown)=>name==='visible_projects'?{order:async()=>({data:[],error:null})}:m.decision(name,args),
 from:(table:string)=>({select:()=>{
  if(table==='advance_requests'){
   let statuses:readonly string[]=[];
   const builder={in:(_field:string,value:string[])=>{statuses=value;return builder;},order:()=>builder,range:async(from:number,to:number)=>{const rows=m.rows.filter(row=>statuses.includes(row.status));return {data:rows.slice(from,to+1),count:rows.length,error:null};}};return builder;
  }
  const read=async()=>({data:[],error:null});return {order:read,then:(resolve:(x:unknown)=>void,reject:(x:unknown)=>void)=>read().then(resolve,reject)};
 }}),
})}));
import {DataStoreProvider,useDataStore} from '@/lib/data/store';
let store:ReturnType<typeof useDataStore>;
function Probe(){store=useDataStore();return null;}
const request=(id:string)=>({id,worker_id:'worker',project_id:'site',submitted_by:'supervisor',requested_amount:'100.00',status:'pending_approval',approved_by:null,approved_at:null,rejected_by:null,rejected_at:null,created_at:'2026-11-15T00:00:00Z',updated_at:'2026-11-15T00:00:00Z'});
const approved=(id:string)=>({...request(id),status:'approved_pending_payment',approved_by:'founder',approved_at:'2026-11-17T00:00:00Z',updated_at:'2026-11-17T00:00:00Z'});
async function setup(){render(React.createElement(DataStoreProvider,null,React.createElement(Probe)));await waitFor(()=>expect(store.isLoaded).toBe(true));}
beforeEach(()=>{sessionStorage.clear();m.rows=[request('a'),request('b')];m.user={id:'founder',role:'founder'};m.assurance='ready';m.decision.mockReset();m.toast.mockReset();});
afterEach(()=>cleanup());
describe('Bale review store confirmations',()=>{
 it('publishes a matching returned decision but not a different request or status',async()=>{
  await setup();m.decision.mockResolvedValueOnce({data:approved('b'),error:null});
  await act(async()=>expect(await store.reviewAdvanceRequest('a','approve')).toBe(false));
  expect(store.advanceRequests.find(row=>row.id==='a')?.status).toBe('pending_approval');
  expect(m.toast).toHaveBeenCalledWith('error',expect.stringContaining('may have been recorded'));
  m.decision.mockResolvedValueOnce({data:approved('a'),error:null});
  await act(async()=>expect(await store.reviewAdvanceRequest('a','approve')).toBe(true));
  expect(store.advanceRequests.find(row=>row.id==='a')?.status).toBe('approved_pending_payment');
 });
 it('rejects a same-size batch with duplicates and never claims success',async()=>{
  await setup();m.decision.mockResolvedValueOnce({data:[approved('a'),approved('a')],error:null});
  await act(async()=>expect(await store.approveAdvanceRequests(['a','b'])).toBe(false));
  expect(store.advanceRequests.map(row=>row.status)).toEqual(['pending_approval','pending_approval']);
  expect(m.toast).toHaveBeenCalledWith('error',expect.stringContaining('check every request'));
 });
 it('accepts an exact reordered batch',async()=>{
  await setup();m.decision.mockResolvedValueOnce({data:[approved('b'),approved('a')],error:null});
  await act(async()=>expect(await store.approveAdvanceRequests(['a','b'])).toBe(true));
  expect(store.advanceRequests.map(row=>row.status)).toEqual(['approved_pending_payment','approved_pending_payment']);
 });
 it('does not overwrite newer refreshed state when a response arrives late',async()=>{
  await setup();let resolve!:(x:unknown)=>void;m.decision.mockReturnValueOnce(new Promise(r=>{resolve=r}));
  let pending!:Promise<boolean>;act(()=>{pending=store.reviewAdvanceRequest('a','approve')});
  m.rows=[{...approved('a'),status:'issued',updated_at:'2026-11-18T00:00:00Z'},request('b')];
  await act(async()=>store.refresh());
  await act(async()=>{resolve({data:approved('a'),error:null});await pending});
  expect(store.advanceRequests.find(row=>row.id==='a')?.status).toBe('issued');
 });
 it('rereads a confirmed exact submission and restores count-backed coverage',async()=>{
  await setup();const created={...request('new'),submitted_by:'founder'};
  m.decision.mockImplementationOnce(async()=>{m.rows=[created,...m.rows];return {data:{request:created,replayed:false},error:null}});
  await act(async()=>expect(await store.createAdvanceRequest({worker_id:'worker',project_id:'site',requested_amount:100,request_id:'new',request_period_start:'2026-11-15'})).not.toBeNull());
  await waitFor(()=>expect(store.baleRequestCoverage).toEqual({openOmitted:0,historyOmitted:0}));
  expect(store.advanceRequests.map(row=>row.id)).toContain('new');
 });
 it('does not merge a submission response into a different account',async()=>{
  const view=render(React.createElement(DataStoreProvider,null,React.createElement(Probe)));await waitFor(()=>expect(store.isLoaded).toBe(true));
  let resolve!:(x:unknown)=>void;m.decision.mockReturnValueOnce(new Promise(r=>{resolve=r}));let pending!:ReturnType<typeof store.createAdvanceRequest>;
  act(()=>{pending=store.createAdvanceRequest({worker_id:'worker',project_id:'site',requested_amount:100,request_id:'new',request_period_start:'2026-11-15'})});
  m.user={id:'other',role:'founder'};m.rows=[];view.rerender(React.createElement(DataStoreProvider,null,React.createElement(Probe)));
  await waitFor(()=>expect(store.isLoaded && store.advanceRequests.length===0).toBe(true));
  await act(async()=>{resolve({data:{request:{...request('new'),submitted_by:'founder'},replayed:false},error:null});expect(await pending).toBeNull()});
  expect(store.advanceRequests).toHaveLength(0);
 });
 it('does not update the new session from an old response',async()=>{
  const view=render(React.createElement(DataStoreProvider,null,React.createElement(Probe)));await waitFor(()=>expect(store.isLoaded).toBe(true));
  let resolve!:(x:unknown)=>void;m.decision.mockReturnValueOnce(new Promise(r=>{resolve=r}));let pending!:Promise<boolean>;
  act(()=>{pending=store.reviewAdvanceRequest('a','approve')});
  m.user={id:'other',role:'founder'};m.rows=[];view.rerender(React.createElement(DataStoreProvider,null,React.createElement(Probe)));
  await waitFor(()=>expect(store.isLoaded && store.advanceRequests.length===0).toBe(true));
  await act(async()=>{resolve({data:approved('a'),error:null});expect(await pending).toBe(false)});
  expect(store.advanceRequests).toHaveLength(0);
 });
});
