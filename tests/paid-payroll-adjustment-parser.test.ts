import {describe,expect,it} from 'vitest';
import {parseAdjustmentList,sameSnapshot,snapshotFromReview,validDifference} from '@/lib/payroll/paidAdjustments';
import type {PaidReviewVoucher} from '@/lib/payroll/paidReview';
const voucher:PaidReviewVoucher={id:'v',worker_id:'w',worker_name:'Worker',period_start:'2026-10-11',period_end:'2026-10-17',gross_pay:'600.00',bale_deduction:'0.00',other_deductions:'0.00',net_pay:'600.00',overlapping_paid:false,period_bale_total:'0.00',period_bale_count:0,unlinked_period_bale_count:0};
const snap=snapshotFromReview(voucher);
const pending={id:'a',payroll_id:'v',worker_id:'w',original_voucher:snap,difference:'-50.25',reason:'Correction',status:'pending',created_at:'2026-10-18T00:00:00Z',created_by:'f',resolved_at:null,resolved_by:null,settled_on:null,resolution_note:null};
describe('paid-period adjustment parser',()=>{
 it('validates signed centavos without floating point or zero',()=>{
  for(const value of ['0.01','-0.01','50','-50.25','9999999999.99'])expect(validDifference(value)).toBe(true);
  for(const value of ['','0','-0.00','+2','01','1.001','10000000000','NaN','1e2'])expect(validDifference(value)).toBe(false);
 });
 it('parses bounded case history, and detects original-voucher changes',()=>{
  expect(parseAdjustmentList({total:1,offset:0,items:[pending]},'v',0).items[0].difference).toBe('-50.25');
  expect(sameSnapshot(snap,{...snap})).toBe(true);expect(sameSnapshot(snap,{...snap,net_pay:'599.00'})).toBe(false);
  expect(()=>parseAdjustmentList({total:2,offset:0,items:[pending]},'v',0)).toThrow(/Incomplete/);
  expect(()=>parseAdjustmentList({total:1,offset:0,items:[{...pending,payroll_id:'other'}]},'v',0)).toThrow(/Invalid/);
  expect(()=>parseAdjustmentList({total:1,offset:0,items:[{...pending,status:'settled_external',settled_on:'2026-02-30'}]},'v',0)).toThrow(/Invalid/);
  expect(()=>parseAdjustmentList({total:2,offset:0,items:[pending,pending]},'v',0)).toThrow(/Invalid/);
 });
});
