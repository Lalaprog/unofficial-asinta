import { randomUUID } from 'node:crypto';
import { runReminderBatch } from '@/lib/reminders/runBatch';
import { runOneReminder } from '@/lib/reminders/runOne';
import { isSmtpConfigured, sendEmail, getFirmEmailIdentity } from '@/lib/email/mailer';
import { sendPhilSMS } from '@/lib/sms/philsms';
import { createServiceRoleClient, isServiceRoleConfigured } from '@/lib/supabase/admin';
import { readReminderSettings } from '@/lib/reminders/settings';
import { isGlobalAutomaticRemindersEnabled, isWithinSendingHours } from '@/lib/reminders/scheduler';

/** The browser and scheduled entry points share the same off-by-default gates. */
export async function runCoordinatedReminderScan() {
  if (process.env.REMINDER_COORDINATION_ENABLED !== 'true') return {body:{ran:false,reason:'coordination_disabled'},status:200};
  if (!isGlobalAutomaticRemindersEnabled()) return {body:{ran:false,reason:'automatic_reminders_globally_disabled'},status:200};
  if (!isWithinSendingHours(new Date())) return {body:{ran:false,reason:'outside_sending_hours'},status:200};
  if (!isServiceRoleConfigured()) return {body:{error:'Reminder service unavailable; no messages were sent.'},status:503};
  const db=createServiceRoleClient();
  const firm=getFirmEmailIdentity();
  const allowed=()=>process.env.REMINDER_COORDINATION_ENABLED==='true' && isGlobalAutomaticRemindersEnabled() && isWithinSendingHours(new Date());
  const batch=await runReminderBatch({allowed,clock:()=>Date.now(),settings:()=>readReminderSettings(db),
    next:async()=>{const {data,error}=await db.rpc('next_reminder_scan_invoice');return {ok:!error,invoiceId:data};},
    run:(invoiceId,channel)=>runOneReminder({db:db as any,invoiceId,channel,attemptId:randomUUID(),now:()=>new Date(),automationAllowed:allowed,
      providerReady:c=>c==='email'?isSmtpConfigured():Boolean((process.env.PHILSMS_API_KEY||'').trim()),
      firmEmail:firm.replyTo||firm.fromAddress,firmContactNumber:firm.firmContactNumber,sendEmail,sendSms:sendPhilSMS}),
  });
  return {body:batch,status:['settings_unavailable','scan_unavailable'].includes(batch.reason||'')?503:200};
}
