/** Coordinated adapter; its caller must own a reservation and slot and provide
 * a fresh final check. Tests inject a sender; no test sends SMS. */
import {deliverAndLogSMS, type SmsLogDb} from '@/lib/sms/deliver';
import type {SendSMSResult} from '@/lib/sms/philsms';
import type {PreparedSms} from './prepareSms';
import type {EmailDeliveryOutcome} from './deliverEmail';

export async function deliverPreparedReminderSms(input:{db:SmsLogDb;prepared:PreparedSms;attemptId:string;beforeSend:()=>Promise<boolean>;send:(p:{recipient:string;phone:string;message:string})=>Promise<SendSMSResult>}):Promise<EmailDeliveryOutcome> {
  const result=await deliverAndLogSMS({db:input.db,invoiceId:input.prepared.invoiceId,clientId:input.prepared.clientId,reminderAttemptId:input.attemptId,recipient:input.prepared.recipient,phone:input.prepared.phone,message:input.prepared.message,beforeSend:input.beforeSend,send:input.send});
  if (result.logWriteFailed || result.cancelled || result.simulated) return 'cancelled';
  if (result.uncertain || result.logUpdateFailed) return 'unconfirmed';
  return result.success ? 'accepted' : 'rejected';
}
