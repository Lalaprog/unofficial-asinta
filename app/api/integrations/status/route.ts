import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { isSmtpConfigured } from '@/lib/email/mailer';
import { isGlobalAutomaticRemindersEnabled } from '@/lib/reminders/scheduler';
import { GROQ_MODEL } from '@/lib/ai/groq';
import { getVisionModel } from '@/lib/ai/models';
import { isMfaEnforcementEnabled } from '@/lib/auth/mfa';
import { getSessionPolicy } from '@/lib/auth/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Authenticated integration-status endpoint.
 * Returns booleans and non-secret policy numbers ONLY — secret values never
 * leave the server.
 */
export async function GET() {
  const supabase = createServerSupabaseClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  }

  const sessionPolicy = getSessionPolicy();

  return NextResponse.json(
    {
      groqConfigured: Boolean(process.env.GROQ_API_KEY),
      groqModel: GROQ_MODEL,
      // Model IDs are data, not code: Groq retired the two IDs this app used to
      // depend on (2026-07-17 and 2026-08-16), so ops needs to see what is live.
      groqVisionModel: getVisionModel(),
      // Enforcement is opt-in; reporting it prevents "is MFA on?" guesswork.
      mfaEnforcedForFounders: isMfaEnforcementEnabled(),
      // Session timeout values baked into this build. Applies to all roles.
      sessionPolicy: {
        idleMinutes: Math.round(sessionPolicy.idleTimeoutMs / 60_000),
        absoluteHours: Math.round(sessionPolicy.absoluteTimeoutMs / 3_600_000),
        warningSeconds: Math.round(sessionPolicy.warningMs / 1_000),
        appliesToRoles: ['founder', 'supervisor'],
      },
      // Says plainly that receipt photos are only readable via signed URLs.
      receiptsBucketPrivate: true,
      philsmsConfigured: Boolean(process.env.PHILSMS_API_KEY),
      philsmsSenderId: process.env.PHILSMS_SENDER_ID || 'PhilSMS',
      supabaseConfigured: Boolean(
        process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
      ),
      smtpConfigured: isSmtpConfigured(),
      automaticRemindersEnabled: isGlobalAutomaticRemindersEnabled(),
    },
    { headers: { 'Cache-Control': 'private, no-store' } }
  );
}
