import { NextRequest, NextResponse } from 'next/server';
import {randomUUID} from 'node:crypto';
import {createServiceRoleClient,isServiceRoleConfigured} from '@/lib/supabase/admin';
import {coordinateManualDelivery} from '@/lib/reminders/manualDelivery';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { requireFounder } from '@/lib/auth/serverRole';
import { getFirmEmailIdentity, isSmtpConfigured, sendEmail } from '@/lib/email/mailer';
import { sendRequestForPayment } from '@/lib/email/service';
import { enforceRateLimit } from '@/lib/api/rateLimitGuard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Founder-only Request for Payment dispatch.
 *
 * The browser submits ONLY: the invoice ID, the Founder-edited subject/body
 * templates, and a per-confirmation idempotency key. Recipient, amounts,
 * dates, and every other financial detail are loaded authoritatively from
 * the database on the server.
 */
export async function POST(req: NextRequest) {
  try {
    const supabase = createServerSupabaseClient();
    const founder = await requireFounder(supabase);
    if (!founder.ok) {
      return NextResponse.json({ error: founder.error }, { status: founder.status });
    }

    const limited = enforceRateLimit('emailSend', req.headers, founder.userId);
    if (limited) return limited;

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const deps={db:supabase,sendEmail,isSmtpConfigured,firmIdentity:getFirmEmailIdentity()};
    const input={
      invoiceId: typeof body.invoiceId === 'string' ? body.invoiceId : '',
      subjectTemplate: typeof body.subjectTemplate === 'string' ? body.subjectTemplate : undefined,
      bodyTemplate: typeof body.bodyTemplate === 'string' ? body.bodyTemplate : undefined,
      idempotencyKey: typeof body.idempotencyKey === 'string' ? body.idempotencyKey : '',
      sentBy: founder.userId as string,
      previewFingerprint: typeof body.previewFingerprint === 'string' ? body.previewFingerprint : undefined,
    };
    let result;
    if(process.env.REMINDER_COORDINATION_ENABLED==='true') {
      if(!isServiceRoleConfigured())return NextResponse.json({error:'Message coordination is unavailable. No email was sent.'},{status:503});
      const coordinated=await coordinateManualDelivery({db:createServiceRoleClient() as any,invoiceId:input.invoiceId,channel:'email',attemptId:randomUUID(),
        deliver:(attemptId,beforeSend)=>sendRequestForPayment(deps,{...input,reminderAttemptId:attemptId,beforeSend}),
        outcome:(value)=>!value.ok || value.duplicate?'cancelled':value.status==='unconfirmed' || value.logUpdateFailed?'unconfirmed':value.status==='accepted'?'accepted':'rejected',
      });
      if(coordinated.status!=='completed')return NextResponse.json({error:coordinated.status==='busy'?'Another message is in progress or needs review. Check email history before trying again.':coordinated.status==='unconfirmed'?'Email outcome not confirmed. Check email history and the mail server before retrying; it may have been sent.':'Message coordination is unavailable. Check email history before trying again.'},{status:coordinated.status==='busy'?409:503});
      result=coordinated.result;
    } else result=await sendRequestForPayment(deps,input);

    if (!result.ok) {
      return NextResponse.json({ error: result.error.error }, { status: result.error.status });
    }

    return NextResponse.json({
      status: result.status,
      statusLabel: result.status === 'accepted' ? 'Accepted by mail server' : result.status === 'unconfirmed' ? 'Not confirmed' : 'Failed',
      logUpdateFailed: Boolean(result.logUpdateFailed),
      logId: result.logId,
      providerMessageId: result.providerMessageId || null,
      duplicate: Boolean(result.duplicate),
      error: result.error || null,
    });
  } catch {
    return NextResponse.json({ error: 'Email outcome not confirmed. Check email history and the mail server before trying again; the message may have been sent.' }, { status: 500 });
  }
}
