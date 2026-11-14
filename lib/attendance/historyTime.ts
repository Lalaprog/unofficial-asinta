import type {HistoryRecord} from './history';
export type HistoryTimeDetail={regular_hours:string;overtime_hours:string;stale:boolean};
export type HistoryTimeItem={id:string;worker_id:string;project_id:string;date:string;status:string;hours_worked:number|null;submitted_at:string|null;detail:HistoryTimeDetail|null};
const hours=/^(?:0|[1-9]\d?)\.\d{2}$/;
/** All requested IDs and their attendance snapshot must match; no inferred zeroes. */
export function parseHistoryTimeBatch(raw:unknown,records:HistoryRecord[]):Map<string,HistoryTimeDetail|null>{
 if(!raw||typeof raw!=='object'||!('items' in raw)||!Array.isArray(raw.items)||raw.items.length!==records.length||records.length<1||records.length>100)throw new Error('Incomplete time details');
 const expected=new Map(records.map(r=>[r.id,r]));if(expected.size!==records.length)throw new Error('Duplicate attendance IDs');
 const result=new Map<string,HistoryTimeDetail|null>();
 for(const value of raw.items){
  if(!value||typeof value!=='object')throw new Error('Invalid time details');
  const item=value as HistoryTimeItem,record=expected.get(item.id);
  if(!record||result.has(item.id)||item.worker_id!==record.worker_id||item.project_id!==record.project_id||item.date!==record.date||item.status!==record.status||item.hours_worked!==record.hours_worked||item.submitted_at!==record.submitted_at)throw new Error('Attendance changed; refresh history');
  const detail=item.detail;
  if(detail!==null&&(!detail||typeof detail!=='object'||typeof detail.regular_hours!=='string'||!hours.test(detail.regular_hours)||typeof detail.overtime_hours!=='string'||!hours.test(detail.overtime_hours)||typeof detail.stale!=='boolean'||Number(detail.regular_hours)>8||Number(detail.regular_hours)+Number(detail.overtime_hours)>24))throw new Error('Invalid time details');
  result.set(item.id,detail);
 }
 return result;
}
