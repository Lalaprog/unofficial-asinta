import type {SupabaseClient} from '@supabase/supabase-js';

export type AccountEditSnapshot = Awaited<ReturnType<typeof loadAccountEditSnapshot>>;

/** Compare fields the account editor can overwrite. This detects already
 * committed changes, but independent reads and the later write are not atomic. */
export function sameAccountEditSnapshot(a:AccountEditSnapshot,b:AccountEditSnapshot):boolean {
 const profile=(s:AccountEditSnapshot)=>[s.user.id,s.user.name,s.user.email,s.user.role,s.user.created_at];
 const worker=(s:AccountEditSnapshot)=>s.worker===null?null:[s.worker.id,s.worker.active,Number(s.worker.pay_rate),s.worker.pay_rate_type,s.worker.contact_number,s.worker.removed_at];
 return JSON.stringify([profile(a),worker(a),[...a.assignedProjectIds].sort()])===JSON.stringify([profile(b),worker(b),[...b.assignedProjectIds].sort()]);
}

/** Read the specific account's current linkage, not a possibly truncated shared list.
 * The two reads are not transactional and do not lock later concurrent changes. */
export async function loadAccountEditSnapshot(client:SupabaseClient,userId:string) {
 const [profile,worker,assignments]=await Promise.all([
  client.from('users').select('id,name,email,role,created_at').eq('id',userId).maybeSingle(),
  client.from('workers').select('id,active,pay_rate,pay_rate_type,contact_number,removed_at').eq('id',userId).maybeSingle(),
  client.from('project_supervisors').select('project_id',{count:'exact'}).eq('supervisor_id',userId).limit(1001),
 ]);
 if(profile.error||worker.error||assignments.error||!Array.isArray(assignments.data)||!Number.isSafeInteger(assignments.count)||assignments.count!==assignments.data.length||assignments.data.length>1000) throw Error('Account links unavailable or incomplete');
 const user=profile.data;
 if(!user||user.id!==userId||typeof user.name!=='string'||typeof user.email!=='string'||!['founder','supervisor'].includes(user.role)||typeof user.created_at!=='string'||Number.isNaN(Date.parse(user.created_at))) throw Error('Invalid account profile');
 const ids=assignments.data.map((row:unknown)=>{
  if(!row||typeof row!=='object'||typeof (row as {project_id?:unknown}).project_id!=='string'||!(row as {project_id:string}).project_id) throw Error('Invalid project assignment');
  return (row as {project_id:string}).project_id;
 });
 if(new Set(ids).size!==ids.length) throw Error('Duplicate project assignment');
 const w=worker.data;
 if(w!==null&&(!w||w.id!==userId||typeof w.active!=='boolean'||!['daily','hourly'].includes(w.pay_rate_type)||!['number','string'].includes(typeof w.pay_rate)||!Number.isFinite(Number(w.pay_rate))||Number(w.pay_rate)<0||!(w.contact_number===null||typeof w.contact_number==='string')||!(w.removed_at===null||typeof w.removed_at==='string'))) throw Error('Invalid linked workforce profile');
 return {user:user as {id:string;name:string;email:string;role:'founder'|'supervisor';created_at:string},assignedProjectIds:ids,worker:w as {id:string;active:boolean;pay_rate:number|string;pay_rate_type:'daily'|'hourly';contact_number:string|null;removed_at:string|null}|null};
}
