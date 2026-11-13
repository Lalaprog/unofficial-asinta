import type {AdvanceRequestStatus} from '@/types';
import {workerPayrollPeriod} from '@/lib/payroll/periods';
export type WeeklyBaleStatus={id:string;kind:'weekly'|'legacy';stored_status:AdvanceRequestStatus;effective_status:AdvanceRequestStatus|'expired_unapproved';period_start:string|null;auto_expired:boolean;can_review:boolean};
export type WeeklyBaleStatuses={as_of:string;items:WeeklyBaleStatus[]};
const statuses=['pending_approval','approved_pending_payment','rejected','issued'];
/** Require one unambiguous status per requested ID; never turn an error into an empty list. */
export function parseWeeklyBaleStatuses(raw:unknown,ids:string[]):WeeklyBaleStatuses {
 if(!raw||typeof raw!=='object')throw new Error('Invalid weekly Bale status');
 const result=raw as WeeklyBaleStatuses;
 if(typeof result.as_of!=='string'||!Number.isFinite(Date.parse(result.as_of))||!Array.isArray(result.items)||result.items.length!==ids.length||ids.length>500||new Set(ids).size!==ids.length)throw new Error('Incomplete weekly Bale status');
 const expected=new Set(ids),seen=new Set<string>();
 for(const item of result.items){
  if(!item||!expected.has(item.id)||seen.has(item.id)||!statuses.includes(item.stored_status)||!['weekly','legacy'].includes(item.kind)||typeof item.auto_expired!=='boolean'||typeof item.can_review!=='boolean')throw new Error('Invalid weekly Bale status');
  if(item.kind==='legacy'){
   if(item.period_start!==null||item.effective_status!==item.stored_status||item.can_review||item.auto_expired)throw new Error('Invalid legacy Bale status');
  }else{
   try{if(typeof item.period_start!=='string'||workerPayrollPeriod(item.period_start).start!==item.period_start)throw new Error();}catch{throw new Error('Invalid weekly Bale period');}
   if(item.effective_status!==item.stored_status&&!(item.stored_status==='pending_approval'&&item.effective_status==='expired_unapproved'))throw new Error('Invalid effective Bale status');
   if(item.auto_expired&&item.stored_status!=='rejected'||item.can_review&&(item.stored_status!=='pending_approval'||item.effective_status!=='pending_approval'))throw new Error('Invalid weekly Bale decision');
  }
  seen.add(item.id);
 }
 return result;
}
