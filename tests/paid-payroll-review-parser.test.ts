import {describe,expect,it} from 'vitest';
import {parsePaidReview,paidReviewSignals,validReviewRange} from '@/lib/payroll/paidReview';
const row={id:'v',worker_id:'w',worker_name:'Worker',period_start:'2026-10-25',period_end:'2026-10-31',gross_pay:'100.50',bale_deduction:'10.5',other_deductions:'0',net_pay:'90.00',overlapping_paid:false,period_bale_total:'10.50',period_bale_count:1,unlinked_period_bale_count:0};
const snapshot={start:'2026-10-25',end:'2026-10-31',vouchers:[row]};
describe('paid history review parsing',()=>{
 it('compares monetary strings exactly, without flagging equivalent centavos',()=>{expect(paidReviewSignals(parsePaidReview(snapshot,snapshot.start,snapshot.end).vouchers[0])).toEqual([]);});
 it('bounds inclusive ranges and rejects invalid dates',()=>{expect(validReviewRange('2026-01-01','2026-04-03')).toBe(true);expect(validReviewRange('2026-01-01','2026-04-04')).toBe(false);expect(validReviewRange('2026-02-30','2026-03-01')).toBe(false);});
 it('fails closed for duplicate rows, invalid values, out-of-window rows and outdated shapes',()=>{
  for(const value of [
   {...snapshot,vouchers:[row,row]},
   {...snapshot,vouchers:[{...row,period_bale_total:'-1'}]},
   {...snapshot,vouchers:[{...row,unlinked_period_bale_count:2}]},
   {...snapshot,vouchers:[{...row,period_start:'2026-11-01',period_end:'2026-11-02'}]},
   {...snapshot,vouchers:[{...row,overlapping_paid:null}]},
   {start:snapshot.start,end:snapshot.end},
  ])expect(()=>parsePaidReview(value,snapshot.start,snapshot.end)).toThrow();
 });
});
