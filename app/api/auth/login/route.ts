import { NextRequest, NextResponse } from 'next/server';
import { createBufferedLoginClient } from '@/lib/supabase/login-buffer';
import { createLoginCooldownStore, guardedLogin } from '@/lib/auth/login-cooldown';
import {
  authenticateLoginRequest,
  type LoginRequestPayload,
  type MinimalLoginSupabaseClient,
} from '@/lib/auth/login';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Shared safeguard is scoped to a hashed email + network. The older in-process
 * IP limiter remains a secondary prefilter; direct Auth calls bypass both. */
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

  const buffered = createBufferedLoginClient(request);
  const supabase = buffered.client as unknown as MinimalLoginSupabaseClient;
  const outcome = await guardedLogin({
    headers: request.headers,
    payload,
    secret: (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim(),
    makeStore: createLoginCooldownStore,
    authenticate: () => authenticateLoginRequest({ headers: request.headers, payload, supabase }),
  });

  const response = NextResponse.json(outcome.body, {
    status: outcome.status,
    headers: { ...(outcome.headers ?? {}), 'Cache-Control': 'private, no-store' },
  });
  if (outcome.status === 200 && outcome.body.ok) buffered.commit(response);
  return response;
}
