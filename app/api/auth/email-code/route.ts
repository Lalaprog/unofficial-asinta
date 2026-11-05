import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { enforceRateLimit } from '@/lib/api/rateLimitGuard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const generic = 'If this email belongs to a BALE account, a sign-in code may arrive shortly.';
const headers = { 'Cache-Control': 'private, no-store' };

/** Request a sign-in code, never create an Auth account or reveal membership. */
export async function POST(request: NextRequest) {
  if (process.env.EMAIL_CODE_SIGNIN_ENABLED !== 'true') {
    return NextResponse.json({ ok: false, error: 'Email-code sign-in is not available yet.' }, { status: 503, headers });
  }
  const limited = enforceRateLimit('authEmailCode', request.headers);
  if (limited) return limited;
  let body: { email?: unknown };
  try { body = await request.json(); } catch {
    return NextResponse.json({ ok: false, error: 'Enter a valid email address.' }, { status: 400, headers });
  }
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ ok: false, error: 'Enter a valid email address.' }, { status: 400, headers });
  }
  try {
    // Do not pass a redirect URL: the email template must display {{ .Token }}.
    // Both known and unknown addresses receive the same response.
    await createServerSupabaseClient().auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
  } catch {
    // Do not reveal whether an account exists, and never log addresses or OTPs.
  }
  return NextResponse.json({ ok: true, message: generic }, { headers });
}
