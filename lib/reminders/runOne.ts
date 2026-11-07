/** Coordinated one-invoice/channel dispatcher, reachable only through the
 * default-off cron rollout path. Hosted SQL, scheduler, legacy history and
 * provider behavior still require verification before enabling it. Injected
 * callbacks are the only provider I/O here. Final checks are not data locks. */
import {isReminderSettings} from './settings';
import {planReminderChannels} from './planChannels';
import {dispatchOne,type DispatchSnapshot,type DispatchOneResult} from './dispatchOne';
import {reserveDelivery,claimAutomaticSlot,finishDelivery,readContactHistory} from './coordination';
import {prepareReminderEmail,type PreparedReminder} from './prepareEmail';
import {prepareReminderSms,type PreparedSms} from './prepareSms';
import {deliverPreparedReminderEmail} from './deliverEmail';
import {deliverPreparedReminderSms} from './deliverSms';
import type {SendEmailParams,SendEmailResult} from '@/lib/email/mailer';
import type {SendSMSResult} from '@/lib/sms/philsms';

type Db={from:(table:string)=>any;rpc:(name:string,args:Record<string,unknown>)=>PromiseLike<{data:unknown;error:unknown}>};
type Channel='email'|'sms';
type Prepared={channel:'email';value:PreparedReminder}|{channel:'sms';value:PreparedSms};
type Snapshot=DispatchSnapshot & {prepared:Prepared};
const invoiceFields='id,due_date,status,amount,amount_paid,client_id,project_id,automatic_reminders_enabled,reminders_paused_until,reminder_invoice_effective_since,reminder_schedule_effective_since';
const settingsFields='master_enabled,email_enabled,sms_enabled,revision,email_effective_since,sms_effective_since';
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);

export async function runOneReminder(input:{db:Db;invoiceId:string;channel:Channel;attemptId:string;now:()=>Date;automationAllowed:()=>boolean;providerReady:(channel:Channel)=>boolean;firmEmail:string;firmContactNumber:string;sendEmail:(p:SendEmailParams)=>Promise<SendEmailResult>;sendSms:(p:{recipient:string;phone:string;message:string})=>Promise<SendSMSResult>}):Promise<DispatchOneResult> {
  const {db,invoiceId,channel,attemptId}=input;
  async function read():Promise<Snapshot|null> {
    try {
      if (!input.automationAllowed() || !input.providerReady(channel)) return null;
      const now=input.now();
      const readSettings=()=>db.from('reminder_settings').select(settingsFields).eq('singleton',true).maybeSingle();
      const readInvoice=()=>db.from('invoices').select(invoiceFields).eq('id',invoiceId).maybeSingle();
      const [settingsResult,invoiceResult,history]=await Promise.all([readSettings(),readInvoice(),readContactHistory(db,{invoiceId,channel,ownAttemptId:attemptId})]);
      const settings=settingsResult.data, invoice=invoiceResult.data;
      if(settingsResult.error || invoiceResult.error || !isReminderSettings(settings) || !settings.master_enabled || !invoice || invoice.id!==invoiceId || !history) return null;
      const enabled=channel==='email'?settings.email_enabled:settings.sms_enabled;
      const epochs=settings as typeof settings & {email_effective_since?:unknown;sms_effective_since?:unknown};
      const effective=channel==='email'?epochs.email_effective_since:epochs.sms_effective_since;
      if (enabled!==true || typeof effective!=='string' || typeof invoice.reminder_invoice_effective_since!=='string' || typeof invoice.reminder_schedule_effective_since!=='string' || typeof invoice.due_date!=='string' || !(invoice.reminders_paused_until===null || typeof invoice.reminders_paused_until==='string')) return null;
      let prepared:Prepared;
      if(channel==='email') {
        const result=await prepareReminderEmail({db,invoiceId,now,firmEmail:input.firmEmail,firmContactNumber:input.firmContactNumber});
        if(!result.ok)return null; prepared={channel,value:result.prepared};
      } else {
        const result=await prepareReminderSms({db,invoiceId,now});if(!result.ok)return null;prepared={channel,value:result.prepared};
      }
      // Never combine schedule/epoch data read from one invoice revision with a
      // message prepared from another. These rechecks do not lock future changes.
      const [latestSettings,latestInvoice]=await Promise.all([readSettings(),readInvoice()]);
      if(latestSettings.error || latestInvoice.error || !same(settings,latestSettings.data) || !same(invoice,latestInvoice.data) || !input.automationAllowed() || !input.providerReady(channel)) return null;
      const active={enabled:true,effectiveSince:effective,lastContactAt:history.lastContactAt,unresolvedAttempt:history.unresolvedAttempt};
      const disabled={enabled:false,effectiveSince:null,lastContactAt:null,unresolvedAttempt:false};
      // Use the clock at the END of the read, not before slow database work.
      return {masterEnabled:true,dueDate:invoice.due_date,now:input.now(),invoiceEffectiveSince:invoice.reminder_invoice_effective_since,scheduleEffectiveSince:invoice.reminder_schedule_effective_since,pausedUntil:invoice.reminders_paused_until,channels:channel==='email'?{email:active,sms:disabled}:{email:disabled,sms:active},fingerprint:prepared.value.fingerprint,providerReady:true,prepared};
    } catch {return null;}
  }
  return dispatchOne({channel,attemptId,deps:{
    read,
    reserve:(id)=>reserveDelivery(db,{invoiceId,channel,source:'automatic',attemptId:id}),
    claim:(slot,id)=>claimAutomaticSlot(db,{invoiceId,channel,attemptId:id,scheduledDate:slot.scheduledDate,type:slot.type}),
    finish:(id,outcome)=>finishDelivery(db,{invoiceId,channel,attemptId:id,outcome}),
    send:async(generic)=>{
      const snapshot=generic as Snapshot;
      const plan=planReminderChannels(snapshot)[channel];
      if(!plan.ok || snapshot.prepared.channel!==channel) return 'cancelled';
      const beforeSend=async()=>{
        const fresh=await read();if(!fresh || fresh.fingerprint!==snapshot.fingerprint)return false;
        const freshPlan=planReminderChannels(fresh)[channel];
        return freshPlan.ok && freshPlan.slot.type===plan.slot.type && freshPlan.slot.scheduledDate===plan.slot.scheduledDate;
      };
      return snapshot.prepared.channel==='email'
        ? deliverPreparedReminderEmail({db,prepared:snapshot.prepared.value,attemptId,beforeSend,send:input.sendEmail})
        : deliverPreparedReminderSms({db,prepared:snapshot.prepared.value,attemptId,beforeSend,send:input.sendSms});
    },
  }});
}
