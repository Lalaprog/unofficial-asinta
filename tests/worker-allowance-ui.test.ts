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
const rec={id:'a',worker_id:'w',project_id:'p',date:'2026-11-01',status:'present',hours_worked:8,notes:null,recorded_by:'u',is_founder_override:false,submitted_at:'2026-11-01T08:00:00Z',created_at:'2026-11-01T08:00:00Z',worker_name:'Ada',worker_position:'Mason',project_name:'Site',is_supervisor:false} satisfies HistoryRecord;
const pending={id:'x',worker_name:'Ada',worker_position:'Mason',project_name:'Site',date:'2026-11-01',amount:'100.25',description:'Meals',submitted_at:'2026-11-01T10:00:00Z',stale:false,finalized:false};
beforeEach(()=>{mock.rpc.mockReset();});afterEach(cleanup);
describe('worker allowance UI',()=>{
 it('submits a Supervisor allowance only after loading and clearly says it is not payroll',async()=>{
  mock.rpc.mockImplementation(async(name:string,p:Record<string,string>)=>name==='worker_allowances_for_attendance'?{data:[],error:null}:{data:{id:p.p_id,status:'pending',replayed:false},error:null});
  render(React.createElement(AllowanceDialog,{record:rec,isFounder:false,onClose:vi.fn()}));await screen.findByText('No allowances recorded.');
  expect(screen.getByText(/not yet added to payroll/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Allowance amount (₱)'),{target:{value:'100.25'}});fireEvent.change(screen.getByLabelText('Allowance purpose'),{target:{value:'Meals'}});fireEvent.click(screen.getByRole('button',{name:'Submit for approval'}));
  await screen.findByText(/Submitted for Founder approval/);expect(mock.rpc).toHaveBeenCalledWith('submit_worker_allowance',expect.objectContaining({p_attendance:'a',p_amount:'100.25',p_expected_submitted_at:rec.submitted_at,p_description:'Meals',p_id:expect.any(String)}));
 });
 it('does not allow submission after an unverified list read',async()=>{
  mock.rpc.mockResolvedValue({data:null,error:{message:'Unavailable'}});render(React.createElement(AllowanceDialog,{record:rec,isFounder:true,onClose:vi.fn()}));await screen.findByRole('alert');fireEvent.click(screen.getByRole('button',{name:'Dismiss'}));expect(screen.queryByRole('button',{name:'Record approved allowance'})).toBeNull();
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
