/** STAGED adapter. Must only be called by the coordinated dispatcher after its
 * final checks and unique claim. No route uses this function. Injecting the
 * sender is mandatory, so tests never contact SMTP. */
import type { SendEmailParams, SendEmailResult } from '@/lib/email/mailer';
import type { PreparedReminder } from './prepareEmail';
type Db={from:(table:string)=>any};
export type EmailDeliveryOutcome='accepted'|'rejected'|'cancelled'|'unconfirmed';
export async function deliverPreparedReminderEmail(input:{db:Db;prepared:PreparedReminder;attemptId:string;beforeSend:()=>Promise<boolean>;send:(p:SendEmailParams)=>Promise<SendEmailResult>}):Promise<EmailDeliveryOutcome> {
  if (!input.attemptId || !input.prepared.invoiceId || !input.prepared.recipient) return 'cancelled';
  let logId:string;
  try {
    const {data,error}=await input.db.from('email_logs').insert({
      invoice_id:input.prepared.invoiceId,recipient:input.prepared.recipient,
      subject:input.prepared.rendered.subject,body_text:input.prepared.rendered.bodyText,body_html:input.prepared.rendered.bodyHtml,
      template_type:'upcoming_reminder',template_version:input.prepared.templateVersion,
      status:'pending',sent_by:null,reminder_attempt_id:input.attemptId,idempotency_key:`automatic-reminder:${input.attemptId}`,
    }).select('id').single();
    if(error || typeof data?.id!=='string' || !data.id) return 'cancelled';
    logId=data.id;
  } catch {return 'cancelled';} // No provider call was made, even if the insert response was lost.
  // Logging may take time. Recheck controls and prepared details after the log
  // insert too; the caller must make a fresh authoritative read. This still
  // cannot stop a switch change in the tiny gap before provider I/O.
  let ready=false;
  try {ready=await input.beforeSend() === true;} catch { /* fail closed */ }
  if (!ready) {
    try {await input.db.from('email_logs').update({status:'failed',error_message:'Not sent: reminder details or settings could not be verified.'}).eq('id',logId);} catch { /* Review pending log; no provider call occurred. */ }
    return 'cancelled';
  }
  let result:SendEmailResult;
  try {result=await input.send({to:input.prepared.recipient,subject:input.prepared.rendered.subject,text:input.prepared.rendered.bodyText,html:input.prepared.rendered.bodyHtml});}
  catch {result={accepted:false,uncertain:true};}
  const outcome:EmailDeliveryOutcome=result?.accepted===true?'accepted':result?.uncertain===false?'rejected':'unconfirmed';
  const patch=outcome==='accepted'?{status:'accepted',provider_message_id:result.providerMessageId||null,sent_at:new Date().toISOString()}
    :outcome==='rejected'?{status:'failed',error_message:result?.error||'Mail server rejected the message.'}
    :{status:'pending',error_message:'Mail server acceptance was not confirmed.'};
  try {
    const {data,error}=await input.db.from('email_logs').update(patch).eq('id',logId).select('id').maybeSingle();
    if(error || data?.id!==logId) return 'unconfirmed';
  } catch {return 'unconfirmed';}
  return outcome;
}
