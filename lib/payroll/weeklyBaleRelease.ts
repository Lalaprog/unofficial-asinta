import {workerPayrollPeriod} from './periods';
export type WeeklyBaleRelease={request_id:string;worker_id:string;worker_name:string;project_id:string;project_name:string;amount:string;status:'approved_pending_payment'|'issued';release_date:string;issued_advance_id:string|null;assignment_review_required:boolean};
export type WeeklyBaleReleaseList={start:string;end:string;items:WeeklyBaleRelease[]};
/** Reject mismatched, truncated or duplicate results before allowing a release. */
export function parseWeeklyBaleReleaseList(raw:unknown,start:string):WeeklyBaleReleaseList {
 const week=workerPayrollPeriod(start);if(week.start!==start||!raw||typeof raw!=='object')throw new Error('Invalid weekly Bale list');
 const result=raw as WeeklyBaleReleaseList;
 if(result.start!==start||result.end!==week.end||!Array.isArray(result.items)||result.items.length>500)throw new Error('Incomplete weekly Bale list');
 const expected=new Date(`${start}T00:00:00Z`);expected.setUTCDate(expected.getUTCDate()+3);const releaseDate=expected.toISOString().slice(0,10),ids=new Set<string>();
 for(const item of result.items){
  if(!item||[item.request_id,item.worker_id,item.worker_name,item.project_id,item.project_name].some(x=>typeof x!=='string'||!x.trim())||ids.has(item.request_id)||!/^([1-9]\d{0,7}|0)\.\d{2}$/.test(item.amount)||item.amount==='0.00'||!['approved_pending_payment','issued'].includes(item.status)||typeof item.assignment_review_required!=='boolean'||item.release_date!==releaseDate||(item.status==='issued'?(typeof item.issued_advance_id!=='string'||!item.issued_advance_id):item.issued_advance_id!==null))throw new Error('Invalid weekly Bale request');
  ids.add(item.request_id);
 }
 return result;
}
