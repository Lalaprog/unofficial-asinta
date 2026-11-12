import { describe, expect, it } from 'vitest';
import { buildWeeklyPreview, parseWeeklyInput, weekDates } from '@/lib/payroll/weeklyPreview';

const snapshot=()=>({start:'2026-11-15',end:'2026-11-21',workers:[{id:'w',name:'Worker',position:'Mason',active:true,pay_rate:'655.55',pay_rate_type:'daily',linked_supervisor:false,possible_supervisor:false}],attendance:[{id:'a',worker_id:'w',project_id:'p',date:'2026-11-15',status:'present',hours_worked:'8.00'},{id:'b',worker_id:'w',project_id:'p',date:'2026-11-16',status:'half_day',hours_worked:'4.00'}],vouchers:[] as {id:string;worker_id:string;status:string}[]});
describe('weekly worker planning preview',()=>{
 it('uses a Sunday–Saturday week and preserves centavos in the regular-hours estimate',()=>{
  const view=buildWeeklyPreview(parseWeeklyInput(snapshot(),'2026-11-15'),'2026-11-18');
  expect(weekDates('2026-11-15')).toEqual(['2026-11-15','2026-11-16','2026-11-17','2026-11-18','2026-11-19','2026-11-20','2026-11-21']);
  expect(view.rows[0].estimate).toBe('983.33');
  expect(view.rows[0].days.map(d=>d.unmarked)).toEqual([null,null,'past','today','upcoming','upcoming','upcoming']);
  expect(view.rows[0].pastUnmarked).toBe(true);
 });
 it('handles hourly rates and rounds once to centavos',()=>{
  const s=snapshot();s.workers[0].pay_rate_type='hourly';s.workers[0].pay_rate='100.05';s.attendance[0].hours_worked='1.50';s.attendance[1].hours_worked='0.25';
  expect(buildWeeklyPreview(parseWeeklyInput(s,s.start),'2026-11-15').rows[0].estimate).toBe('175.09');
 });
 it('does not calculate over-eight hours or duplicate site days',()=>{
  const s=snapshot();s.attendance[0].hours_worked='9.00';
  expect(buildWeeklyPreview(parseWeeklyInput(s,s.start),s.start).rows[0]).toMatchObject({review:true,estimate:null});
  s.attendance[0].hours_worked='8.00';s.attendance.push({...s.attendance[0],id:'c',project_id:'p2'});
  expect(buildWeeklyPreview(parseWeeklyInput(s,s.start),s.start).rows[0]).toMatchObject({review:true,estimate:null});
 });
 it('does not calculate on ambiguous identities, inconsistent absence hours, or approved/paid vouchers',()=>{
  const s=snapshot();s.workers[0].possible_supervisor=true;
  expect(buildWeeklyPreview(parseWeeklyInput(s,s.start),s.start).rows[0].estimate).toBeNull();
  s.workers[0].possible_supervisor=false;s.attendance[0].status='absent';
  expect(buildWeeklyPreview(parseWeeklyInput(s,s.start),s.start).rows[0].review).toBe(true);
  s.attendance[0].hours_worked='0.00';s.vouchers.push({id:'v',worker_id:'w',status:'paid'});
  expect(buildWeeklyPreview(parseWeeklyInput(s,s.start),s.start).rows[0].estimate).toBeNull();
  s.workers[0].linked_supervisor=true;expect(buildWeeklyPreview(parseWeeklyInput(s,s.start),s.start)).toMatchObject({rows:[],linkedSupervisors:1});
 });
 it('fails closed on malformed, duplicated, stale and unbounded inputs',()=>{
  const s=snapshot();expect(()=>parseWeeklyInput(s,'2026-11-16')).toThrow();
  expect(()=>parseWeeklyInput({...s,end:'2026-11-22'},s.start)).toThrow();
  expect(()=>parseWeeklyInput({...s,attendance:[s.attendance[0],s.attendance[0]]},s.start)).toThrow();
  expect(()=>parseWeeklyInput({...s,attendance:[{...s.attendance[0],hours_worked:'NaN'}]},s.start)).toThrow();
  expect(()=>parseWeeklyInput({...s,workers:[{...s.workers[0],pay_rate:'-1'}]},s.start)).toThrow();
  expect(()=>parseWeeklyInput({...s,vouchers:[{id:'v',worker_id:'missing',status:'paid'}]},s.start)).toThrow();
 });
});
