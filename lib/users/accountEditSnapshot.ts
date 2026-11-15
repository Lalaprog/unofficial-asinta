import type {SupabaseClient} from '@supabase/supabase-js';

type AccountUser = {id:string;name:string;email:string;role:'founder'|'supervisor';created_at:string};
type AccountWorker = {id:string;name:string;position:string;active:boolean;pay_rate:number|string;pay_rate_type:'daily'|'hourly';contact_number:string|null;removed_at:string|null};
export type AccountEditSnapshot = {user:AccountUser;assignedProjectIds:string[];worker:AccountWorker|null};

/** Validate browser-supplied or database-supplied snapshots before comparing them. */
export function parseAccountEditSnapshot(value:unknown,userId:string):AccountEditSnapshot {
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid account snapshot');
 const snapshot=value as Record<string,unknown>, user=snapshot.user as Record<string,unknown>|null;
 if(!user||typeof user!=='object'||user.id!==userId||typeof user.name!=='string'||typeof user.email!=='string'||!['founder','supervisor'].includes(String(user.role))||typeof user.created_at!=='string'||Number.isNaN(Date.parse(user.created_at)))throw Error('Invalid account profile');
 const ids=snapshot.assignedProjectIds;
 if(!Array.isArray(ids)||ids.length>1000||ids.some(id=>typeof id!=='string'||!id)||new Set(ids).size!==ids.length)throw Error('Invalid project assignments');
 const w=snapshot.worker as Record<string,unknown>|null;
 if(w!==null&&(!w||typeof w!=='object'||w.id!==userId||typeof w.name!=='string'||typeof w.position!=='string'||typeof w.active!=='boolean'||!['daily','hourly'].includes(String(w.pay_rate_type))||!['number','string'].includes(typeof w.pay_rate)||!Number.isFinite(Number(w.pay_rate))||Number(w.pay_rate)<0||!(w.contact_number===null||typeof w.contact_number==='string')||!(w.removed_at===null||typeof w.removed_at==='string')))throw Error('Invalid linked workforce profile');
 return {user:user as AccountUser,assignedProjectIds:ids as string[],worker:w as AccountWorker|null};
}

/** Detect already committed changes, including workforce name/position that the
 * editor overwrites. These reads and the eventual writes are not atomic. */
export function sameAccountEditSnapshot(a:AccountEditSnapshot,b:AccountEditSnapshot):boolean {
 const profile=(s:AccountEditSnapshot)=>[s.user.id,s.user.name,s.user.email,s.user.role,s.user.created_at];
 const worker=(s:AccountEditSnapshot)=>s.worker===null?null:[s.worker.id,s.worker.name,s.worker.position,s.worker.active,Number(s.worker.pay_rate),s.worker.pay_rate_type,s.worker.contact_number,s.worker.removed_at];
 return JSON.stringify([profile(a),worker(a),[...a.assignedProjectIds].sort()])===JSON.stringify([profile(b),worker(b),[...b.assignedProjectIds].sort()]);
}

/** Read the specific account's current linkage, not a possibly truncated shared list.
 * The reads are not transactional and do not lock later concurrent changes. */
export async function loadAccountEditSnapshot(client:Pick<SupabaseClient,'from'>,userId:string):Promise<AccountEditSnapshot> {
 const [profile,worker,assignments]=await Promise.all([
  client.from('users').select('id,name,email,role,created_at').eq('id',userId).maybeSingle(),
  client.from('workers').select('id,name,position,active,pay_rate,pay_rate_type,contact_number,removed_at').eq('id',userId).maybeSingle(),
  client.from('project_supervisors').select('project_id',{count:'exact'}).eq('supervisor_id',userId).limit(1001),
 ]);
 if(profile.error||worker.error||assignments.error||!Array.isArray(assignments.data)||!Number.isSafeInteger(assignments.count)||assignments.count!==assignments.data.length||assignments.data.length>1000)throw Error('Account links unavailable or incomplete');
 const ids=assignments.data.map((row:unknown)=>{
  if(!row||typeof row!=='object'||typeof (row as {project_id?:unknown}).project_id!=='string'||!(row as {project_id:string}).project_id)throw Error('Invalid project assignment');
  return (row as {project_id:string}).project_id;
 });
 return parseAccountEditSnapshot({user:profile.data,worker:worker.data,assignedProjectIds:ids},userId);
}
