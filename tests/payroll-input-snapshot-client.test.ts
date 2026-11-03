import { describe, expect, it } from 'vitest';
import { parsePayrollInputSnapshot } from '@/lib/payroll/inputSnapshot';
const valid=()=>({
  attendance:[{id:'a',worker_id:'w',project_id:'p',date:'2026-10-10',status:'present',hours_worked:8,is_founder_override:false}],
  workers:[{id:'w',name:'Worker',position:'Mason',active:true,pay_rate:'800.00',pay_rate_type:'daily'}],
  projects:[{id:'p',name:'Site'}],users:[],
  advances:[{id:'b',worker_id:'w',project_id:'p',amount:'100.00',amount_deducted:'0',status:'active'}],
  payroll:[{id:'v',worker_id:'w',period_start:'2026-10-01',period_end:'2026-10-15',status:'draft',other_deductions:'50'}],
});
describe('payroll input validation',()=>{
  it('accepts complete server results including decimal strings and empty arrays',()=>{const value=valid();expect(parsePayrollInputSnapshot(value)).toBe(value);expect(parsePayrollInputSnapshot({attendance:[],workers:[],projects:[],users:[],advances:[],payroll:[]}).attendance).toEqual([]);});
  it('fails closed for missing arrays, invalid financial fields and duplicate vouchers',()=>{
    expect(()=>parsePayrollInputSnapshot(null)).toThrow();expect(()=>parsePayrollInputSnapshot({...valid(),workers:null})).toThrow();
    const a=valid();a.attendance[0].hours_worked=NaN;expect(()=>parsePayrollInputSnapshot(a)).toThrow(/attendance/i);
    const w=valid();w.workers[0].pay_rate='not a number';expect(()=>parsePayrollInputSnapshot(w)).toThrow(/worker/i);
    const b=valid();b.advances[0].amount_deducted='';expect(()=>parsePayrollInputSnapshot(b)).toThrow(/advance/i);
    const p=valid();p.payroll.push({...p.payroll[0],id:'other'});expect(()=>parsePayrollInputSnapshot(p)).toThrow(/duplicate/i);
  });
});
