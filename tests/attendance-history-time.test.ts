import {describe,expect,it} from 'vitest';
import {parseHistoryTimeBatch} from '@/lib/attendance/historyTime';
import type {HistoryRecord} from '@/lib/attendance/history';
const row={id:'a',worker_id:'w',project_id:'site',date:'2024-11-03',status:'present',hours_worked:8,submitted_at:'2024-11-03T08:00:00+00:00',is_supervisor:false} as HistoryRecord;
const item={id:'a',worker_id:'w',project_id:'site',date:'2024-11-03',status:'present',hours_worked:8,submitted_at:'2024-11-03T08:00:00+00:00',detail:{regular_hours:'8.00',overtime_hours:'2.50',stale:false}};
describe('attendance time batch parser',()=>{
 it('matches every attendance snapshot and distinguishes missing from saved details',()=>{
  expect(parseHistoryTimeBatch({items:[item]},[row]).get('a')).toEqual(item.detail);expect(parseHistoryTimeBatch({items:[{...item,detail:null}]},[row]).get('a')).toBeNull();
 });
 it('rejects partial, duplicate, out-of-scope, changed and malformed data',()=>{
  for(const raw of [null,{}, {items:[]},{items:[{...item,id:'x'}]},{items:[{...item,project_id:'other'}]},{items:[{...item,hours_worked:7}]},{items:[{...item,submitted_at:'2024-11-03T08:00:00.000001+00:00'}]},{items:[{...item,detail:undefined}]},{items:[{...item,detail:{...item.detail,regular_hours:'9.00'}}]},{items:[{...item,detail:{...item.detail,overtime_hours:'17.00'}}]},{items:[{...item,detail:{...item.detail,stale:'false'}}]}])expect(()=>parseHistoryTimeBatch(raw,[row])).toThrow();
  expect(()=>parseHistoryTimeBatch({items:[item,item]},[row,row])).toThrow(/Duplicate/);
 });
});
