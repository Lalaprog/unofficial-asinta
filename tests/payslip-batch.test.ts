import { describe, expect, it } from 'vitest';
import { chunkPayslips, parsePayslipBatch } from '@/lib/payroll/payslipBatch';

const start='2026-10-25', end='2026-10-31';
const row = { id:'voucher', worker_id:'worker', worker_name:'Alba', worker_position:'Mason', period_start:start, period_end:end, status:'approved', days_worked:0, hours_worked:null, gross_pay:'500.25', bale_deduction:'10.10', other_deductions:0, net_pay:'490.15' };
describe('batch payslip validation', () => {
  it('retains zeros, null work and centavos', () => {
    expect(parsePayslipBatch([row], start, end)[0]).toMatchObject({ gross_pay:500.25, bale_deduction:10.10, net_pay:490.15, days_worked:0, hours_worked:null });
  });
  it('rejects stale periods, malformed amounts, duplicate vouchers or workers', () => {
    for (const data of [[{...row,period_end:'2026-11-01'}], [{...row,net_pay:null}], [row,row], [row,{...row,id:'other'}]]) {
      expect(() => parsePayslipBatch(data,start,end)).toThrow();
    }
  });
  it('places up to nine slips on each page without dropping a remainder', () => {
    expect(chunkPayslips(Array.from({length:20},(_,i)=>i)).map(x=>x.length)).toEqual([9,9,2]);
    expect(chunkPayslips([])).toEqual([]);
    expect(()=>chunkPayslips([1],0)).toThrow();
  });
});
