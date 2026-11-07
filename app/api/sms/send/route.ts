import { NextRequest, NextResponse } from 'next/server';
import {randomUUID} from 'node:crypto';
import {createServiceRoleClient,isServiceRoleConfigured} from '@/lib/supabase/admin';
import {coordinateManualDelivery} from '@/lib/reminders/manualDelivery';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { requireFounder } from '@/lib/auth/serverRole';
import { deliverAndLogSMS } from '@/lib/sms/deliver';
import { normalizePhilippineMobile } from '@/lib/sms/phone';
import { enforceRateLimit } from '@/lib/api/rateLimitGuard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function invoiceAmount(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim())) return NaN;
  return Number(value);
}

/**
 * Founder-only SMS dispatch through the PhilSMS gateway.
 *
 * The recipient is ALWAYS resolved server-side from an invoice's client or a
 * client record — arbitrary browser-submitted phone numbers are rejected.
 * The final message, honest status, provider message ID, and any error are
 * recorded in sms_logs on the server.
 */
export async function POST(req: NextRequest) {
  try {
    const supabase = createServerSupabaseClient();
    const founder = await requireFounder(supabase);
    if (!founder.ok) {
      return NextResponse.json({ error: founder.error }, { status: founder.status });
    }

    // Cost control: every SMS is billed by the gateway. A stuck retry loop must
    // not be able to drain the SMS budget.
    const limited = enforceRateLimit('smsSend', req.headers, founder.userId);
    if (limited) return limited;

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const invoiceId = typeof body.invoiceId === 'string' && body.invoiceId ? body.invoiceId : null;
    const clientId = typeof body.clientId === 'string' && body.clientId ? body.clientId : null;
    const message = typeof body.message === 'string' ? body.message.trim() : '';

    if (!message) {
      return NextResponse.json({ error: 'A message is required' }, { status: 400 });
    }
    if (message.length > 1000) {
      return NextResponse.json({ error: 'The message is too long (1,000 character limit)' }, { status: 400 });
    }
    if (!invoiceId && !clientId) {
      return NextResponse.json(
        { error: 'Select an invoice or a client — SMS can only be sent to registered client contacts' },
        { status: 400 }
      );
    }

    // Resolve the authoritative recipient server-side.
    let resolvedClientId = clientId;
    let originalInvoice:Record<string,unknown>|null=null;
    if (invoiceId) {
      const { data: invoice } = await supabase
        .from('invoices')
        .select('id, client_id, status, amount, amount_paid')
        .eq('id', invoiceId)
        .maybeSingle();
      if (!invoice) {
        return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
      }
      const amount = invoiceAmount(invoice.amount);
      const paid = invoiceAmount(invoice.amount_paid);
      if (!['pending', 'partially_paid', 'overdue'].includes(invoice.status) ||
          !Number.isFinite(amount) || !Number.isFinite(paid) || amount < 0 || paid < 0 || amount - paid <= 0) {
        return NextResponse.json({ error: 'This invoice is not eligible for a payment reminder. Refresh its status and balance.' }, { status: 422 });
      }
      resolvedClientId = invoice.client_id;
      originalInvoice = {...invoice};
    }

    const { data: client } = await supabase
      .from('clients')
      .select('id, name, contact_person, phone')
      .eq('id', resolvedClientId)
      .maybeSingle();
    if (!client) {
      return NextResponse.json({ error: 'Client not found' }, { status: 404 });
    }

    const normalizedPhone = normalizePhilippineMobile(client.phone);
    if (!normalizedPhone) {
      return NextResponse.json(
        { error: 'The client does not have a valid Philippine mobile number on file. Update the client record first.' },
        { status: 422 }
      );
    }

    const recipientName = (client.contact_person || '').trim() || client.name;

    // This default-off rollout flag must be switched only after the staged
    // SQL, recovery UI and ALL senders are ready. Legacy cron fails closed
    // while coordinated manual sends are enabled.
    let outcome;
    if (process.env.REMINDER_COORDINATION_ENABLED === 'true') {
      if(!isServiceRoleConfigured() || !resolvedClientId) return NextResponse.json({error:'Message coordination is unavailable. No SMS was sent.'},{status:503});
      const admin=createServiceRoleClient();
      const originalClient={...client};
      const coordinated=await coordinateManualDelivery({db:admin as any,invoiceId,clientId:resolvedClientId,channel:'sms',attemptId:randomUUID(),
        deliver:(attemptId,checkHistory)=>deliverAndLogSMS({db:supabase,invoiceId,clientId:resolvedClientId!,reminderAttemptId:attemptId,recipient:recipientName,phone:normalizedPhone,message,
          beforeSend:async()=>{
            if(!await checkHistory(normalizedPhone))return false;
            const [latestClient,latestInvoice]=await Promise.all([
              supabase.from('clients').select('id, name, contact_person, phone').eq('id',resolvedClientId).maybeSingle(),
              invoiceId?supabase.from('invoices').select('id, client_id, status, amount, amount_paid').eq('id',invoiceId).maybeSingle():Promise.resolve({data:null,error:null}),
            ]);
            return !latestClient.error && !latestInvoice.error && JSON.stringify(latestClient.data)===JSON.stringify(originalClient) &&
              (!invoiceId || JSON.stringify(latestInvoice.data)===JSON.stringify(originalInvoice));
          }}),
        outcome:(result)=>result.cancelled || result.logWriteFailed || result.simulated?'cancelled':result.uncertain || result.logUpdateFailed?'unconfirmed':result.success?'accepted':'rejected',
      });
      if(coordinated.status!=='completed') return NextResponse.json({error:coordinated.status==='busy'?'Another message is in progress or needs review. Check message history before trying again.':coordinated.status==='unconfirmed'?'SMS outcome not confirmed. Check the dispatch log and provider before retrying; it may have been sent.':'Message coordination is unavailable. Check message history before trying again.'},{status:coordinated.status==='busy'?409:503});
      outcome=coordinated.result;
    } else {
      outcome=await deliverAndLogSMS({db:supabase,invoiceId,recipient:recipientName,phone:normalizedPhone,message});
    }

    if (outcome.logWriteFailed) {
      return NextResponse.json({ error: outcome.error }, { status: 500 });
    }

    return NextResponse.json({
      success: outcome.success,
      simulated: outcome.simulated,
      uncertain: outcome.uncertain,
      logUpdateFailed: outcome.logUpdateFailed,
      statusLabel: outcome.statusLabel,
      error: outcome.error,
      log: outcome.log,
    });
  } catch {
    return NextResponse.json({ error: 'SMS outcome not confirmed. Check the dispatch log and provider before retrying; it may have been sent.' }, { status: 500 });
  }
}
