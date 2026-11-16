import {describe,expect,it} from 'vitest';
import type {AdvanceRequest,AdvanceRequestStatus} from '@/types';
import type {WeeklyBaleStatus} from '@/lib/attendance/weeklyBaleStatus';
import {selectedBaleDuplicateSignals} from '@/lib/attendance/baleDuplicateSignals';
const request=(id:string,worker='w1',status:AdvanceRequestStatus='pending_approval')=>({id,worker_id:worker,project_id:'site',status} as AdvanceRequest);
const status=(id:string,stored_status:AdvanceRequestStatus='pending_approval',period_start='2026-11-15'):WeeklyBaleStatus=>({id,stored_status,effective_status:stored_status,kind:'weekly',period_start,can_review:stored_status==='pending_approval',auto_expired:false});
describe('possible repeated Bale review signals',()=>{
 it('compares selected worker-week against other loaded non-rejected requests, even at another site',()=>{
  const rows=[request('one'),{...request('two','w1','issued'),project_id:'other'},request('three','w2')];
  expect(selectedBaleDuplicateSignals(rows,[status('one'),status('two','issued'),status('three')],new Set(['one']))).toEqual([{workerId:'w1',periodStart:'2026-11-15',requestCount:2}]);
  expect(selectedBaleDuplicateSignals(rows,[status('one'),status('two','issued'),status('three')],new Set(['three']))).toEqual([]);
 });
 it('does not use rejected, expired, legacy, wrong-week, missing or mismatched status as evidence',()=>{
  const rows=[request('one'),request('two','w1','rejected'),request('three'),request('four'),request('five'),request('six')];
  const statuses=[status('one'),status('two','rejected'),{...status('three'),effective_status:'expired_unapproved' as const},{...status('four'),kind:'legacy' as const,period_start:null,can_review:false},status('five','pending_approval','2026-11-22'),status('six','issued')];
  expect(selectedBaleDuplicateSignals(rows,statuses,new Set(['one']))).toEqual([]);
 });
 it('counts each request once and treats the selected set as scope rather than uniqueness proof',()=>{
  expect(selectedBaleDuplicateSignals([request('one'),request('one'),request('two')],[status('one'),status('two')],new Set(['one']))).toEqual([{workerId:'w1',periodStart:'2026-11-15',requestCount:2}]);
  expect(selectedBaleDuplicateSignals([request('one'),request('two')],[status('one'),status('two')],new Set())).toEqual([]);
 });
});
