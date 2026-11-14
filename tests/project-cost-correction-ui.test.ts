// @vitest-environment jsdom
import React from 'react';
import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {ProjectCostCorrectionPanel} from '@/components/payroll/ProjectCostCorrectionPanel';
const mocks=vi.hoisted(()=>({rpc:vi.fn(),user:'11111111-1111-4111-8111-111111111111',founder:true,assurance:'ready'}));
vi.mock('@/lib/auth/authContext',()=>({useAuth:()=>({user:{id:mocks.user},isFounder:mocks.founder,assurance:mocks.assurance})}));
vi.mock('@/lib/supabase/client',()=>({createClient:()=>({rpc:mocks.rpc})}));
const actor='11111111-1111-4111-8111-111111111111',worker='22222222-2222-4222-8222-222222222222',voucher='33333333-3333-4333-8333-333333333333',caseId='44444444-4444-4444-8444-444444444444',site='55555555-5555-4555-8555-555555555555',req='66666666-6666-4666-8666-666666666666';
const item={id:caseId,payroll_id:voucher,worker_id:worker,original_voucher:{id:voucher,worker_id:worker,period_start:'2024-12-01',period_end:'2024-12-07',status:'paid' as const,gross_pay:'600.00',bale_deduction:'100.00',other_deductions:'0.00',net_pay:'500.00'},difference:'-30.00',reason:'Reviewed',status:'no_transfer' as const,created_at:'2024-12-10T00:00:00Z',created_by:actor,resolved_at:'2024-12-11T00:00:00Z',resolved_by:actor,settled_on:null,resolution_note:'No transfer needed'};
const payload={source_kind:'voucher',case_id:caseId,case:item,latest_revision:0,attribution:null};
beforeEach(()=>{sessionStorage.clear();mocks.rpc.mockReset();mocks.user=actor;mocks.founder=true;mocks.assurance='ready';vi.stubGlobal('crypto',{randomUUID:()=>req});});
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.restoreAllMocks();});
function renderPanel(){return render(React.createElement(ProjectCostCorrectionPanel,{actor,kind:'voucher',item}));}
function loadMocks(){mocks.rpc.mockImplementation(async(name:string)=>name==='historical_worker_attribution_projects'?{data:{projects:[{id:site,name:'Site one'}]},error:null}:name==='project_cost_correction_attribution'?{data:payload,error:null}:{data:null,error:{message:'timeout'}});}
async function load(){fireEvent.click(screen.getByRole('button',{name:'Project-cost correction evidence'}));fireEvent.click(screen.getByRole('button',{name:'Load correction evidence'}));await screen.findByText('No correction site evidence has been recorded for this case.');}
async function prepare(){fireEvent.change(screen.getByLabelText('Total signed gross change (₱)'),{target:{value:'-12.50'}});fireEvent.click(screen.getByRole('button',{name:'Add correction site'}));fireEvent.change(screen.getByLabelText('Correction site 1'),{target:{value:site}});fireEvent.change(screen.getByLabelText('Signed site change 1 (₱)'),{target:{value:'-12.50'}});fireEvent.change(screen.getByLabelText('Correction evidence note'),{target:{value:'Original evidence checked'}});fireEvent.click(screen.getByRole('button',{name:'Review correction evidence'}));const dialog=screen.getByRole('dialog');expect((within(dialog).getByRole('button',{name:'Record correction evidence'}) as HTMLButtonElement).disabled).toBe(true);fireEvent.click(within(dialog).getByRole('checkbox'));return dialog;}
describe('correction evidence candidate UI',()=>{
 it('sends no money and retries the exact signed split after an uncertain outcome and remount',async()=>{
  loadMocks();const first=renderPanel();await load();const dialog=await prepare();fireEvent.click(within(dialog).getByRole('button',{name:'Record correction evidence'}));await screen.findByText(/Outcome not confirmed/);
  const calls=mocks.rpc.mock.calls.filter(x=>x[0]==='record_project_cost_correction_attribution');expect(calls).toHaveLength(1);expect(calls[0][1]).toMatchObject({p_request:req,p_kind:'voucher',p_case:caseId,p_gross_change:'-12.50',p_split:[{project_id:site,gross_change:'-12.50'}],p_ack:true});expect(sessionStorage.length).toBe(1);
  first.unmount();mocks.rpc.mockImplementation(async(name:string,p:Record<string,unknown>)=>name==='record_project_cost_correction_attribution'?{data:{request_id:p.p_request,source_kind:p.p_kind,case_id:p.p_case,revision:1,replayed:true},error:null}:{data:null,error:{message:'unexpected'}});
  renderPanel();fireEvent.click(screen.getByRole('button',{name:'Project-cost correction evidence'}));expect(screen.getByText(/A request may still complete/)).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:'Retry exact correction evidence'}));await screen.findByText(/Evidence recorded/);
  expect(mocks.rpc.mock.calls.filter(x=>x[0]==='record_project_cost_correction_attribution')[1][1]).toEqual(calls[0][1]);expect(sessionStorage.length).toBe(0);
 });
 it('rejects stale cases, mismatched totals, duplicates and unavailable storage before sending',async()=>{
  loadMocks();renderPanel();await load();fireEvent.change(screen.getByLabelText('Total signed gross change (₱)'),{target:{value:'10'}});fireEvent.change(screen.getByLabelText('Correction evidence note'),{target:{value:'Reviewed'}});fireEvent.click(screen.getByRole('button',{name:'Review correction evidence'}));expect(screen.getByText(/must add up/)).toBeTruthy();expect(mocks.rpc.mock.calls.filter(x=>x[0]==='record_project_cost_correction_attribution')).toHaveLength(0);
  fireEvent.change(screen.getByLabelText('Total signed gross change (₱)'),{target:{value:'0'}});fireEvent.click(screen.getByRole('button',{name:'Review correction evidence'}));const dialog=screen.getByRole('dialog');fireEvent.click(within(dialog).getByRole('checkbox'));vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw Error('blocked');});fireEvent.click(within(dialog).getByRole('button',{name:'Record correction evidence'}));await screen.findByText(/no request was sent/);expect(mocks.rpc.mock.calls.filter(x=>x[0]==='record_project_cost_correction_attribution')).toHaveLength(0);
 });
 it('hides evidence on assurance or identity change and ignores a late response',async()=>{
  let resolve!:(value:unknown)=>void;loadMocks();mocks.rpc.mockImplementation((name:string)=>name==='historical_worker_attribution_projects'?Promise.resolve({data:{projects:[]},error:null}):new Promise(r=>{resolve=r;}));
  const view=renderPanel();fireEvent.click(screen.getByRole('button',{name:'Project-cost correction evidence'}));fireEvent.click(screen.getByRole('button',{name:'Load correction evidence'}));mocks.assurance='required';view.rerender(React.createElement(ProjectCostCorrectionPanel,{actor,kind:'voucher',item}));expect(screen.queryByText(/gross cost effect/)).toBeNull();await act(async()=>resolve({data:payload,error:null}));expect(screen.queryByText(/No correction site evidence/)).toBeNull();
 });
 it('refuses to show a correction for a changed case',async()=>{
  loadMocks();mocks.rpc.mockImplementation(async(name:string)=>name==='historical_worker_attribution_projects'?{data:{projects:[]},error:null}:{data:{...payload,case:{...item,difference:'-31.00'}},error:null});renderPanel();fireEvent.click(screen.getByRole('button',{name:'Project-cost correction evidence'}));fireEvent.click(screen.getByRole('button',{name:'Load correction evidence'}));await screen.findByText(/could not be verified/);expect(screen.queryByLabelText('Total signed gross change (₱)')).toBeNull();
 });
});
