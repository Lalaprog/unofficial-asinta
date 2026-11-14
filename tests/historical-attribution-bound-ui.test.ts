// @vitest-environment jsdom
import React from 'react';
import {cleanup,fireEvent,render,screen,within,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({rpc:vi.fn()}));vi.mock('@/lib/supabase/client',()=>({createClient:()=>({rpc:m.rpc})}));
import {HistoricalWorkerAttribution} from '@/components/payroll/HistoricalWorkerAttribution';
import {historicalAttributionCaseBindingPreviewEnabled} from '@/lib/finance/featureAvailability';
import {snapshotFromExternal} from '@/lib/payroll/paidPeriodCases';
const id=(n:number)=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const actor=id(1),worker={id:id(2),name:'Worker',position:'Mason',active:true},source={request_id:id(3),worker_id:worker.id,period_start:'2024-11-03',period_end:'2024-11-09',paid_on:'2024-11-09',gross:'600.00',bale:'100.00',other_deductions:'0.00',net:'500.00',evidence_note:'Ledger checked',worker_snapshot:worker,recorded_by:actor,recorded_at:'2024-11-10T00:00:00Z'},sites=[{id:id(4),name:'Old Site'},{id:id(5),name:'Other Site'}],request=id(6);
const key=JSON.stringify(['historical-worker-attribution-v1',actor,source.request_id]);
const attempt={id:request,actor,source,split:[{project_id:sites[0].id,gross:'400.25'},{project_id:sites[1].id,gross:'199.75'}],note:'Original records'};
const found={found:true,request_id:request,source_id:source.request_id,source,source_changed:false,split:attempt.split,note:attempt.note,actor_id:actor,recorded_at:'2024-11-10T00:00:00Z',case_count:0};
const inventory={snapshot:snapshotFromExternal(source),total:0,items:[]};
let state:unknown={found:false},lost=false,binding:unknown={found:false};
const reply=async(name:string)=>{switch(name){case 'historical_worker_attribution_projects':return {data:{projects:sites},error:null};case 'historical_external_worker_lookup':return {data:source,error:null};case 'paid_period_assertion_case_list':return {data:{snapshot:snapshotFromExternal(source),total:0,items:[]},error:null};case 'historical_worker_attribution':return {data:state,error:null};case 'historical_attribution_case_binding':return {data:binding,error:null};case 'record_historical_attribution_with_cases':state=found;if(lost)throw Error('lost');return {data:{request_id:request,source_id:source.request_id,replayed:false},error:null};default:throw Error(name);}};
async function review(){const view=render(React.createElement(HistoricalWorkerAttribution,{actor,source,caseBinding:true}));fireEvent.click(screen.getByRole('button',{name:'Project attribution for this external week'}));fireEvent.click(screen.getByRole('button',{name:'Load attribution review'}));await screen.findByLabelText('Attribution project 1');return view;}
function fill(){fireEvent.change(screen.getByLabelText('Attribution project 1'),{target:{value:sites[0].id}});fireEvent.change(screen.getByLabelText('Project gross 1 (₱)'),{target:{value:'400.25'}});fireEvent.click(screen.getByRole('button',{name:'Add another project'}));fireEvent.change(screen.getByLabelText('Attribution project 2'),{target:{value:sites[1].id}});fireEvent.change(screen.getByLabelText('Project gross 2 (₱)'),{target:{value:'199.75'}});fireEvent.change(screen.getByLabelText('Attribution evidence note'),{target:{value:'Original records'}});fireEvent.click(screen.getByRole('button',{name:'Review project attribution'}));}
function confirm(){const dialog=screen.getByRole('dialog');expect((within(dialog).getByRole('button',{name:'Record attribution evidence'}) as HTMLButtonElement).disabled).toBe(true);fireEvent.click(within(dialog).getByRole('checkbox'));fireEvent.click(within(dialog).getByRole('button',{name:'Record attribution evidence'}));}
beforeEach(()=>{sessionStorage.clear();state={found:false};lost=false;binding={found:true,request_id:request,source_id:source.request_id,actor_id:actor,recorded_at:source.recorded_at,reviewed_cases:inventory,cases_changed:false,source_changed:false};m.rpc.mockReset().mockImplementation(reply);vi.spyOn(crypto,'randomUUID').mockReturnValue(request);});afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllEnvs();});
describe('held case-bound attribution interface',()=>{
 it('is explicitly gated and never enabled merely by the development cutover',()=>{
  vi.stubEnv('NEXT_PUBLIC_DEVELOPMENT_FINANCE_CUTOVER','true');vi.stubEnv('NEXT_PUBLIC_HISTORICAL_CASE_BINDING_PREVIEW','false');expect(historicalAttributionCaseBindingPreviewEnabled()).toBe(false);
  vi.stubEnv('NEXT_PUBLIC_FINANCE_FOUNDATION_PREVIEW','true');vi.stubEnv('NEXT_PUBLIC_HISTORICAL_EXTERNAL_WORKER_PREVIEW','true');vi.stubEnv('NEXT_PUBLIC_HISTORICAL_WORKER_ATTRIBUTION_ENTRY_PREVIEW','true');vi.stubEnv('NEXT_PUBLIC_HISTORICAL_CASE_BINDING_PREVIEW','true');expect(historicalAttributionCaseBindingPreviewEnabled()).toBe(true);
  vi.stubEnv('NEXT_PUBLIC_HISTORICAL_EXTERNAL_WORKER_PREVIEW','false');vi.stubEnv('NEXT_PUBLIC_DEVELOPMENT_FINANCE_CUTOVER','false');expect(historicalAttributionCaseBindingPreviewEnabled()).toBe(false);
 });
 it('sends reviewed cases and verifies original and binding before clearing the attempt',async()=>{
  await review();fill();confirm();await screen.findByText(/Attribution evidence recorded/);
  expect(m.rpc).toHaveBeenCalledWith('record_historical_attribution_with_cases',expect.objectContaining({p_request:request,p_cases:inventory}));
  expect(m.rpc).toHaveBeenCalledWith('historical_attribution_case_binding',{p_source:source.request_id});expect(sessionStorage.length).toBe(0);
  expect(m.rpc.mock.calls.some(([name])=>name==='record_historical_worker_attribution')).toBe(false);
 });
 it('keeps the exact retry if binding read is missing or differs even when the original exists',async()=>{
  lost=true;await review();fill();confirm();await screen.findByText(/Outcome not verified/);const saved=sessionStorage.getItem(key);expect(JSON.parse(saved!).version).toBe(2);
  binding={found:false};fireEvent.click(screen.getByRole('button',{name:'Check exact attribution'}));await screen.findByText(/Could not verify this exact attribution/);expect(sessionStorage.getItem(key)).toBe(saved);
  binding={found:true,request_id:request,source_id:source.request_id,actor_id:actor,recorded_at:source.recorded_at,reviewed_cases:inventory,cases_changed:true,source_changed:false};
  fireEvent.click(screen.getByRole('button',{name:'Check exact attribution'}));await screen.findByText(/original-period cases changed since the saved review/);expect(sessionStorage.length).toBe(0);
 });
 it('retains the bound attempt when the writer rejects a stale case inventory',async()=>{
  m.rpc.mockImplementation(async(name:string)=>name==='record_historical_attribution_with_cases'?{data:null,error:Error('case inventory changed')}:reply(name));
  await review();fill();confirm();await screen.findByText(/Outcome not verified/);const saved=sessionStorage.getItem(key);expect(saved).toBeTruthy();expect(JSON.parse(saved!).reviewed_cases).toEqual(inventory);
  fireEvent.click(screen.getByRole('button',{name:'Retry exact attribution'}));await screen.findByText(/Outcome not verified/);expect(sessionStorage.getItem(key)).toBe(saved);
  const writes=m.rpc.mock.calls.filter(([name])=>name==='record_historical_attribution_with_cases');expect(writes).toHaveLength(2);expect(writes[0][1]).toEqual(writes[1][1]);expect(m.rpc.mock.calls.some(([name])=>name==='record_historical_worker_attribution')).toBe(false);
 });
 it('does not clear a bound retry when verification returns after leaving the source',async()=>{
  let resolve!:(v:unknown)=>void;m.rpc.mockImplementation((name:string)=>name==='historical_attribution_case_binding'?new Promise(r=>{resolve=r;}):reply(name));
  await review();fill();confirm();await waitFor(()=>expect(m.rpc.mock.calls.some(([name])=>name==='historical_attribution_case_binding')).toBe(true));const saved=sessionStorage.getItem(key);expect(saved).toBeTruthy();cleanup();resolve({data:binding,error:null});
  await waitFor(()=>expect(sessionStorage.getItem(key)).toBe(saved));
  render(React.createElement(HistoricalWorkerAttribution,{actor,source,caseBinding:true}));fireEvent.click(screen.getByRole('button',{name:'Project attribution for this external week'}));expect(screen.getByRole('button',{name:'Retry exact attribution'})).toBeTruthy();expect(sessionStorage.getItem(key)).toBe(saved);
 });
 it('blocks a legacy retry instead of silently converting or submitting it',()=>{
  sessionStorage.setItem(key,JSON.stringify(attempt));render(React.createElement(HistoricalWorkerAttribution,{actor,source,caseBinding:true}));fireEvent.click(screen.getByRole('button',{name:'Project attribution for this external week'}));
  expect(screen.getByText(/cannot be silently upgraded/)).toBeTruthy();expect(screen.queryByRole('button',{name:'Load attribution review'})).toBeNull();expect(screen.queryByRole('button',{name:'Retry exact attribution'})).toBeNull();expect(m.rpc).not.toHaveBeenCalled();expect(sessionStorage.getItem(key)).toBe(JSON.stringify(attempt));
 });
 it('blocks a bound retry if the interface is switched back to legacy mode',()=>{
  const saved=JSON.stringify({version:2,attribution:attempt,reviewed_cases:inventory});sessionStorage.setItem(key,saved);render(React.createElement(HistoricalWorkerAttribution,{actor,source}));fireEvent.click(screen.getByRole('button',{name:'Project attribution for this external week'}));
  expect(screen.getByText(/cannot be silently upgraded/)).toBeTruthy();expect(screen.queryByRole('button',{name:'Load attribution review'})).toBeNull();expect(m.rpc).not.toHaveBeenCalled();expect(sessionStorage.getItem(key)).toBe(saved);
 });
});
