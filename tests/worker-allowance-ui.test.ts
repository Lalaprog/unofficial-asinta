// @vitest-environment jsdom
import React from 'react';
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const mock=vi.hoisted(()=>({rpc:vi.fn()}));
vi.mock('@/lib/supabase/client',()=>({createClient:()=>({rpc:mock.rpc})}));
vi.mock('@/lib/auth/authContext',()=>({useAuth:()=>({user:{id:'founder'},isFounder:true})}));
import {AllowanceDialog} from '@/components/attendance/AllowanceDialog';
import {WorkerAllowanceQueue} from '@/components/payroll/WorkerAllowanceQueue';
import type {HistoryRecord} from '@/lib/attendance/history';
import {allowanceAttemptKey} from '@/lib/payroll/allowanceAttempt';
const rec={id:'a',worker_id:'w',project_id:'p',date:'2026-11-01',status:'present',hours_worked:8,notes:null,recorded_by:'u',is_founder_override:false,submitted_at:'2026-11-01T08:00:00Z',created_at:'2026-11-01T08:00:00Z',worker_name:'Ada',worker_position:'Mason',project_name:'Site',is_supervisor:false} satisfies HistoryRecord;
const pending={id:'x',worker_name:'Ada',worker_position:'Mason',project_name:'Site',date:'2026-11-01',amount:'100.25',description:'Meals',submitted_at:'2026-11-01T10:00:00Z',stale:false,finalized:false};
beforeEach(()=>{mock.rpc.mockReset();sessionStorage.clear();});afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllEnvs();sessionStorage.clear();});
describe('worker allowance UI',()=>{
 it('submits a Supervisor allowance only after loading and clearly says it is not payroll',async()=>{
  mock.rpc.mockImplementation(async(name:string,p:Record<string,string>)=>name==='worker_allowances_for_attendance'?{data:[],error:null}:{data:{id:p.p_id,status:'pending',replayed:false},error:null});
  render(React.createElement(AllowanceDialog,{record:rec,isFounder:false,onClose:vi.fn()}));await screen.findByText('No allowances recorded.');
  expect(screen.getByText(/not yet added to the legacy payroll/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Allowance amount (₱)'),{target:{value:'100.25'}});fireEvent.change(screen.getByLabelText('Allowance purpose'),{target:{value:'Meals'}});fireEvent.click(screen.getByRole('button',{name:'Submit for approval'}));
  await screen.findByText(/Submitted for Founder approval/);expect(mock.rpc).toHaveBeenCalledWith('submit_worker_allowance',expect.objectContaining({p_attendance:'a',p_amount:'100.25',p_expected_submitted_at:rec.submitted_at,p_description:'Meals',p_id:expect.any(String)}));
 });
 it('does not allow submission after an unverified list read',async()=>{
  mock.rpc.mockResolvedValue({data:null,error:{message:'Unavailable'}});render(React.createElement(AllowanceDialog,{record:rec,isFounder:true,onClose:vi.fn()}));await screen.findByRole('alert');fireEvent.click(screen.getByRole('button',{name:'Dismiss'}));expect(screen.queryByRole('button',{name:'Record approved allowance'})).toBeNull();
 });
 it('recovers the exact allowance request after an uncertain response and dialog reopen',async()=>{
  let sent:Record<string,string>|null=null;
  mock.rpc.mockImplementation(async(name:string,p:Record<string,string>)=>{
   if(name==='worker_allowances_for_attendance')return {data:[],error:null};
   if(name==='submit_worker_allowance'){if(!sent){sent={...p};return {data:null,error:{message:'response lost'}};}expect(p).toEqual(sent);return {data:{id:p.p_id,status:'pending',replayed:true},error:null};}
   throw Error('Unexpected RPC');
  });
  const first=render(React.createElement(AllowanceDialog,{record:rec,isFounder:false,onClose:vi.fn()}));await screen.findByText('No allowances recorded.');
  fireEvent.change(screen.getByLabelText('Allowance amount (₱)'),{target:{value:'100.25'}});fireEvent.change(screen.getByLabelText('Allowance purpose'),{target:{value:'Meals'}});fireEvent.click(screen.getByRole('button',{name:'Submit for approval'}));
  await screen.findByText(/Result not fully confirmed/);expect(screen.queryByLabelText('Allowance amount (₱)')).toBeNull();first.unmount();
  render(React.createElement(AllowanceDialog,{record:rec,isFounder:false,onClose:vi.fn()}));await screen.findByText(/Request .*100.25/);expect(screen.queryByLabelText('Allowance amount (₱)')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'Retry exact allowance'}));await screen.findByText(/Submitted for Founder approval/);
  expect(sessionStorage.getItem(allowanceAttemptKey('founder','a'))).toBeNull();expect(mock.rpc.mock.calls.filter(c=>c[0]==='submit_worker_allowance')).toHaveLength(2);
 });
 it('fails closed on storage failure, malformed retry, or changed attendance',async()=>{
  mock.rpc.mockResolvedValue({data:[],error:null});
  sessionStorage.setItem(allowanceAttemptKey('founder','a'),'not json');const first=render(React.createElement(AllowanceDialog,{record:rec,isFounder:false,onClose:vi.fn()}));await screen.findByText('No allowances recorded.');expect(screen.queryByRole('button',{name:'Submit for approval'})).toBeNull();first.unmount();
  sessionStorage.clear();const original=vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw Error('blocked');});
  const second=render(React.createElement(AllowanceDialog,{record:rec,isFounder:false,onClose:vi.fn()}));await screen.findByText('No allowances recorded.');fireEvent.change(screen.getByLabelText('Allowance amount (₱)'),{target:{value:'1'}});fireEvent.change(screen.getByLabelText('Allowance purpose'),{target:{value:'Meals'}});fireEvent.click(screen.getByRole('button',{name:'Submit for approval'}));await screen.findByText(/Retry storage could not be verified/);expect(mock.rpc.mock.calls.filter(c=>c[0]==='submit_worker_allowance')).toHaveLength(0);second.unmount();original.mockRestore();
  sessionStorage.setItem(allowanceAttemptKey('founder','a'),JSON.stringify({version:1,actor:'founder',attendance:'a',worker:'w',project:'p',date:rec.date,submittedAt:rec.submitted_at,id:'70000000-0000-4000-8000-000000000004',amount:'1',description:'Meals'}));
  render(React.createElement(AllowanceDialog,{record:{...rec,submitted_at:'2026-11-02T08:00:00Z'},isFounder:false,onClose:vi.fn()}));await screen.findByText(/Attendance or account details changed/);expect((screen.getByRole('button',{name:'Retry exact allowance'}) as HTMLButtonElement).disabled).toBe(true);
 });
 it('requires a fresh list if a confirmed save cannot be reloaded',async()=>{
  mock.rpc.mockResolvedValueOnce({data:[],error:null}).mockImplementationOnce(async(_name:string,p:Record<string,string>)=>({data:{id:p.p_id,status:'approved',replayed:false},error:null})).mockRejectedValueOnce(Error('Network'));
  render(React.createElement(AllowanceDialog,{record:rec,isFounder:true,onClose:vi.fn()}));await screen.findByText('No allowances recorded.');fireEvent.change(screen.getByLabelText('Allowance amount (₱)'),{target:{value:'25'}});fireEvent.change(screen.getByLabelText('Allowance purpose'),{target:{value:'Meals'}});fireEvent.click(screen.getByRole('button',{name:'Record approved allowance'}));
  await screen.findByText(/Allowance was confirmed, but its list could not be refreshed/);expect(screen.queryByLabelText('Allowance amount (₱)')).toBeNull();expect(sessionStorage.getItem(allowanceAttemptKey('founder','a'))).toBeNull();
 });
 it('loads Founder queue, asks for confirmation, and does not claim a payment',async()=>{
  mock.rpc.mockResolvedValueOnce({data:[pending],error:null}).mockResolvedValueOnce({data:{id:'x',status:'approved',replayed:false},error:null});render(React.createElement(WorkerAllowanceQueue));
  fireEvent.click(screen.getByRole('button',{name:/Worker allowance approvals/}));fireEvent.click(screen.getByRole('button',{name:'Load requests'}));await screen.findByText(/Ada · Mason/);
  fireEvent.click(screen.getByRole('button',{name:'Approve'}));const modal=screen.getByRole('dialog');expect(within(modal).getByText(/does not pay/)).toBeTruthy();fireEvent.click(within(modal).getByRole('button',{name:'Confirm approval'}));await screen.findByText(/Decision recorded/);
  expect(mock.rpc).toHaveBeenLastCalledWith('review_worker_allowance',{p_id:'x',p_decision:'approved'});
 });
 it('does not offer approval for stale or finalized requests',async()=>{
  mock.rpc.mockResolvedValue({data:[{...pending,stale:true,finalized:true}],error:null});render(React.createElement(WorkerAllowanceQueue));fireEvent.click(screen.getByRole('button',{name:/Worker allowance approvals/}));fireEvent.click(screen.getByRole('button',{name:'Load requests'}));
  await waitFor(()=>expect((screen.getByRole('button',{name:'Approve'}) as HTMLButtonElement).disabled).toBe(true));expect(screen.getByText(/Attendance changed/)).toBeTruthy();
 });
});
