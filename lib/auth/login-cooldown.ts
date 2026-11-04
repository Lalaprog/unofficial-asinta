import { createHmac, randomUUID } from 'node:crypto';
import { createServiceRoleClient } from '@/lib/supabase/admin';
import { getClientAddress } from '@/lib/rateLimit';
import type { LoginOutcome, LoginRequestPayload } from '@/lib/auth/login';

type Outcome = 'success' | 'failure' | 'unknown';
type Reservation = { allowed: boolean; retryAfter: number };
type Completion = { confirmed: boolean; retryAfter: number };
export interface LoginCooldownStore {
  reserve(bucket: string, token: string): Promise<Reservation>;
  finish(bucket: string, token: string, outcome: Outcome): Promise<Completion>;
}

function readResult(data: unknown, flag: 'allowed' | 'confirmed') {
  if (!data || typeof data !== 'object') throw new Error('Invalid login safeguard response');
  const record = data as Record<string, unknown>;
  if (typeof record[flag] !== 'boolean' || !Number.isInteger(record.retry_after) ||
      (record.retry_after as number) < 0 || (record.retry_after as number) > 300) {
    throw new Error('Invalid login safeguard response');
  }
  return { flag: record[flag] as boolean, retryAfter: record.retry_after as number };
}

export function createLoginCooldownStore(): LoginCooldownStore {
  const client = createServiceRoleClient();
  return {
    async reserve(bucket, token) {
      const { data, error } = await client.rpc('reserve_login_attempt', { p_bucket: bucket, p_token: token });
      if (error) throw new Error('Login safeguard unavailable');
      const result = readResult(data, 'allowed');
      return { allowed: result.flag, retryAfter: result.retryAfter };
    },
    async finish(bucket, token, outcome) {
      const { data, error } = await client.rpc('finish_login_attempt', { p_bucket: bucket, p_token: token, p_outcome: outcome });
      if (error) throw new Error('Login safeguard unavailable');
      const result = readResult(data, 'confirmed');
      return { confirmed: result.flag, retryAfter: result.retryAfter };
    },
  };
}

const unavailable = (): LoginOutcome => ({
  status: 503,
  body: { ok: false, error: 'Sign-in is temporarily unavailable. Please try again shortly.' },
});
function blocked(seconds: number): LoginOutcome {
  const wait = Math.max(1, Math.ceil(seconds));
  return {
    status: 429,
    headers: { 'Retry-After': String(wait), 'X-RateLimit-Limit': '5', 'X-RateLimit-Remaining': '0' },
    body: { ok: false, rateLimited: true, retryAfterSeconds: wait,
      error: wait <= 2 ? 'A sign-in is already being checked. Please try again in a moment.' : `Too many unsuccessful sign-in attempts. Please wait ${Math.ceil(wait / 60)} minute${wait > 60 ? 's' : ''} and try again.` },
  };
}

/** The route commits its buffered session cookies only if this returns success. */
export async function guardedLogin(params: {
  headers: Headers;
  payload: LoginRequestPayload;
  secret: string;
  makeStore: () => LoginCooldownStore;
  authenticate: () => Promise<LoginOutcome>;
  makeToken?: () => string;
}): Promise<LoginOutcome> {
  const email = typeof params.payload?.email === 'string' ? params.payload.email.trim().toLowerCase() : '';
  const password = typeof params.payload?.password === 'string' ? params.payload.password : '';
  // Reject malformed input without putting it into a bucket or calling Auth.
  if (!email || !password || email.length > 254 || password.length > 1024) {
    return { status: 400, body: { ok: false, error: 'Enter a valid email and password.' } };
  }
  const ip = getClientAddress(params.headers);
  if (!params.secret || ip === 'unknown' || ip.length > 128) return unavailable();
  const bucket = createHmac('sha256', params.secret).update(JSON.stringify([email, ip])).digest('hex');
  const token = (params.makeToken ?? randomUUID)();
  try {
    const store = params.makeStore();
    const reservation = await store.reserve(bucket, token);
    if (!reservation.allowed) return blocked(reservation.retryAfter);
    let result: LoginOutcome;
    try { result = await params.authenticate(); } catch { result = unavailable(); }
    const outcome: Outcome = result.body.ok && result.status === 200 ? 'success' : result.guardFailure ? 'failure' : 'unknown';
    const finished = await store.finish(bucket, token, outcome);
    if (!finished.confirmed) return unavailable();
    // A fifth rejected credential is still shown as the same generic error; the
    // next attempt receives the cooldown. Both known and unknown accounts match.
    return result;
  } catch {
    return unavailable();
  }
}
