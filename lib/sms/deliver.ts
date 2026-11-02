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
}

export async function deliverAndLogSMS(
  params: DeliverAndLogSMSParams
): Promise<DeliverAndLogSMSResult> {
  const send = params.send ?? sendPhilSMS;

  const { data: pendingLog, error: insertError } = await params.db
    .from('sms_logs')
    .insert({
      invoice_id: params.invoiceId ?? null,
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

  const result = await send({
    recipient: params.recipient,
    phone: params.phone,
    message: params.message,
  });

  const simulated = Boolean(result.simulated);
  const success = Boolean(result.success) && !simulated;
  const uncertain = !success && !simulated && Boolean(result.uncertain);

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

  const { data: finalLog, error: updateError } = await params.db
    .from('sms_logs')
    .update(update)
    .eq('id', pendingLog.id)
    .select('*')
    .single();

  const error = success ? null : result.error || 'SMS dispatch failed';

  return {
    success,
    simulated,
    uncertain,
    logUpdateFailed: Boolean(updateError || !finalLog),
    statusLabel: success ? 'Sent' : simulated ? 'Not sent (simulation mode)' : uncertain ? 'Unconfirmed' : 'Failed',
    error,
    providerStatus: update.provider_status ?? null,
    providerMessageId: success ? result.messageId || null : null,
    logId: (finalLog || pendingLog).id ?? null,
    log: finalLog || pendingLog,
  };
}
