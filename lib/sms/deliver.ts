import { sendPhilSMS, type SendSMSResult } from '@/lib/sms/philsms';

/**
 * The single place where an SMS is dispatched and its honest outcome is
 * recorded in `sms_logs`.
 *
 * Previously this three-step dance (insert pending → send → update with the
 * real result) was duplicated across the SMS route and twice inside the cron
 * route. Four copies meant a fix to the "never claim a message was sent when
 * it wasn't" rule had to be applied four times to stay true — so this helper
 * owns that rule now.
 *
 * Contract:
 *  - The attempt row is written BEFORE the gateway call, so a crash mid-send
 *    still leaves evidence that an attempt was made.
 *  - If the attempt cannot be recorded, NOTHING is sent (no unlogged messages).
 *  - `simulated` always means "not sent", and is never reported as success.
 */

type Row = Record<string, any>;

export interface SmsLogDb {
  from: (table: string) => any;
}

export interface DeliverAndLogSMSParams {
  db: SmsLogDb;
  recipient: string;
  phone: string;
  message: string;
  invoiceId?: string | null;
  /** Only present after the staged client-coordination migration. */
  clientId?: string;
  /** Staged coordination ledger link; omitted for existing manual sends. */
  reminderAttemptId?: string;
  /** Optional last authorization check after logging, before provider I/O. */
  beforeSend?: () => Promise<boolean>;
  /** Injection point for tests. Defaults to the real PhilSMS gateway. */
  send?: (params: { recipient: string; phone: string; message: string }) => Promise<SendSMSResult>;
}

export interface DeliverAndLogSMSResult {
  success: boolean;
  simulated: boolean;
  uncertain: boolean;
  logUpdateFailed?: boolean;
  statusLabel: string;
  error: string | null;
  providerStatus: string | null;
  providerMessageId: string | null;
  logId: string | null;
  log: Row | null;
  /** Set when the attempt could not even be recorded, so nothing was sent. */
  logWriteFailed?: boolean;
  /** The final check refused the send; no provider call occurred. */
  cancelled?: boolean;
}

export async function deliverAndLogSMS(
  params: DeliverAndLogSMSParams
): Promise<DeliverAndLogSMSResult> {
  const send = params.send ?? sendPhilSMS;

  const { data: pendingLog, error: insertError } = await params.db
    .from('sms_logs')
    .insert({
      invoice_id: params.invoiceId ?? null,
      ...(params.clientId ? {client_id:params.clientId} : {}),
      ...(params.reminderAttemptId ? {reminder_attempt_id:params.reminderAttemptId} : {}),
      recipient: params.recipient,
      phone: params.phone,
      message: params.message,
      status: 'pending',
      simulated: false,
    })
    .select('*')
    .single();

  if (insertError || !pendingLog) {
    return {
      success: false,
      simulated: false,
      uncertain: false,
      statusLabel: 'Not sent (could not record the attempt)',
      error: 'Failed to record the SMS attempt — no message was sent.',
      providerStatus: null,
      providerMessageId: null,
      logId: null,
      log: null,
      logWriteFailed: true,
    };
  }

  if (params.beforeSend) {
    let ready = false;
    try { ready = await params.beforeSend() === true; } catch { /* fail closed */ }
    if (!ready) {
      let logUpdateFailed = false;
      try {
        const { data, error } = await params.db.from('sms_logs').update({status:'failed',error_message:'Not sent: reminder details or settings could not be verified.',updated_at:new Date().toISOString()}).eq('id',pendingLog.id).select('*').maybeSingle();
        logUpdateFailed = Boolean(error || !data);
      } catch { logUpdateFailed = true; }
      return {success:false,simulated:false,uncertain:false,cancelled:true,logUpdateFailed,statusLabel:'Not sent',error:'Reminder details or settings could not be verified.',providerStatus:null,providerMessageId:null,logId:pendingLog.id,log:pendingLog};
    }
  }

  let result: SendSMSResult;
  try {
    result = await send({ recipient: params.recipient, phone: params.phone, message: params.message });
  } catch {
    // A thrown transport error can occur after the provider accepted the SMS.
    result = { success: false, uncertain: true, error: 'The gateway did not confirm the SMS outcome.' };
  }

  if (!result || typeof result !== 'object') result = { success: false, uncertain: true, error: 'The gateway did not confirm the SMS outcome.' };
  const simulated = result?.simulated === true;
  const success = result?.success === true && !simulated;
  const uncertain = !success && !simulated && result?.uncertain !== false;

  const update = success
    ? {
        status: 'sent',
        simulated: false,
        provider_status: result.providerStatus || 'success',
        provider_message_id: result.messageId || null,
        updated_at: new Date().toISOString(),
      }
    : {
        status: uncertain ? 'pending' : 'failed',
        simulated,
        provider_status: simulated ? 'simulation' : uncertain ? 'unconfirmed' : result.providerStatus || 'failed',
        error_message: result.error || 'Unknown gateway failure',
        updated_at: new Date().toISOString(),
      };

  let finalLog: Row | null = null;
  let logUpdateFailed = false;
  try {
    const response = await params.db.from('sms_logs').update(update).eq('id', pendingLog.id).select('*').single();
    finalLog = response.data;
    logUpdateFailed = Boolean(response.error || !finalLog);
  } catch { logUpdateFailed = true; }

  const error = success ? null : result.error || 'SMS dispatch failed';

  return {
    success,
    simulated,
    uncertain,
    logUpdateFailed,
    statusLabel: success ? 'Sent' : simulated ? 'Not sent (simulation mode)' : uncertain ? 'Unconfirmed' : 'Failed',
    error,
    providerStatus: update.provider_status ?? null,
    providerMessageId: success ? result.messageId || null : null,
    logId: (finalLog || pendingLog).id ?? null,
    log: finalLog || pendingLog,
  };
}
