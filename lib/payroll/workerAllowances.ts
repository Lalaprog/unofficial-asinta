export type AllowanceStatus = 'pending' | 'approved' | 'rejected';
export type AllowanceItem = {id:string;amount:string;description:string;status:AllowanceStatus;submitted_at:string;reviewed_at:string|null;stale:boolean};
export type AllowancePending = {id:string;worker_name:string;worker_position:string;project_name:string;date:string;amount:string;description:string;submitted_at:string;stale:boolean;finalized:boolean};
const validAmount=(x:unknown):x is string=>typeof x==='string' && /^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/.test(x) && Number(x)>0;
export function parseAllowances(value:unknown):AllowanceItem[]{
 if(!Array.isArray(value)||value.length>100)throw new Error('Invalid allowance list');
 const ids=new Set<string>();
 for(const v of value){if(!v||typeof v.id!=='string'||ids.has(v.id)||!validAmount(v.amount)||typeof v.description!=='string'||!['pending','approved','rejected'].includes(v.status)||typeof v.submitted_at!=='string'||(v.reviewed_at!==null&&typeof v.reviewed_at!=='string')||typeof v.stale!=='boolean')throw new Error('Invalid allowance list');ids.add(v.id);}
 return value as AllowanceItem[];
}
export function parsePendingAllowances(value:unknown):AllowancePending[]{
 if(!Array.isArray(value)||value.length>500)throw new Error('Invalid allowance queue');
 const ids=new Set<string>();
 for(const v of value){if(!v||typeof v.id!=='string'||ids.has(v.id)||typeof v.worker_name!=='string'||typeof v.worker_position!=='string'||typeof v.project_name!=='string'||typeof v.date!=='string'||!validAmount(v.amount)||typeof v.description!=='string'||typeof v.submitted_at!=='string'||typeof v.stale!=='boolean'||typeof v.finalized!=='boolean')throw new Error('Invalid allowance queue');ids.add(v.id);}
 return value as AllowancePending[];
}
