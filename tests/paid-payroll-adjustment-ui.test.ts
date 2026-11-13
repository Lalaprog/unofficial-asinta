// @vitest-environment jsdom
import React from 'react';
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {snapshotFromReview} from '@/lib/payroll/paidAdjustments';
import type {PaidReviewVoucher} from '@/lib/payroll/paidReview';
const mock=vi.hoisted(()=>({rpc:vi.fn(),founder:true,assurance:'ready'}));
vi.mock('@/lib/auth/authContext',()=>({useAuth:()=>({user:{id:'founder'},isFounder:mock.founder,assurance:mock.assurance})}));
vi.mock('@/lib/supabase/client',()=>({createClient:()=>({rpc:mock.rpc})}));
vi.mock('@/lib/reminders/scheduler',()=>({getManilaClock:()=>({dateIso:'2026-11-18'})}));
import {PaidAdjustmentPanel} from '@/components/payroll/PaidAdjustmentPanel';
const voucher:PaidReviewVoucher={id:'v',worker_id:'w',worker_name:'Worker',period_start:'2026-10-11',period_end:'2026-10-17',gross_pay:'600.00',bale_deduction:'0.00',other_deductions:'0.00',net_pay:'600.00',overlapping_paid:false,period_bale_total:'0.00',period_bale_count:0,unlinked_period_bale_count:0};
const pending={id:'a',payroll_id:'v',worker_id:'w',original_voucher:snapshotFromReview(voucher),difference:'50.25',reason:'Missed OT',status:'pending',created_at:'2026-10-18T00:00:00Z',created_by:'founder',resolved_at:null,resolved_by:null,settled_on:null,resolution_note:null};
beforeEach(()=>{sessionStorage.clear();mock.rpc.mockReset();mock.founder=true;mock.assurance='ready';vi.stubGlobal('crypto',{randomUUID:()=> 'fresh-request-id'});});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
describe('paid adjustment case UI',()=>{
 it('requires history and explicit confirmation; an ambiguous retry keeps the same ID',async()=>{
  mock.rpc.mockImplementation(async(name:string,p:Record<string,unknown>)=>name==='paid_payroll_adjustment_list'?{data:{total:0,offset:0,items:[]},error:null}:mock.rpc.mock.calls.filter(c=>c[0]==='open_paid_payroll_adjustment').length===1?{data:null,error:{message:'Connection lost'}}:{data:{id:p.p_id,status:'pending',replayed:true},error:null});
  render(React.createElement(PaidAdjustmentPanel,{voucher}));expect(mock.rpc).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'Adjustment cases for this voucher'}));fireEvent.click(screen.getByRole('button',{name:'Load case history'}));
  await screen.findByText('No cases recorded for this voucher.');
  fireEvent.change(screen.getByLabelText('Signed difference in pesos'),{target:{value:'50.25'}});fireEvent.change(screen.getByLabelText('Reason for review'),{target:{value:'Missed OT'}});
  fireEvent.click(screen.getByRole('button',{name:'Review new case'}));expect(mock.rpc.mock.calls.filter(c=>c[0]==='open_paid_payroll_adjustment')).toHaveLength(0);
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button',{name:'Open case'}));await screen.findByText(/Outcome not confirmed/);
  fireEvent.click(screen.getByRole('button',{name:'Retry exact case action'}));
  await screen.findByText(/Recorded. Reload case history/);
  const calls=mock.rpc.mock.calls.filter(c=>c[0]==='open_paid_payroll_adjustment');expect(calls).toHaveLength(2);expect(calls[0][1].p_id).toBe(calls[1][1].p_id);expect(calls[1][1]).toMatchObject({p_payroll_id:'v',p_expected:snapshotFromReview(voucher),p_difference:'50.25',p_reason:'Missed OT'});
 });
 it('confirms the selected resolution without changing payroll',async()=>{
  mock.rpc.mockImplementation(async(name:string)=>name==='paid_payroll_adjustment_list'?{data:{total:1,offset:0,items:[pending]},error:null}:{data:{id:'a',status:'no_transfer',replayed:false},error:null});
  render(React.createElement(PaidAdjustmentPanel,{voucher}));fireEvent.click(screen.getByRole('button',{name:'Adjustment cases for this voucher'}));fireEvent.click(screen.getByRole('button',{name:'Load case history'}));
  await screen.findByText(/pending · difference/);fireEvent.click(screen.getByRole('button',{name:'Resolve this case'}));
  const dialog=screen.getByRole('dialog');fireEvent.change(within(dialog).getByLabelText('Resolution'),{target:{value:'no_transfer'}});fireEvent.change(within(dialog).getByLabelText('Resolution explanation'),{target:{value:'No recovery needed'}});
  expect((within(dialog).getByRole('button',{name:'Record resolution'}) as HTMLButtonElement).disabled).toBe(true);fireEvent.click(within(dialog).getByRole('checkbox',{name:/confirmed no transfer is required/}));fireEvent.click(within(dialog).getByRole('button',{name:'Record resolution'}));await screen.findByText(/Recorded. Reload case history/);
  expect(mock.rpc).toHaveBeenCalledWith('resolve_paid_payroll_adjustment',{p_id:'a',p_resolution:'no_transfer',p_settled_on:null,p_note:'No recovery needed'});
  expect(mock.rpc.mock.calls.map(c=>c[0])).toEqual(['paid_payroll_adjustment_list','resolve_paid_payroll_adjustment']);
 });
 it('requires renewed acknowledgement when the external settlement details change',async()=>{
  mock.rpc.mockResolvedValue({data:{total:1,offset:0,items:[pending]},error:null});render(React.createElement(PaidAdjustmentPanel,{voucher}));fireEvent.click(screen.getByRole('button',{name:'Adjustment cases for this voucher'}));fireEvent.click(screen.getByRole('button',{name:'Load case history'}));await screen.findByText(/Created by founder/);fireEvent.click(screen.getByRole('button',{name:'Resolve this case'}));const dialog=screen.getByRole('dialog');fireEvent.change(within(dialog).getByLabelText('Actual settlement date'),{target:{value:'2026-10-20'}});fireEvent.change(within(dialog).getByLabelText('Resolution explanation'),{target:{value:'Ledger checked'}});fireEvent.click(within(dialog).getByRole('checkbox',{name:/full settlement actually happened/}));expect((within(dialog).getByRole('button',{name:'Record resolution'}) as HTMLButtonElement).disabled).toBe(false);fireEvent.change(within(dialog).getByLabelText('Actual settlement date'),{target:{value:'2026-10-21'}});expect((within(dialog).getByRole('button',{name:'Record resolution'}) as HTMLButtonElement).disabled).toBe(true);expect(mock.rpc.mock.calls.filter(c=>c[0]==='resolve_paid_payroll_adjustment')).toHaveLength(0);
 });
 it('restores an uncertain resolution across remount and retries the same parameters',async()=>{
  mock.rpc.mockImplementation(async(name:string)=>name==='paid_payroll_adjustment_list'?{data:{total:1,offset:0,items:[pending]},error:null}:{data:null,error:{message:'timeout'}});
  const first=render(React.createElement(PaidAdjustmentPanel,{voucher}));fireEvent.click(screen.getByRole('button',{name:'Adjustment cases for this voucher'}));fireEvent.click(screen.getByRole('button',{name:'Load case history'}));await screen.findByText(/pending · difference/);fireEvent.click(screen.getByRole('button',{name:'Resolve this case'}));let dialog=screen.getByRole('dialog');fireEvent.change(within(dialog).getByLabelText('Resolution'),{target:{value:'no_transfer'}});fireEvent.change(within(dialog).getByLabelText('Resolution explanation'),{target:{value:'No recovery needed'}});fireEvent.click(within(dialog).getByRole('checkbox',{name:/confirmed no transfer is required/}));fireEvent.click(within(dialog).getByRole('button',{name:'Record resolution'}));await screen.findByText(/Outcome not confirmed/);expect(sessionStorage.length).toBe(1);first.unmount();
  mock.rpc.mockResolvedValue({data:{id:'a',status:'no_transfer',replayed:true},error:null});render(React.createElement(PaidAdjustmentPanel,{voucher}));fireEvent.click(screen.getByRole('button',{name:'Adjustment cases for this voucher'}));expect(screen.getByText(/case action may have been sent/)).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:'Retry exact case action'}));await screen.findByText(/Recorded. Reload case history/);const calls=mock.rpc.mock.calls.filter(c=>c[0]==='resolve_paid_payroll_adjustment');expect(calls).toHaveLength(2);expect(calls[1][1]).toEqual(calls[0][1]);expect(sessionStorage.length).toBe(0);
 });
 it('blocks new actions when storage is corrupt or unavailable',async()=>{
  sessionStorage.setItem(JSON.stringify(['paid-adjustment-retry-v1','founder','v']),'bad');mock.rpc.mockResolvedValue({data:{total:0,offset:0,items:[]},error:null});const first=render(React.createElement(PaidAdjustmentPanel,{voucher}));fireEvent.click(screen.getByRole('button',{name:'Adjustment cases for this voucher'}));fireEvent.click(screen.getByRole('button',{name:'Load case history'}));await screen.findByText('No cases recorded for this voucher.');expect((screen.getByRole('button',{name:'Review new case'}) as HTMLButtonElement).disabled).toBe(true);first.unmount();sessionStorage.clear();
  render(React.createElement(PaidAdjustmentPanel,{voucher}));fireEvent.click(screen.getByRole('button',{name:'Adjustment cases for this voucher'}));fireEvent.click(screen.getByRole('button',{name:'Load case history'}));await screen.findByText('No cases recorded for this voucher.');fireEvent.change(screen.getByLabelText('Signed difference in pesos'),{target:{value:'1.00'}});fireEvent.change(screen.getByLabelText('Reason for review'),{target:{value:'Reason'}});fireEvent.click(screen.getByRole('button',{name:'Review new case'}));vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw Error('blocked');});fireEvent.click(within(screen.getByRole('dialog')).getByRole('button',{name:'Open case'}));await screen.findByText(/no request was sent/);expect(mock.rpc.mock.calls.filter(c=>c[0]==='open_paid_payroll_adjustment')).toHaveLength(0);vi.restoreAllMocks();
 });
 it('disables resolution when the original voucher differs and clears on assurance loss',async()=>{
  mock.rpc.mockResolvedValue({data:{total:1,offset:0,items:[{...pending,original_voucher:{...pending.original_voucher,net_pay:'599.00'}}]},error:null});const view=render(React.createElement(PaidAdjustmentPanel,{voucher}));fireEvent.click(screen.getByRole('button',{name:'Adjustment cases for this voucher'}));fireEvent.click(screen.getByRole('button',{name:'Load case history'}));await screen.findByText(/original voucher differs/);expect((screen.getByRole('button',{name:'Resolve this case'}) as HTMLButtonElement).disabled).toBe(true);mock.assurance='required';view.rerender(React.createElement(PaidAdjustmentPanel,{voucher}));expect(screen.queryByText(/original voucher differs/)).toBeNull();fireEvent.click(screen.getByRole('button',{name:'Adjustment cases for this voucher'}));expect((screen.getByRole('button',{name:'Load case history'}) as HTMLButtonElement).disabled).toBe(true);
 });
 it('does not load case history for a non-Founder',async()=>{
  mock.founder=false;render(React.createElement(PaidAdjustmentPanel,{voucher}));fireEvent.click(screen.getByRole('button',{name:'Adjustment cases for this voucher'}));fireEvent.click(screen.getByRole('button',{name:'Load case history'}));await waitFor(()=>expect(mock.rpc).not.toHaveBeenCalled());
 });
});
