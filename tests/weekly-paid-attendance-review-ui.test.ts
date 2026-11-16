// @vitest-environment jsdom
import React from 'react';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const mock=vi.hoisted(()=>({rpc:vi.fn(),user:'founder',founder:true,assurance:'ready'}));
vi.mock('@/lib/auth/authContext',()=>({useAuth:()=>({user:{id:mock.user},isFounder:mock.founder,assurance:mock.assurance})}));
vi.mock('@/lib/supabase/client',()=>({createClient:()=>({rpc:mock.rpc})}));
import {PaidAttendanceReview} from '@/components/payroll/PaidAttendanceReview';
import {parsePaidAttendanceReview} from '@/lib/payroll/paidAttendanceReview';
import type {PaidReviewVoucher} from '@/lib/payroll/paidReview';
const voucher:PaidReviewVoucher={id:'v',worker_id:'w',worker_name:'Worker',period_start:'2026-10-25',period_end:'2026-10-31',gross_pay:'600.00',bale_deduction:'0.00',other_deductions:'0.00',net_pay:'600.00',overlapping_paid:false,period_bale_total:'0.00',period_bale_count:0,unlinked_period_bale_count:0};
const result={payroll_id:'v',worker_id:'w',period_start:voucher.period_start,period_end:voucher.period_end,attendance:'unchanged'};
beforeEach(()=>{mock.rpc.mockReset();mock.user='founder';mock.founder=true;mock.assurance='ready';});afterEach(cleanup);
describe('paid attendance comparison UI',()=>{
 it('refuses incorrect identity or unrecognized response instead of showing a clean result',async()=>{
  for(const bad of [{...result,attendance:'okay'},{...result,worker_id:'other'},{...result,period_end:'2026-11-01'},null])expect(()=>parsePaidAttendanceReview(bad,voucher)).toThrow();
  mock.rpc.mockResolvedValue({data:{...result,payroll_id:'other'},error:null});render(React.createElement(PaidAttendanceReview,{voucher}));fireEvent.click(screen.getByRole('button',{name:'Check attendance changes'}));await screen.findByRole('alert');expect(screen.getByText(/Do not assume the records match/)).toBeTruthy();
 });
 it('labels missing snapshots as unavailable and explains that matched attendance is limited',async()=>{
  mock.rpc.mockResolvedValueOnce({data:{...result,attendance:'unavailable'},error:null}).mockResolvedValueOnce({data:result,error:null});render(React.createElement(PaidAttendanceReview,{voucher}));fireEvent.click(screen.getByRole('button',{name:'Check attendance changes'}));await screen.findByText(/No saved weekly attendance snapshot/);expect(screen.getByText(/not a clean result/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'Recheck attendance'}));await screen.findByText(/selected attendance and time details matched/);expect(screen.getByText(/does not prove the payment/)).toBeTruthy();
 });
 it('does not show an old response after identity changes and blocks unassured sessions',async()=>{
  let resolve!:(v:unknown)=>void;mock.rpc.mockReturnValue(new Promise(r=>{resolve=r;}));const view=render(React.createElement(PaidAttendanceReview,{voucher}));fireEvent.click(screen.getByRole('button',{name:'Check attendance changes'}));
  mock.assurance='unavailable';view.rerender(React.createElement(PaidAttendanceReview,{voucher}));await act(async()=>resolve({data:result,error:null}));expect(screen.queryByText(/selected attendance and time details matched/)).toBeNull();expect((screen.getByRole('button',{name:'Check attendance changes'}) as HTMLButtonElement).disabled).toBe(true);
 });
});
