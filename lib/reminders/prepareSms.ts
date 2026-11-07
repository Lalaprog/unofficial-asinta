/** Prepare an automatic reminder SMS from fresh records. No provider I/O.
 * The caller must enforce settings, history, schedule, reservations and a final
 * recheck. The fingerprint detects changes; it does not lock the underlying data.
 */
import { createHash } from 'node:crypto';
import { parseReminderInstant } from './planCatchUp';
import { normalizePhilippineMobile } from '@/lib/sms/phone';
import { buildReminderSMS, DEFAULT_SMS_TEMPLATE, validateSMSTemplate } from '@/lib/sms/templates';

type Db = {from:(table:string)=>any};
export type PreparedSms = {invoiceId:string;clientId:string;recipient:string;phone:string;message:string;fingerprint:string};
type Result = {ok:true;prepared:PreparedSms} | {ok:false;reason:string};
const text=(x:unknown):x is string=>typeof x==='string' && x.trim().length>0;
function amount(value:unknown):number {
  if (typeof value==='number') return value;
  return typeof value==='string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim()) ? Number(value) : NaN;
}
function date(value:unknown):value is string {
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed=new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0,10)===value;
}

export async function prepareReminderSms(params:{db:Db;invoiceId:string;now:Date}):Promise<Result> {
  try {
    if (!text(params.invoiceId) || !(params.now instanceof Date) || !Number.isFinite(params.now.getTime())) return {ok:false,reason:'invalid_request'};
    const {data:invoice,error} = await params.db.from('invoices').select('id,invoice_number,client_id,project_id,amount,amount_paid,due_date,status,automatic_reminders_enabled,reminders_paused_until').eq('id',params.invoiceId).maybeSingle();
    if(error || !invoice || invoice.id!==params.invoiceId) return {ok:false,reason:'invoice_unavailable'};
    const total=amount(invoice.amount),paid=amount(invoice.amount_paid);
    if(!['pending','partially_paid','overdue'].includes(invoice.status) || invoice.automatic_reminders_enabled!==true || !Number.isFinite(total) || !Number.isFinite(paid) || total<0 || paid<0 || total<=paid) return {ok:false,reason:'invoice_ineligible'};
    if(invoice.reminders_paused_until !== null && (!parseReminderInstant(invoice.reminders_paused_until) || Date.parse(invoice.reminders_paused_until)>params.now.getTime())) return {ok:false,reason:'invoice_paused_or_invalid'};
    if (!date(invoice.due_date) || !text(invoice.invoice_number) || !text(invoice.client_id) || !text(invoice.project_id)) return {ok:false,reason:'invoice_details_invalid'};
    const [clientResult,projectResult,templateResult,emailResult] = await Promise.all([
      params.db.from('clients').select('id,name,contact_person,phone').eq('id',invoice.client_id).maybeSingle(),
      params.db.from('projects').select('id,name').eq('id',invoice.project_id).maybeSingle(),
      params.db.from('sms_template_settings').select('message_template').eq('singleton',true).maybeSingle(),
      params.db.from('email_logs').select('sent_at').eq('invoice_id',invoice.id).eq('template_type','initial_request').in('status',['accepted','delivered']).order('sent_at',{ascending:false}).limit(1).maybeSingle(),
    ]);
    const client=clientResult.data,project=projectResult.data,row=templateResult.data,email=emailResult.data;
    if(clientResult.error || !client || client.id!==invoice.client_id || !text(client.name)) return {ok:false,reason:'recipient_unavailable'};
    const phone=normalizePhilippineMobile(client.phone);
    if(!phone) return {ok:false,reason:'recipient_unavailable'};
    if(projectResult.error || !project || project.id!==invoice.project_id || !text(project.name)) return {ok:false,reason:'project_unavailable'};
    if(templateResult.error || row===undefined || (row!==null && (typeof row!=='object' || Array.isArray(row)))) return {ok:false,reason:'template_unavailable'};
    const template=row===null?DEFAULT_SMS_TEMPLATE:row.message_template;
    if(typeof template!=='string' || !validateSMSTemplate(template).valid) return {ok:false,reason:'template_invalid'};
    if(emailResult.error || email===undefined || (email!==null && (!email || typeof email!=='object' || !parseReminderInstant(email.sent_at)))) return {ok:false,reason:'email_history_unavailable'};
    const recipient=text(client.contact_person)?client.contact_person.trim():client.name.trim();
    const message=buildReminderSMS({contactPerson:client.contact_person,companyName:client.name,invoiceNumber:invoice.invoice_number,projectName:project.name,outstandingBalance:total-paid,dueDate:invoice.due_date,paymentRequestSentDate:email?.sent_at ?? null},template);
    if(!message.trim() || message.length>1000) return {ok:false,reason:'message_too_long'};
    const fingerprint=createHash('sha256').update(JSON.stringify({invoice,recipient,phone,message,template,emailSentAt:email?.sent_at??null})).digest('hex');
    return {ok:true,prepared:{invoiceId:invoice.id,clientId:client.id,recipient,phone,message,fingerprint}};
  } catch {return {ok:false,reason:'preparation_unavailable'};}
}
