export type LeaveStatus='pending'|'approved'|'rejected';
export type SupervisorLeave={id:string;supervisor_name:string;start_date:string;end_date:string;kind:'normal'|'emergency';reason:string;status:LeaveStatus;submitted_at:string;reviewed_at:string|null;possible_paid_overlap:boolean|null;identity_needs_review:boolean|null};
export type SupervisorLeaveList={total:number;offset:number;items:SupervisorLeave[]};
function validDate(x:unknown):x is string {
 if(typeof x!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(x))return false;
 const d=new Date(`${x}T00:00:00Z`);return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===x;
}
export function parseSupervisorLeaveList(raw:unknown,founder:boolean,expectedOffset=0):SupervisorLeaveList {
 if(!raw||typeof raw!=='object')throw new Error('Invalid leave response');
 const v=raw as SupervisorLeaveList;
 if(!Number.isSafeInteger(v.total)||v.total<0||v.offset!==expectedOffset||!Array.isArray(v.items)||v.items.length!==Math.min(100,Math.max(0,v.total-v.offset)))throw new Error('Incomplete leave response');
 const ids=new Set<string>();
 for(const item of v.items){
  if(!item||typeof item.id!=='string'||!item.id||ids.has(item.id)||typeof item.supervisor_name!=='string'||!item.supervisor_name.trim()||!validDate(item.start_date)||!validDate(item.end_date)||item.end_date<item.start_date||!['normal','emergency'].includes(item.kind)||typeof item.reason!=='string'||item.reason.length>500||!['pending','approved','rejected'].includes(item.status)||typeof item.submitted_at!=='string'||!Number.isFinite(Date.parse(item.submitted_at))||(item.reviewed_at!==null&&(typeof item.reviewed_at!=='string'||!Number.isFinite(Date.parse(item.reviewed_at))))||(item.status==='pending')!==(item.reviewed_at===null))throw new Error('Invalid leave request');
  if(founder?(typeof item.possible_paid_overlap!=='boolean'||typeof item.identity_needs_review!=='boolean'):(item.possible_paid_overlap!==null||item.identity_needs_review!==null))throw new Error('Invalid leave review context');
  ids.add(item.id);
 }
 return v;
}
