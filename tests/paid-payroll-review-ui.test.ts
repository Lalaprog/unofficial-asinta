// @vitest-environment jsdom
import React from 'react';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const mock=vi.hoisted(()=>({rpc:vi.fn(),user:'founder',founder:true}));
vi.mock('@/lib/auth/authContext',()=>({useAuth:()=>({user:{id:mock.user},isFounder:mock.founder})}));
vi.mock('@/lib/supabase/client',()=>({createClient:()=>({rpc:mock.rpc})}));
vi.mock('@/lib/reminders/scheduler',()=>({getManilaClock:()=>({dateIso:'2026-11-18'})}));
import {PaidHistoryReview} from '@/components/payroll/PaidHistoryReview';
const voucher={id:'v',worker_id:'w',worker_name:'Fixture Worker',period_start:'2026-11-01',period_end:'2026-11-07',gross_pay:'1000.00',bale_deduction:'10.25',other_deductions:'0.00',net_pay:'989.75',overlapping_paid:true,period_bale_total:'5.00',period_bale_count:1,unlinked_period_bale_count:1};
const snapshot={start:'2026-10-19',end:'2026-11-18',vouchers:[voucher]};
const deferred=()=>{let resolve!:(value:unknown)=>void;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
beforeEach(()=>{mock.rpc.mockReset();mock.user='founder';mock.founder=true;});afterEach(()=>{cleanup();vi.unstubAllEnvs();});
describe('paid history review',()=>{
 it('loads only on request and shows warning signals without offering payment actions',async()=>{
  mock.rpc.mockResolvedValue({data:snapshot,error:null});render(React.createElement(PaidHistoryReview));expect(mock.rpc).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:/Paid payroll history review/}));fireEvent.click(screen.getByRole('button',{name:'Load paid history'}));
  await screen.findByText(/Fixture Worker/);expect(mock.rpc).toHaveBeenCalledWith('paid_payroll_review',{p_start:'2026-10-19',p_end:'2026-11-18'});
  expect(screen.getByText(/Another paid voucher overlaps/)).toBeTruthy();expect(screen.getByText(/differs from recorded/)).toBeTruthy();expect(screen.getByText(/no matching issued request/)).toBeTruthy();expect(screen.getByText(/cannot establish whether money was paid/)).toBeTruthy();expect(screen.queryByRole('button',{name:/confirm paid|deduct bale|record payment/i})).toBeNull();
 });
 it('requires both preview flags before showing adjustment-case controls',async()=>{
  vi.stubEnv('NEXT_PUBLIC_FINANCE_FOUNDATION_PREVIEW','true');vi.stubEnv('NEXT_PUBLIC_PAID_ADJUSTMENTS_PREVIEW','false');mock.rpc.mockResolvedValue({data:snapshot,error:null});
  const view=render(React.createElement(PaidHistoryReview));fireEvent.click(screen.getByRole('button',{name:/Paid payroll history review/}));fireEvent.click(screen.getByRole('button',{name:'Load paid history'}));await screen.findByText(/Fixture Worker/);
  expect(screen.queryByRole('button',{name:'Adjustment cases for this voucher'})).toBeNull();
  vi.stubEnv('NEXT_PUBLIC_PAID_ADJUSTMENTS_PREVIEW','true');view.rerender(React.createElement(PaidHistoryReview));expect(screen.getByRole('button',{name:'Adjustment cases for this voucher'})).toBeTruthy();
  vi.stubEnv('NEXT_PUBLIC_FINANCE_FOUNDATION_PREVIEW','false');view.rerender(React.createElement(PaidHistoryReview));expect(screen.queryByRole('button',{name:'Adjustment cases for this voucher'})).toBeNull();
 });
 it('gates the separate historical evidence viewer independently',async()=>{
  vi.stubEnv('NEXT_PUBLIC_FINANCE_FOUNDATION_PREVIEW','true');vi.stubEnv('NEXT_PUBLIC_HISTORICAL_FINANCE_EVIDENCE_PREVIEW','false');mock.rpc.mockResolvedValue({data:snapshot,error:null});
  const view=render(React.createElement(PaidHistoryReview));fireEvent.click(screen.getByRole('button',{name:/Paid payroll history review/}));fireEvent.click(screen.getByRole('button',{name:'Load paid history'}));await screen.findByText(/Fixture Worker/);expect(screen.queryByRole('button',{name:'Historical payment and Bale evidence'})).toBeNull();
  vi.stubEnv('NEXT_PUBLIC_HISTORICAL_FINANCE_EVIDENCE_PREVIEW','true');view.rerender(React.createElement(PaidHistoryReview));expect(screen.getByRole('button',{name:'Historical payment and Bale evidence'})).toBeTruthy();vi.stubEnv('NEXT_PUBLIC_FINANCE_FOUNDATION_PREVIEW','false');view.rerender(React.createElement(PaidHistoryReview));expect(screen.queryByRole('button',{name:'Historical payment and Bale evidence'})).toBeNull();
 });
 it('clears stale responses, rejects invalid ranges and surfaces missing RPCs',async()=>{
  const old=deferred();mock.rpc.mockReturnValueOnce(old.promise).mockResolvedValueOnce({data:null,error:{message:'Function unavailable'}});
  render(React.createElement(PaidHistoryReview));fireEvent.click(screen.getByRole('button',{name:/Paid payroll history review/}));fireEvent.click(screen.getByRole('button',{name:'Load paid history'}));
  fireEvent.change(screen.getByLabelText('Review from'),{target:{value:'2026-01-01'}});expect(screen.getByText(/at most 93 calendar days/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Review from'),{target:{value:'2026-10-20'}});fireEvent.click(screen.getByRole('button',{name:'Load paid history'}));
  await screen.findByRole('alert');expect(screen.getByRole('alert').textContent).toMatch(/Function unavailable/);
  await act(async()=>old.resolve({data:snapshot,error:null}));expect(screen.queryByText(/Fixture Worker/)).toBeNull();
 });
 it('does not present an empty result as proof of no external payment',async()=>{
  mock.rpc.mockResolvedValue({data:{...snapshot,vouchers:[]},error:null});render(React.createElement(PaidHistoryReview));fireEvent.click(screen.getByRole('button',{name:/Paid payroll history review/}));fireEvent.click(screen.getByRole('button',{name:'Load paid history'}));await screen.findByText(/does not prove that no external payment occurred/);
 });
});
