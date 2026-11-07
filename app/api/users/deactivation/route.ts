import {NextRequest,NextResponse} from 'next/server';
import {requireFounder} from '@/lib/auth/serverRole';
import {createServerSupabaseClient} from '@/lib/supabase/server';
import {createServiceRoleClient,isServiceRoleConfigured} from '@/lib/supabase/admin';
import {readSupervisorAccess,revokeSupervisorAccess} from '@/lib/users/revokeAccess';

export const runtime='nodejs';
export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store'};
const reply=(body:unknown,status=200)=>NextResponse.json(body,{status,headers});
// Never switch this on until the staged database, all bypass paths and hosted
// Auth/recovery behavior have been reviewed together and rollout is approved.
const enabled=()=>process.env.TEAM_DEACTIVATION_ENABLED==='true';

async function authorize() {
  const founder=await requireFounder(createServerSupabaseClient());
  if(!founder.ok || !founder.userId)return {error:reply({ok:false,error:founder.error||'Founder access is required.'},founder.status)};
  if(!enabled() || !isServiceRoleConfigured())return {error:reply({ok:false,available:false,error:'Account deactivation is not available yet.'},503)};
  return {founder,admin:createServiceRoleClient()};
}
export async function GET(req:NextRequest) {
  try {
    const auth=await authorize();if(auth.error || !auth.admin || !auth.founder?.userId)return auth.error!;
    const result=await readSupervisorAccess({db:auth.admin as any,actorId:auth.founder.userId,targetId:req.nextUrl.searchParams.get('id')||''});
    return reply({...result,available:true},result.ok?200:503);
  } catch {return reply({ok:false,available:enabled(),error:'Account access could not be verified. Refresh before making changes.'},503);}
}
export async function POST(req:NextRequest) {
  try {
    const auth=await authorize();if(auth.error || !auth.admin || !auth.founder?.userId)return auth.error!;
    const body=await req.json().catch(()=>null);
    if(!body || body.confirmation!=='DEACTIVATE' || typeof body.userId!=='string')return reply({ok:false,error:'Confirm the Supervisor account before continuing.'},400);
    const result=await revokeSupervisorAccess({db:auth.admin as any,actorId:auth.founder.userId,targetId:body.userId});
    return reply(result,result.ok?200:503);
  } catch {return reply({ok:false,error:'Access change was not confirmed. Check the account and login status before trying again.'},503);}
}
