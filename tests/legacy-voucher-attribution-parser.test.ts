import {describe,expect,it} from 'vitest';
import {legacyStatusMatches,parseLegacyAttempt,parseLegacyStatus} from '@/lib/payroll/legacyVoucherAttribution';
import type {PaidReviewVoucher} from '@/lib/payroll/paidReview';
const actor='00000000-0000-0000-0000-000000000001',id='00000000-0000-0000-0000-000000000003',site='00000000-0000-0000-0000-000000000004',request='f3000000-0000-4000-8000-000000000001';
const scope:PaidReviewVoucher={id,worker_id:id,worker_name:'Worker',period_start:'2026-10-25',period_end:'2026-10-31',gross_pay:'600.00',bale_deduction:'100.00',other_deductions:'0.00',net_pay:'500.00',overlapping_paid:false,period_bale_total:'100.00',period_bale_count:1,unlinked_period_bale_count:0};
const voucher={id,worker_id:id,period_start:scope.period_start,period_end:scope.period_end,status:'paid',gross_pay:'600.00',bale_deduction:'100.00',other_deductions:'0.00',net_pay:'500.00'};
const worker={id,name:'Worker',position:'Mason',active:true};const split=[{project_id:site,gross:'600.00'}];
const status={payroll_id:id,worker_name:'Worker',worker,voucher,eligible:true,risks:[],cases:[],found:false};
const attempt={version:2,request,actor,voucher,worker,cases:[],split,note:'Checked original'};
describe('legacy voucher attribution evidence parsing',()=>{
 it('binds exact paid voucher and worker evidence to retry and readback',()=>{
  const saved=parseLegacyAttempt(attempt,actor,scope),row={...status,eligible:false,found:true,request_id:request,snapshot:voucher,recorded_worker:worker,split,note:attempt.note,actor_id:actor,recorded_at:'2026-11-01T00:00:00Z',source_changed:false,case_count:0,recorded_cases:[]};
  expect(legacyStatusMatches(parseLegacyStatus(row,scope),saved)).toBe(true);
  expect(legacyStatusMatches(parseLegacyStatus({...row,source_changed:true},scope),saved)).toBe(false);
  expect(()=>parseLegacyAttempt({...attempt,actor:site},actor,scope)).toThrow();
  expect(()=>parseLegacyAttempt({...attempt,split:[{project_id:site,gross:'599.99'}]},actor,scope)).toThrow();
 });
 it('rejects changed amounts, inconsistent eligibility, unknown signals and false fresh claims',()=>{
  for(const bad of [{...status,voucher:{...voucher,net_pay:'499.99'}},{...status,worker:{...worker,id:site}},{...status,risks:['unknown'],eligible:false},{...status,eligible:false},{...status,risks:['correction_cases'],eligible:false}])expect(()=>parseLegacyStatus(bad,scope)).toThrow();
  const saved={...status,eligible:false,found:true,request_id:request,snapshot:voucher,recorded_worker:{...worker,name:'Other'},split,note:'Checked',actor_id:actor,recorded_at:'2026-11-01T00:00:00Z',source_changed:false,case_count:0,recorded_cases:[]};
  expect(()=>parseLegacyStatus(saved,scope)).toThrow(/not flagged/);
 });
});
