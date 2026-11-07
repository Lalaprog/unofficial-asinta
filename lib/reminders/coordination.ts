/** Client for staged coordination RPCs; enabled only in the default-off rollout path. */
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
export async function readContactHistory(db: Db, input: {invoiceId:string; channel:Channel; ownAttemptId:string | null}): Promise<{lastContactAt:string | null; unresolvedAttempt:boolean} | null> {
  try {
    const {data,error} = await db.rpc('read_reminder_contact_history', {p_invoice_id:input.invoiceId,p_channel:input.channel,p_own_attempt:input.ownAttemptId});
    if (error || !data || typeof data !== 'object' || Array.isArray(data)) return null;
    const row = data as Record<string, unknown>;
    if (!(row.lastContactAt === null || typeof row.lastContactAt === 'string') || typeof row.unresolvedAttempt !== 'boolean') return null;
    return {lastContactAt:row.lastContactAt as string | null,unresolvedAttempt:row.unresolvedAttempt};
  } catch { return null; }
}

export async function claimAutomaticSlot(db: Db, input: {invoiceId:string; channel:Channel; attemptId:string; scheduledDate:string; type:'upcoming'|'due_today'|'overdue'|'follow_up'}): Promise<'claimed'|'duplicate'|'unavailable'> {
  try {
    const {data,error} = await db.rpc('claim_automatic_reminder_slot', {p_invoice_id:input.invoiceId,p_channel:input.channel,p_attempt_id:input.attemptId,p_scheduled_date:input.scheduledDate,p_type:input.type});
    if (!error && (data === 'claimed' || data === 'duplicate')) return data;
  } catch { /* A lost claim response never grants permission to send. */ }
  return 'unavailable';
}

export async function finishDelivery(db: Db, input: {invoiceId:string; channel:Channel; attemptId:string; outcome:Outcome}): Promise<boolean> {
  try {
    const {data,error} = await db.rpc('finish_reminder_delivery', {p_invoice_id:input.invoiceId,p_channel:input.channel,p_attempt_id:input.attemptId,p_outcome:input.outcome});
    return !error && data === true;
  } catch { return false; }
}

/** Client-only SMS shares a lock with every invoice SMS for that client. */
export async function reserveClientSms(db: Db, input:{clientId:string;attemptId:string}):Promise<'reserved'|'busy'|'duplicate'|'unavailable'> {
  try {const {data,error}=await db.rpc('reserve_client_sms_delivery',{p_client_id:input.clientId,p_attempt_id:input.attemptId});if(!error && (data==='reserved'||data==='busy'||data==='duplicate'))return data;} catch {}
  return 'unavailable';
}
export async function finishClientSms(db:Db,input:{clientId:string;attemptId:string;outcome:Outcome}):Promise<boolean> {
  try {const {data,error}=await db.rpc('finish_client_sms_delivery',{p_client_id:input.clientId,p_attempt_id:input.attemptId,p_outcome:input.outcome});return !error && data===true;} catch {return false;}
}
export async function readClientSmsHistory(db:Db,input:{clientId:string;ownAttemptId:string}):Promise<{lastContactAt:string|null;unresolvedAttempt:boolean}|null> {
  try {const {data,error}=await db.rpc('read_client_sms_history',{p_client_id:input.clientId,p_own_attempt:input.ownAttemptId});
    if(error||!data||typeof data!=='object'||Array.isArray(data))return null;const row=data as Record<string,unknown>;
    if(!(row.lastContactAt===null||typeof row.lastContactAt==='string')||typeof row.unresolvedAttempt!=='boolean')return null;
    return {lastContactAt:row.lastContactAt as string|null,unresolvedAttempt:row.unresolvedAttempt};
  } catch {return null;}
}
