import {describe,expect,it} from 'vitest';
import {buildSupervisorPreview,parseDailyRate,parseSupervisorCatalog,parseSupervisorPreview,supervisorPeriodDates} from '@/lib/payroll/supervisorPreview';
const source={supervisor_id:'s',start:'2024-02-16',end:'2024-02-29',days:[{id:'a',date:'2024-02-16',work_status:'present',status:'approved'},{id:'b',date:'2024-02-17',work_status:'half_day',status:'approved'},{id:'c',date:'2024-02-18',work_status:'absent',status:'approved'}],leave:[{id:'l',start:'2024-02-19',end:'2024-02-20',status:'approved'}],identity_needs_review:false,legacy_count:0,overlapping_vouchers:0};
const parsed=(x:unknown=source)=>parseSupervisorPreview(x,'s','2024-02-16');
describe('Supervisor semi-monthly planning calculation',()=>{
 it('uses 1–15 or 16–month-end, including leap years and year end',()=>{
  expect(supervisorPeriodDates('2024-02-16')).toHaveLength(14);expect(supervisorPeriodDates('2023-02-16')).toHaveLength(13);
  expect(supervisorPeriodDates('2026-12-16').at(-1)).toBe('2026-12-31');expect(supervisorPeriodDates('2026-11-01')).toHaveLength(15);
  expect(()=>supervisorPeriodDates('2026-11-15')).toThrow();
 });
 it('counts approved full and half days once and approved leave as unpaid; unmarked is not absence',()=>{
  const result=buildSupervisorPreview(parsed(),'655.55','2024-02-25');
  expect(result.gross).toBe('983.33');expect(result.halfDayUnits).toBe(3n);expect(result.unmarkedPast).toBe(4);
  expect(result.days.find(d=>d.date==='2024-02-19')?.label).toBe('Approved leave · unpaid');
  expect(result.days.find(d=>d.date==='2024-02-21')?.label).toBe('Unmarked · past');expect(result.days.find(d=>d.date==='2024-02-26')?.label).toBe('Unmarked · upcoming');
 });
 it('does not infer zero when there are no approved records; approved leave alone shows zero',()=>{
  expect(buildSupervisorPreview(parsed({...source,days:[],leave:[]}),'600','2024-02-25').gross).toBeNull();
  expect(buildSupervisorPreview(parsed({...source,days:[],leave:source.leave}),'600','2024-02-25').gross).toBe('0.00');
 });
 it('withholds gross for overlapping vouchers, identity or legacy uncertainty, pending entries, or contradictory leave',()=>{
  for(const change of [{identity_needs_review:true},{legacy_count:1},{overlapping_vouchers:1},{days:[{...source.days[0],status:'pending'}]},{leave:[{...source.leave[0],status:'pending'}]},{leave:[{...source.leave[0],start:'2024-02-16'}]}]){
   const r=buildSupervisorPreview(parsed({...source,...change}),'600','2024-02-25');expect(r.gross).toBeNull();expect(r.reasons.length).toBeGreaterThan(0);
  }
 });
 it('validates rate, exact response period, bounded arrays and duplicate dates',()=>{
  for(const rate of ['0','-1','1.001','1e2','10000000000','01',''])expect(parseDailyRate(rate)).toBeNull();
  expect(parseDailyRate('0.01')).toBe(1n);expect(parseSupervisorCatalog({supervisors:[{id:'s',name:'Ada'}]})).toHaveLength(1);
  expect(()=>parseSupervisorCatalog({supervisors:[{id:'s',name:'A'},{id:'s',name:'B'}]})).toThrow();
  expect(()=>parsed({...source,end:'2024-02-28'})).toThrow();
  expect(()=>parsed({...source,days:[source.days[0],{...source.days[0],id:'z'}]})).toThrow();
  expect(()=>parsed({...source,leave:[{...source.leave[0],start:'2024-02-30'}]})).toThrow();
  expect(()=>parsed({...source,legacy_count:-1})).toThrow();
 });
});
