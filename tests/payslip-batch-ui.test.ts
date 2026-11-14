// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
const mocks=vi.hoisted(()=>({rpc:vi.fn()}));
vi.mock('@/lib/supabase/client',()=>({createClient:()=>({rpc:mocks.rpc})}));
import { PayslipBatch } from '@/components/payroll/PayslipBatch';
const voucher={id:'pay1',worker_id:'w1',worker_name:'Alba',worker_position:'Mason',period_start:'2026-10-25',period_end:'2026-10-31',status:'draft',days_worked:2,hours_worked:16,gross_pay:1200,bale_deduction:100,other_deductions:0,net_pay:1100};
afterEach(()=>{cleanup();mocks.rpc.mockReset();vi.useRealTimers()});
describe('batch payslip flow',()=>{
 it('loads exact period vouchers, displays status without rate/logo and invalidates on period change',async()=>{
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-10-27T08:00:00Z'));
  mocks.rpc.mockResolvedValue({data:[voucher],error:null});
  render(React.createElement(PayslipBatch,{onClose:()=>{}}));
  fireEvent.click(screen.getByRole('button',{name:'Load period payslips'}));
  await waitFor(()=>expect(screen.getByText('Alba')).toBeTruthy());
  expect(mocks.rpc).toHaveBeenCalledWith('payslip_batch_snapshot',{p_start:'2026-10-25',p_end:'2026-10-31'});
  const document=screen.getByLabelText('Payslip page 1');
  expect(within(document).getByText('Current craft: Mason (not a historical snapshot)')).toBeTruthy();
  expect(within(document).getByText(/DRAFT/)).toBeTruthy();expect(within(document).getByText(/₱1,100.00/)).toBeTruthy();
  expect(document.textContent).not.toMatch(/rate/i);expect(document.querySelector('svg,img')).toBeNull();
  fireEvent.change(screen.getByLabelText('Payslip period start'),{target:{value:'2026-10-18'}});
  expect(screen.queryByText('Alba')).toBeNull();expect((screen.getByRole('button',{name:'Print all payslips'}) as HTMLButtonElement).disabled).toBe(true);
 });
 it('prints entry-time craft with its qualification when captured',async()=>{
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-10-27T08:00:00Z'));
  mocks.rpc.mockResolvedValue({data:[{...voucher,worker_position:'Lead Mason',entry_craft:'Mason',entry_craft_at:'2026-11-14T02:00:00Z'}],error:null});
  render(React.createElement(PayslipBatch,{onClose:()=>{}}));fireEvent.click(screen.getByRole('button',{name:'Load period payslips'}));
  expect(await screen.findByText('Craft at voucher entry: Mason (may differ from work date)')).toBeTruthy();
 });
 it('does not display a response from a previous period',async()=>{
  let resolve!: (value:unknown)=>void;
  mocks.rpc.mockReturnValue(new Promise(r=>{resolve=r}));
  render(React.createElement(PayslipBatch,{onClose:()=>{}}));
  fireEvent.click(screen.getByRole('button',{name:'Load period payslips'}));
  fireEvent.change(screen.getByLabelText('Payslip period start'),{target:{value:'2026-01-01'}});
  resolve({data:[voucher],error:null});
  await waitFor(()=>expect(screen.getByRole('button',{name:'Load period payslips'})).toBeTruthy());
  expect(screen.queryByText('Alba')).toBeNull();
 });
 it('fails closed on database errors',async()=>{
  mocks.rpc.mockResolvedValue({data:null,error:{code:'P1004'}});
  render(React.createElement(PayslipBatch,{onClose:()=>{}}));fireEvent.click(screen.getByRole('button',{name:'Load period payslips'}));
  expect((await screen.findByRole('alert')).textContent).toMatch(/Review duplicate vouchers/);
  expect((screen.getByRole('button',{name:'Print all payslips'}) as HTMLButtonElement).disabled).toBe(true);
 });
});
