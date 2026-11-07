/** STAGED, not exposed by any route. The caller must authenticate a Founder,
 * verify MFA, and independently verify the entire access rollout before use.
 * Database access and Supabase Auth are separate systems; neither a successful
 * ban nor this helper can recall in-flight requests or already-issued URLs. */
type Db={rpc:(name:string,args:Record<string,unknown>)=>PromiseLike<{data:unknown;error:unknown}>;auth:{admin:{updateUserById:(id:string,attributes:{ban_duration:string})=>Promise<{data:{user:{id:string}|null}|null;error:unknown}>}}};
type Result={ok:true;alreadyRevoked:boolean;authBanConfirmed:boolean;warning?:string}|{ok:false;error:string};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function revokeSupervisorAccess(input:{db:Db;actorId:string;targetId:string}):Promise<Result> {
  if(!uuid.test(input.actorId)||!uuid.test(input.targetId)||input.actorId===input.targetId) return {ok:false,error:'Choose another valid Supervisor account.'};
  let result:{data:unknown;error:unknown};
  try {result=await input.db.rpc('revoke_supervisor_access_guarded',{p_actor:input.actorId,p_target:input.targetId});}
  catch {return {ok:false,error:'Access change was not confirmed. Check the account before retrying; Auth was not changed.'};}
  if(result.error || (result.data!==true && result.data!==false)) return {ok:false,error:'Access change was not confirmed. Check the account before retrying; Auth was not changed.'};
  // A prior revocation can safely repeat the ban only once the database guard
  // prevents a blocked user from being promoted/deleted between these steps.
  // Auth failure is not rolled back: keeping the application gate closed is safer.
  try {
    const banned=await input.db.auth.admin.updateUserById(input.targetId,{ban_duration:'876000h'});
    if(!banned.error && banned.data?.user?.id===input.targetId) return {ok:true,alreadyRevoked:result.data===false,authBanConfirmed:true};
  } catch { /* an Auth response may be lost after the ban committed */ }
  return {ok:true,alreadyRevoked:result.data===false,authBanConfirmed:false,warning:'The access restriction was saved, but the login ban was not confirmed. An administrator must check Supabase Auth; do not assume existing sessions or links are revoked.'};
}
