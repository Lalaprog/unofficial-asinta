import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { requireFounder } from '@/lib/auth/serverRole';
import { getSmtpConfigStatus, getFirmEmailIdentity, sendEmail } from '@/lib/email/mailer';
import { escapeHtml, isValidEmail } from '@/lib/email/format';
import { enforceRateLimit } from '@/lib/api/rateLimitGuard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Founder-only SMTP test email.
 *
 * - Defaults to the authenticated Founder's own email address.
 * - Sending to any OTHER address requires an explicit confirmation flag.
 * - Returns safe success/failure details only — never credentials.
 */
export async function POST(req: NextRequest) {
  try {
    const supabase = createServerSupabaseClient();
    const founder = await requireFounder(supabase);
    if (!founder.ok) {
      return NextResponse.json({ error: founder.error }, { status: founder.status });
    }

    const limited = enforceRateLimit('emailTest', req.headers, founder.userId);
    if (limited) return limited;

    const smtpStatus = getSmtpConfigStatus();
    if (!smtpStatus.configured) {
      return NextResponse.json(
        {
          error: `SMTP is not configured. Missing environment variables: ${smtpStatus.missing.join(', ')}. Add them to the server environment and redeploy.`,
        },
        { status: 503 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const founderEmail = (founder.userEmail || '').trim();
    const requestedTo = typeof body?.to === 'string' ? body.to.trim() : '';
    const to = requestedTo || founderEmail;

    if (!isValidEmail(to)) {
      return NextResponse.json({ error: 'The test recipient is not a valid email address' }, { status: 422 });
    }
    if (to.toLowerCase() !== founderEmail.toLowerCase() && body?.confirmDifferentRecipient !== true) {
      return NextResponse.json(
        {
          error: 'Sending a test email to an address other than your own requires explicit confirmation.',
          requiresConfirmation: true,
        },
        { status: 409 }
      );
    }

    const identity = getFirmEmailIdentity();
    const sentAt = new Date().toLocaleString('en-PH', { timeZone: 'Asia/Manila' });
    const text = [
      'BALE TEST EMAIL — Asinta Architects',
      '',
      'This is a test message sent from the BALE management system to verify the SMTP configuration.',
      'No client was contacted and no invoice is associated with this message.',
      '',
      `Sent at: ${sentAt} (Asia/Manila)`,
      `From identity: ${identity.fromName}`,
      '',
      'If you received this email, the SMTP server accepted the message successfully.',
    ].join('\n');

    const html = `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;background:#f1f5f9;padding:24px;">
<div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
<div style="background:#0b1f3a;color:#ffffff;padding:20px 28px;font-weight:800;letter-spacing:1px;">BALE TEST EMAIL — ASINTA ARCHITECTS</div>
<div style="padding:24px 28px;color:#1e293b;font-size:14px;line-height:1.6;">
<p>This is a <strong>test message</strong> sent from the BALE management system to verify the SMTP configuration.</p>
<p>No client was contacted and no invoice is associated with this message.</p>
<p style="color:#475569;font-size:12px;">Sent at: ${escapeHtml(sentAt)} (Asia/Manila)<br/>From identity: ${escapeHtml(identity.fromName)}</p>
<p>If you received this email, the SMTP server accepted the message successfully.</p>
</div></div></body></html>`;

    const result = await sendEmail({
      to,
      subject: '[TEST] BALE SMTP Configuration Check — Asinta Architects',
      text,
      html,
    });

    if (!result.accepted) {
      return NextResponse.json(
        { accepted: false, uncertain: Boolean(result.uncertain), error: result.uncertain ? 'Test email outcome is not confirmed. Check the recipient mailbox before retrying; it may have been sent.' : result.error || 'The mail server rejected the test message.' },
        { status: 502 }
      );
    }

    return NextResponse.json({
      accepted: true,
      statusLabel: 'Accepted by mail server',
      providerMessageId: result.providerMessageId || null,
      to,
      note: 'The SMTP server accepted the message. Acceptance is not proof of inbox delivery — check the recipient mailbox (including spam).',
    });
  } catch {
    return NextResponse.json({ error: 'Test email outcome is not confirmed. Check the recipient mailbox before retrying; it may have been sent.' }, { status: 500 });
  }
}
