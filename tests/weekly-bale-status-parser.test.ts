import {describe,expect,it} from 'vitest';
import {parseWeeklyBaleStatuses} from '@/lib/attendance/weeklyBaleStatus';
const item={id:'r',kind:'weekly',period_start:'2026-11-15',stored_status:'pending_approval',effective_status:'pending_approval',auto_expired:false,can_review:true};
const wrap=(items:object[])=>({as_of:'2026-11-17T10:00:00Z',items});
describe('weekly Bale status response validation',()=>{
 it('accepts complete weekly and separate legacy states',()=>{
  const legacy={id:'x',kind:'legacy',period_start:null,stored_status:'pending_approval',effective_status:'pending_approval',auto_expired:false,can_review:false};
  expect(parseWeeklyBaleStatuses(wrap([item,legacy]),['r','x']).items).toHaveLength(2);
 });
 it.each([
  wrap([]),wrap([item,item]),wrap([{...item,id:'other'}]),wrap([{...item,period_start:'2026-11-16'}]),
  wrap([{...item,auto_expired:true}]),wrap([{...item,effective_status:'expired_unapproved'}]),
  wrap([{...item,kind:'legacy'}]),wrap([{...item,can_review:'true'}]),wrap([{...item,stored_status:'bad'}]),
 ])('rejects incomplete or contradictory results %#',data=>expect(()=>parseWeeklyBaleStatuses(data,['r'])).toThrow());
});
