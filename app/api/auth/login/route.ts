import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import {
  authenticateLoginRequest,
  type LoginRequestPayload,
  type MinimalLoginSupabaseClient,
} from '@/lib/auth/login';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Server-side sign-in endpoint.
 *
 * Routes login traffic through `lib/rateLimit.ts` (`authLogin`: 10 attempts per
 * 5 minutes per IP, never per email/account) before forwarding to Supabase Auth,
 * and returns only generic credential errors so account existence cannot be
 * enumerated.
 */
export async function POST(request: NextRequest) {
  let payload: LoginRequestPayload;
  try {
    payload = (await request.json()) as LoginRequestPayload;
  } catch {
    return NextResponse.json(
      { ok: false, error: 'Invalid JSON request body.' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  const supabase = createServerSupabaseClient() as unknown as MinimalLoginSupabaseClient;
  const outcome = await authenticateLoginRequest({
    headers: request.headers,
    payload,
    supabase,
  });

  return NextResponse.json(outcome.body, {
    status: outcome.status,
    headers: {
      ...(outcome.headers ?? {}),
      'Cache-Control': 'private, no-store',
    },
  });
}
