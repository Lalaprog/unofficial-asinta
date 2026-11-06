import { NextRequest, NextResponse } from 'next/server';
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

    const result = await sendRequestForPayment(
      {
        db: supabase,
        sendEmail,
        isSmtpConfigured,
        firmIdentity: getFirmEmailIdentity(),
      },
      {
        invoiceId: typeof body.invoiceId === 'string' ? body.invoiceId : '',
        subjectTemplate: typeof body.subjectTemplate === 'string' ? body.subjectTemplate : undefined,
        bodyTemplate: typeof body.bodyTemplate === 'string' ? body.bodyTemplate : undefined,
        idempotencyKey: typeof body.idempotencyKey === 'string' ? body.idempotencyKey : '',
        sentBy: founder.userId as string,
        previewFingerprint: typeof body.previewFingerprint === 'string' ? body.previewFingerprint : undefined,
      }
    );

    if (!result.ok) {
      return NextResponse.json({ error: result.error.error }, { status: result.error.status });
    }

    return NextResponse.json({
      status: result.status,
      statusLabel: result.status === 'accepted' ? 'Accepted by mail server' : 'Failed',
      logId: result.logId,
      providerMessageId: result.providerMessageId || null,
      duplicate: Boolean(result.duplicate),
      error: result.error || null,
    });
  } catch {
    return NextResponse.json({ error: 'Failed to process the email request' }, { status: 500 });
  }
}
