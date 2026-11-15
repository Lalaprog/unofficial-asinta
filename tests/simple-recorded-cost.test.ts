import {describe,expect,it} from 'vitest';
import {parseSimpleRecordedCost} from '@/lib/projects/simpleRecordedCost';
import {inventory,saved,site} from './helpers/corrected-cost-ui-fixture';
const request='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
function snapshot(){return {project_id:site,coverage:{project_id:site,captured_at:inventory.historical_review.base.captured_at,unallocated_paid:0,attendance_matches:0,inconsistent_allocations:0,unattributed_history:0,review:{project_id:site,found:false,latest_revision:0}},inventory:structuredClone(inventory)};}
describe('simple recorded cost',()=>{
 it('combines recorded site expenses, paid gross, historical pay and reviewed original-period correction once',()=>{
  const r=parseSimpleRecordedCost(snapshot(),site);expect(r.issues).toEqual([]);expect(r.totals).toMatchObject({expenses:5025n,paid:60000n,historical:40025n,correction:-1250n,total:103800n});
 });
 it.each(['unallocated','mismatch','history','bale flag','bale wording','duplicates','historical overlap','missing correction','changed correction'])('asks for review rather than guessing: %s',kind=>{
  const v=snapshot();if(kind==='unallocated')v.coverage.unallocated_paid=1;if(kind==='mismatch')v.coverage.inconsistent_allocations=1;if(kind==='history')v.coverage.unattributed_history=1;
  if(kind==='bale flag')v.inventory.historical_review.base.expenses[0].ai_bale_detection=true;if(kind==='bale wording')v.inventory.historical_review.base.expenses[0].description='Bale release';
  if(kind==='duplicates')v.inventory.historical_review.base.expenses.unshift({...v.inventory.historical_review.base.expenses[0],id:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'});
  if(kind==='historical overlap')v.inventory.historical_review.historical[0].overlapping_vouchers=1;
  if(kind==='missing correction'){v.inventory.corrections[0].evidence.latest_revision=0;(v.inventory.corrections[0].evidence as {attribution:unknown}).attribution=null;(v.inventory.corrections[0] as {site_gross_change:unknown}).site_gross_change=null;}
  if(kind==='changed correction')v.inventory.corrections[0].evidence.attribution.case_changed=true;
  const r=parseSimpleRecordedCost(v,site);expect(r.totals).toBeNull();expect(r.issues.length).toBeGreaterThan(0);
 });
 it('does not replace an existing saved review with automatic expense choices',()=>{
  const v=snapshot();(v.coverage as {review:unknown}).review=saved(request);const r=parseSimpleRecordedCost(v,site);expect(r.totals).toBeNull();expect(r.issues).toContain('Use the saved cost review rather than an automatic recorded amount.');
 });
 it('rejects snapshots with different capture times or malformed coverage',()=>{
  const v=snapshot();v.coverage.captured_at='2024-12-12T00:00:00Z';expect(()=>parseSimpleRecordedCost(v,site)).toThrow(/different times/);
  const b=snapshot();b.coverage.attendance_matches=1;expect(()=>parseSimpleRecordedCost(b,site)).toThrow(/attendance/);
 });
 it('asks for explicit review for multiple case effects on the same original',()=>{
  const v=snapshot(),secondId='cccccccc-cccc-4ccc-8ccc-cccccccccccc',first=v.inventory.corrections[0],second=structuredClone(first);
  second.case_id=secondId;second.evidence.case_id=secondId;second.evidence.case.id=secondId;second.evidence.case.related_cases[0].id=secondId;
  const siblings=[first.evidence.case.related_cases[0],second.evidence.case.related_cases[0]];first.evidence.case.related_cases=structuredClone(siblings);second.evidence.case.related_cases=structuredClone(siblings);first.evidence.attribution.case_snapshot=structuredClone(first.evidence.case);second.evidence.attribution.case_snapshot=structuredClone(second.evidence.case);
  v.inventory.corrections.push(second);v.inventory.historical_review.base.adjustment_cases.push({...v.inventory.historical_review.base.adjustment_cases[0],case_id:secondId});
  const r=parseSimpleRecordedCost(v,site);expect(r.totals).toBeNull();expect(r.issues).toContain('Multiple corrections for one payroll record need a distinct-effects review.');
 });
});
