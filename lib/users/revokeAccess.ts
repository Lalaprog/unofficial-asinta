/** STAGED: the caller must authenticate a Founder, verify assurance, and
 * complete the access rollout review. Database access and Supabase Auth are
 * separate systems. Neither a ban nor this helper can recall in-flight work,
 * already-issued URLs or data that was copied before deactivation. */
type AuthUser = {id:string; banned_until?:string | null};
type AuthReply = {data:{user:AuthUser | null} | null;error:unknown};
type Db = {
  rpc:(name:string,args:Record<string,unknown>)=>PromiseLike<{data:unknown;error:unknown}>;
  auth:{admin:{updateUserById:(id:string,attributes:{ban_duration:string})=>Promise<AuthReply>;getUserById:(id:string)=>Promise<AuthReply>}};
};
type Result={ok:true;alreadyRevoked:boolean;authBanConfirmed:boolean;warning?:string}|{ok:false;error:string};
export type AccessState={ok:true;state:'active'|'revoked';authBan:'confirmed'|'unconfirmed'|'not_checked'} | {ok:false;error:string};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const validPair=(actor:string,target:string)=>uuid.test(actor)&&uuid.test(target)&&actor!==target;
// A short-lived ban is not adequate for an account intended to stay inactive.
const DAY_MS=24*60*60*1000;
const banConfirmed=(user:AuthUser | null | undefined,target:string,now:number,minDays:number)=>
  user?.id===target && typeof user.banned_until==='string' && Number.isFinite(Date.parse(user.banned_until)) && Date.parse(user.banned_until)>=now+minDays*DAY_MS;

/** Read-only recovery check; `unconfirmed` includes missing, expired or unreadable Auth state. */
export async function readSupervisorAccess(input:{db:Db;actorId:string;targetId:string;now?:()=>number}):Promise<AccessState> {
  if(!validPair(input.actorId,input.targetId))return {ok:false,error:'Choose another valid Supervisor account.'};
  try {
    const result=await input.db.rpc('supervisor_access_state_guarded',{p_actor:input.actorId,p_target:input.targetId});
    if(result.error || (result.data!=='active' && result.data!=='revoked'))return {ok:false,error:'Account access could not be verified. Refresh before making changes.'};
    if(result.data==='active')return {ok:true,state:'active',authBan:'not_checked'};
    try {
      const auth=await input.db.auth.admin.getUserById(input.targetId);
      return {ok:true,state:'revoked',authBan:!auth.error && banConfirmed(auth.data?.user,input.targetId,(input.now??Date.now)(),365)?'confirmed':'unconfirmed'};
    } catch {return {ok:true,state:'revoked',authBan:'unconfirmed'};}
  } catch {return {ok:false,error:'Account access could not be verified. Refresh before making changes.'};}
}

export async function revokeSupervisorAccess(input:{db:Db;actorId:string;targetId:string;now?:()=>number}):Promise<Result> {
  if(!validPair(input.actorId,input.targetId)) return {ok:false,error:'Choose another valid Supervisor account.'};
  let result:{data:unknown;error:unknown};
  try {result=await input.db.rpc('revoke_supervisor_access_guarded',{p_actor:input.actorId,p_target:input.targetId});}
  catch {return {ok:false,error:'Access change was not confirmed. Check the account before retrying; Auth was not changed.'};}
  if(result.error || (result.data!==true && result.data!==false)) return {ok:false,error:'Access change was not confirmed. Check the account before retrying; Auth was not changed.'};
  // Retrying an already-revoked Supervisor can safely request the ban again;
  // the DB guard blocks promotion/deletion between the DB and Auth operations.
  try {
    const banned=await input.db.auth.admin.updateUserById(input.targetId,{ban_duration:'876000h'});
    if(!banned.error && banConfirmed(banned.data?.user,input.targetId,(input.now??Date.now)(),99*365)) return {ok:true,alreadyRevoked:result.data===false,authBanConfirmed:true};
  } catch { /* an Auth response may be lost after the ban committed */ }
  return {ok:true,alreadyRevoked:result.data===false,authBanConfirmed:false,warning:'The access restriction was saved, but the login ban was not confirmed. Check the account status or retry the ban; do not assume existing sessions or links are revoked.'};
}
