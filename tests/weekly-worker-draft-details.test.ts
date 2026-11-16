import {describe,expect,it} from 'vitest';
import {parseWeeklyDraftDetails,parseWeeklyRefreshAttempt} from '@/lib/payroll/weeklyDraftDetails';
const expected={id:'voucher',worker:'worker',start:'2026-11-15'};
const draft={payroll_id:'voucher',worker_id:'worker',period_start:'2026-11-15',period_end:'2026-11-21',status:'draft',approved:false,payment_date:null,gross:'100.25',bale:'25.00',other:'0.00',net:'75.25',calculation:{regular_hours:'8.00',overtime_hours:'1.00',wage:'100.00',allowance:'0.25',gross:'100.25',bale:'25.00',net:'75.25',unmarked_dates:['2026-11-20']},allocations:[]};
const paid={...draft,status:'paid',approved:true,payment_date:'2026-11-21',allocations:[{project_id:'p1',hours:'8.00',wage:'88.89',allowance:'0.25',gross:'89.14'},{project_id:'p2',hours:'1.00',wage:'11.11',allowance:'0.00',gross:'11.11'}]};
describe('experimental weekly voucher response validation',()=>{
 it('accepts a complete draft and exactly reconciled paid allocation',()=>{expect(parseWeeklyDraftDetails(draft,expected).status).toBe('draft');expect(parseWeeklyDraftDetails(paid,expected).allocations).toHaveLength(2);});
 it('requires a safe nonnegative revision in the revision-aware workflow',()=>{
  expect(parseWeeklyDraftDetails({...draft,draft_revision:0},expected,true).draft_revision).toBe(0);
  for(const revision of [undefined,-1,1.5,Number.MAX_SAFE_INTEGER,'1',null])expect(()=>parseWeeklyDraftDetails({...draft,draft_revision:revision},expected,true)).toThrow();
 });
 it('validates saved retry identifiers and revision',()=>{
  const attempt={request:'10000000-0000-4000-8000-000000000001',payroll:'10000000-0000-4000-8000-000000000002',revision:3};expect(parseWeeklyRefreshAttempt(attempt)).toEqual(attempt);
  for(const bad of [null,{...attempt,request:'x'},{...attempt,payroll:'x'},{...attempt,revision:-1},{...attempt,revision:Number.MAX_SAFE_INTEGER}])expect(()=>parseWeeklyRefreshAttempt(bad)).toThrow();
 });
 it.each([
  {...draft,worker_id:'different'}, {...draft,period_end:'2026-11-20'}, {...draft,status:'paid'}, {...draft,approved:true},
  {...draft,gross:'100.26'}, {...draft,other:'1.00'}, {...draft,net:'-1.00'}, {...draft,calculation:{...draft.calculation,unmarked_dates:['2026-11-20','2026-11-20']}},
  {...paid,allocations:[paid.allocations[0]]}, {...paid,allocations:[paid.allocations[0],paid.allocations[0]]}, {...paid,payment_date:'2026-02-30'},
  {...draft,allocations:paid.allocations}, {...paid,allocations:[{...paid.allocations[0],gross:'89.15'},paid.allocations[1]]},
 ])('fails closed for inconsistent voucher details %#',value=>{expect(()=>parseWeeklyDraftDetails(value,expected)).toThrow();});
});
