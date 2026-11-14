import {describe,expect,it} from 'vitest';
import {parseRecordedCraft} from '@/lib/workforce/recordedCraft';
import {parseHistoryPage} from '@/lib/attendance/history';
import {parsePayslipBatch} from '@/lib/payroll/payslipBatch';
const observed={entry_craft:'Mason',entry_craft_at:'2026-11-14T02:00:00Z'};
const record={id:'1',worker_id:'w',project_id:'p',date:'2026-11-01',status:'present',is_supervisor:false,is_founder_override:false};
const voucher={id:'1',worker_id:'w',worker_name:'A',worker_position:'Current',period_start:'2026-11-01',period_end:'2026-11-07',status:'paid',days_worked:1,hours_worked:8,gross_pay:600,bale_deduction:0,other_deductions:0,net_pay:600};
describe('entry craft observation response validation',()=>{
 it('distinguishes no observation from an entry-time observation',()=>{
  expect(parseRecordedCraft({})).toBeNull();expect(parseRecordedCraft({entry_craft:null,entry_craft_at:null})).toBeNull();expect(parseRecordedCraft(observed)).toEqual({label:'Mason',capturedAt:'2026-11-14T02:00:00Z'});
  expect(parsePayslipBatch([{...voucher,...observed}],voucher.period_start,voucher.period_end)[0].recorded_craft?.label).toBe('Mason');
  expect(parseHistoryPage({items:[{...record,...observed}],has_more:false},'records').items).toHaveLength(1);
 });
 it('rejects incomplete, forged or malformed fields rather than relabeling them',()=>{
  for(const fields of [{entry_craft:'Mason'}, {entry_craft:null,entry_craft_at:observed.entry_craft_at}, {entry_craft:'',entry_craft_at:observed.entry_craft_at}, {entry_craft:'Mason',entry_craft_at:'not a date'}, {entry_craft:'x'.repeat(81),entry_craft_at:observed.entry_craft_at}]){
   expect(()=>parseRecordedCraft(fields)).toThrow();expect(()=>parseHistoryPage({items:[{...record,...fields}],has_more:false},'records')).toThrow();expect(()=>parsePayslipBatch([{...voucher,...fields}],voucher.period_start,voucher.period_end)).toThrow();
  }
 });
});
