export type SupervisorDay={id:string;supervisor_name:string;work_date:string;work_status:'present'|'half_day'|'absent';status:'pending'|'approved'|'rejected';submitted_at:string;reviewed_at:string|null;approved_leave:boolean;pending_leave:boolean;legacy_self_records:number|null;possible_paid_overlap:boolean|null;identity_needs_review:boolean|null;sites:{id:string;name:string;has_entries:boolean}[]};
export type SupervisorDayList={total:number;offset:number;items:SupervisorDay[]};
function validDate(x:unknown):x is string {if(typeof x!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(x))return false;const d=new Date(`${x}T00:00:00Z`);return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===x;}
export function parseSupervisorDayList(raw:unknown,founder:boolean,expectedOffset=0):SupervisorDayList {
 if(!raw||typeof raw!=='object')throw new Error('Invalid attendance response');const list=raw as SupervisorDayList;
 if(!Number.isSafeInteger(list.total)||list.total<0||list.offset!==expectedOffset||!Array.isArray(list.items)||list.items.length!==Math.min(100,Math.max(0,list.total-list.offset)))throw new Error('Incomplete attendance response');
 const ids=new Set<string>();
 for(const item of list.items){
  if(!item||typeof item.id!=='string'||!item.id||ids.has(item.id)||typeof item.supervisor_name!=='string'||!item.supervisor_name.trim()||!validDate(item.work_date)||!['present','half_day','absent'].includes(item.work_status)||!['pending','approved','rejected'].includes(item.status)||typeof item.submitted_at!=='string'||!Number.isFinite(Date.parse(item.submitted_at))||(item.reviewed_at!==null&&(typeof item.reviewed_at!=='string'||!Number.isFinite(Date.parse(item.reviewed_at))))||(item.status==='pending')!==(item.reviewed_at===null)||typeof item.approved_leave!=='boolean'||typeof item.pending_leave!=='boolean'||!Array.isArray(item.sites)||item.sites.length>100)throw new Error('Invalid Supervisor attendance');
  if(founder?(typeof item.legacy_self_records!=='number'||!Number.isSafeInteger(item.legacy_self_records)||item.legacy_self_records<0||typeof item.possible_paid_overlap!=='boolean'||typeof item.identity_needs_review!=='boolean'):(item.legacy_self_records!==null||item.possible_paid_overlap!==null||item.identity_needs_review!==null))throw new Error('Invalid attendance review context');
  const siteIds=new Set<string>();for(const site of item.sites){if(!site||typeof site.id!=='string'||!site.id||siteIds.has(site.id)||typeof site.name!=='string'||!site.name.trim()||typeof site.has_entries!=='boolean')throw new Error('Invalid site indicator');siteIds.add(site.id);}
  ids.add(item.id);
 }
 return list;
}
