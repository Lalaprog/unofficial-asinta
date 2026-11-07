/** Staged client for the coordination RPCs. No sending path uses this yet. */
type Db = { rpc: (name: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }> };
type Channel = 'email' | 'sms';
type Source = 'manual' | 'automatic';
type Outcome = 'accepted' | 'rejected' | 'cancelled' | 'unconfirmed';

/** A lost response is never treated as ownership. The possibly-created claim
 * remains blocked for review; the caller must not make a provider call. */
export async function reserveDelivery(db: Db, input: {invoiceId:string; channel:Channel; source:Source; attemptId:string}): Promise<'reserved'|'busy'|'duplicate'|'unavailable'> {
  try {
    const {data,error} = await db.rpc('reserve_reminder_delivery', {p_invoice_id:input.invoiceId,p_channel:input.channel,p_source:input.source,p_attempt_id:input.attemptId});
    if (!error && (data === 'reserved' || data === 'busy' || data === 'duplicate')) return data;
  } catch { /* An RPC error is not proof that a claim was not committed. */ }
  return 'unavailable';
}

/** A false or lost response is unconfirmed. Never assume a lock was released.
 * 'cancelled' is allowed only before dispatch, 'rejected' only for explicit
 * provider rejection; ambiguity must be recorded as 'unconfirmed'. */
export async function finishDelivery(db: Db, input: {invoiceId:string; channel:Channel; attemptId:string; outcome:Outcome}): Promise<boolean> {
  try {
    const {data,error} = await db.rpc('finish_reminder_delivery', {p_invoice_id:input.invoiceId,p_channel:input.channel,p_attempt_id:input.attemptId,p_outcome:input.outcome});
    return !error && data === true;
  } catch { return false; }
}
