import {NextRequest,NextResponse} from 'next/server';
import {createServerSupabaseClient} from '@/lib/supabase/server';
import {createServiceRoleClient,isServiceRoleConfigured} from '@/lib/supabase/admin';
import {requireFounder} from '@/lib/auth/serverRole';
export const runtime='nodejs';export const dynamic='force-dynamic';
const reply=(body:unknown,status=200)=>NextResponse.json(body,{status,headers:{'Cache-Control':'private, no-store'}});
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function authorize(){const founder=await requireFounder(createServerSupabaseClient());if(!founder.ok||!founder.userId)return {error:reply({ok:false,error:founder.error||'Founder access is required.'},founder.status)};
  if(process.env.REMINDER_COORDINATION_ENABLED!=='true'||!isServiceRoleConfigured())return {error:reply({ok:false,available:false},503)};
  return {founder,db:createServiceRoleClient()};}
export async function GET(){try{const auth=await authorize();if(auth.error||!auth.db||!auth.founder?.userId)return auth.error!;
  const {data,error}=await auth.db.rpc('list_reminder_delivery_reviews_needed',{p_actor:auth.founder.userId});
  if(error||!data||typeof data!=='object'||!Array.isArray(data.attempts)||typeof data.hasMore!=='boolean')return reply({ok:false,available:true,error:'Could not check messages needing review.'},503);
  const legacy=await auth.db.rpc('list_legacy_reminder_reviews_needed',{p_actor:auth.founder.userId});
  if(legacy.error||!legacy.data||typeof legacy.data!=='object'||!Array.isArray(legacy.data.records)||typeof legacy.data.hasMore!=='boolean')return reply({ok:false,available:true,error:'Could not check older message history.'},503);
  return reply({ok:true,available:true,...data,legacyRecords:legacy.data.records,legacyHasMore:legacy.data.hasMore});
 }catch{return reply({ok:false,available:process.env.REMINDER_COORDINATION_ENABLED==='true',error:'Could not check messages needing review.'},503);}}
export async function POST(req:NextRequest){try{const auth=await authorize();if(auth.error||!auth.db||!auth.founder?.userId)return auth.error!;const body=await req.json().catch(()=>null);
  if(!body||!['accepted','rejected','cancelled'].includes(body.outcome)||typeof body.evidence!=='string'||body.evidence.trim().length<20||body.evidence.trim().length>500||body.noSenderRunning!==true||!['email','sms'].includes(body.channel))return reply({ok:false,error:'Check the outcome, evidence and confirmation.'},400);
  let name:string,args:Record<string,unknown>;
  if(['email_log','sms_log','dispatch'].includes(body.kind) && uuid.test(body.recordId||'')){name='review_legacy_reminder_record';args={p_actor:auth.founder.userId,p_kind:body.kind,p_record_id:body.recordId,p_outcome:body.outcome,p_evidence:body.evidence.trim(),p_confirm_no_sender_running:true};}
  else if(uuid.test(body.attemptId||'') && body.invoiceId && uuid.test(body.invoiceId)){name='review_reminder_delivery';args={p_actor:auth.founder.userId,p_invoice_id:body.invoiceId,p_channel:body.channel,p_attempt_id:body.attemptId,p_outcome:body.outcome,p_evidence:body.evidence.trim(),p_confirm_no_sender_running:true};}
  else if(uuid.test(body.attemptId||'') && body.invoiceId===null && body.channel==='sms' && uuid.test(body.clientId||'')){name='review_client_sms_delivery';args={p_actor:auth.founder.userId,p_client_id:body.clientId,p_attempt_id:body.attemptId,p_outcome:body.outcome,p_evidence:body.evidence.trim(),p_confirm_no_sender_running:true};}
  else return reply({ok:false,error:'Choose a valid message to review.'},400);
  const {data,error}=await auth.db.rpc(name,args);
  if(error||data!==true)return reply({ok:false,error:'Review was not confirmed. Refresh the list before retrying.'},503);
  return reply({ok:true});
 }catch{return reply({ok:false,error:'Review was not confirmed. Refresh the list before retrying.'},503);}}
