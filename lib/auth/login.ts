/**
 * Server-side sign-in and generic error handling. The route wraps this helper
 * with the database-backed per-email-and-network safeguard before calling it.
 * The legacy in-process IP limiter remains a secondary request-volume control;
 * it counts valid-shape requests regardless of outcome and is not distributed.
 * Neither control protects direct Supabase Auth requests.
 */

import type { User, UserRole } from '@/types';
import {
  checkRateLimit,
  getLoginRateLimitIdentity,
  rateLimitHeaders,
  rateLimitMessage,
  type RateLimitHeaders,
} from '@/lib/rateLimit';

export const GENERIC_LOGIN_ERROR =
  'Invalid email or password. Please check your credentials and try again.';

export interface SanitizedLoginError {
  status: number;
  message: string;
  rateLimited?: boolean;
}

/**
 * Collapses Supabase Auth errors into safe, non-enumerating messages.
 *
 * Specifically:
 *   - `Email not confirmed`, `User not found`, `Invalid login credentials`,
 *     `User banned`, and unknown auth errors all map to `GENERIC_LOGIN_ERROR`
 *     (HTTP 401) so the response never reveals whether an account exists.
 *   - Rate-limit responses map to HTTP 429.
 *   - CAPTCHA errors map to HTTP 400.
 *   - Network/connectivity errors map to HTTP 503.
 */
export function sanitizeLoginError(
  error: { message?: string; status?: number; code?: string } | string | null | undefined
): SanitizedLoginError {
  const rawMessage = typeof error === 'string' ? error : error?.message ?? '';
  const code = typeof error === 'object' && error !== null ? (error.code ?? '') : '';
  const status = typeof error === 'object' && error !== null ? error.status : undefined;
  const normalized = `${code} ${rawMessage}`.toLowerCase();

  if (
    status === 429 ||
    normalized.includes('over_request_rate_limit') ||
    normalized.includes('over_email_send_rate_limit') ||
    normalized.includes('rate limit') ||
    normalized.includes('too many requests')
  ) {
    return {
      status: 429,
      message: 'Too many sign-in attempts from this network. Please wait a few minutes and try again.',
      rateLimited: true,
    };
  }

  if (normalized.includes('captcha')) {
    return {
      status: 400,
      message: 'CAPTCHA verification failed or expired. Please complete the challenge and try again.',
    };
  }

  if (
    (typeof status === 'number' && status >= 500) ||
    normalized.includes('failed to fetch') ||
    normalized.includes('network') ||
    normalized.includes('econnrefused') ||
    normalized.includes('enotfound') ||
    normalized.includes('etimedout')
  ) {
    return {
      status: 503,
      message:
        'Cannot reach the Supabase authentication server. Check your connection and configuration.',
    };
  }

  return {
    status: 401,
    message: GENERIC_LOGIN_ERROR,
  };
}

export function friendlyAuthError(message: string): string {
  return sanitizeLoginError(message).message;
}

export interface MinimalLoginSupabaseClient {
  auth: {
    signInWithPassword: (credentials: {
      email: string;
      password: string;
      options?: { captchaToken?: string };
    }) => Promise<{
      data: {
        user: { id: string; email?: string | null } | null;
        session?: { access_token: string; refresh_token: string } | null;
      };
      error: { message?: string; status?: number; code?: string } | null;
    }>;
    signOut: () => Promise<unknown>;
  };
  from: (table: string) => {
    select: (columns: string) => {
      eq: (column: string, value: string) => {
        maybeSingle: () => PromiseLike<{
          data: User | null;
          error: { message: string } | null;
        }>;
      };
    };
  };
}

export interface LoginRequestPayload {
  email?: unknown;
  password?: unknown;
  captchaToken?: unknown;
}

export interface LoginOutcome {
  /** Internal only: a confirmed credential/account-state rejection, not an outage. */
  guardFailure?: boolean;
  status: number;
  headers?: RateLimitHeaders;
  body: {
    ok: boolean;
    error?: string;
    rateLimited?: boolean;
    retryAfterSeconds?: number;
    user?: User;
    role?: UserRole;
    session?: {
      access_token: string;
      refresh_token: string;
    };
  };
}

/**
 * Pure server-side sign-in flow used by `POST /api/auth/login`.
 */
export async function authenticateLoginRequest(params: {
  headers: Headers;
  payload: LoginRequestPayload;
  supabase: MinimalLoginSupabaseClient;
  now?: number;
}): Promise<LoginOutcome> {
  const { headers, payload, supabase, now } = params;

  // Secondary per-instance, per-IP request-volume limit. The route applies
  // the shared per-email-and-network cooldown separately.
  const identity = getLoginRateLimitIdentity(headers);
  const decision = checkRateLimit('authLogin', identity, now);
  if (!decision.allowed) {
    return {
      status: 429,
      headers: rateLimitHeaders('authLogin', decision),
      body: {
        ok: false,
        error: rateLimitMessage('authLogin', decision),
        rateLimited: true,
        retryAfterSeconds: decision.retryAfterSeconds,
      },
    };
  }

  // 2. Validate input shape.
  const email = typeof payload?.email === 'string' ? payload.email.trim().toLowerCase() : '';
  const password = typeof payload?.password === 'string' ? payload.password : '';
  const captchaToken =
    typeof payload?.captchaToken === 'string' && payload.captchaToken.trim().length > 0
      ? payload.captchaToken.trim()
      : undefined;

  if (!email || !password) {
    return {
      status: 400,
      body: {
        ok: false,
        error: 'Email and password are required.',
      },
    };
  }

  // 3. Authenticate against Supabase Auth (forwards CAPTCHA token when configured).
  try {
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
      ...(captchaToken ? { options: { captchaToken } } : {}),
    });

    if (error || !data?.user) {
      const sanitized = sanitizeLoginError(error ?? 'Authentication failed');
      const credentialRejection = Boolean(error && sanitized.status === 401 &&
        ((typeof error.status === 'number' && error.status >= 400 && error.status < 500) ||
          /invalid login credentials|invalid_credentials|email not confirmed|user not found|user banned/i.test(`${error.code ?? ''} ${error.message ?? ''}`)));
      return {
        status: sanitized.status,
        guardFailure: credentialRejection,
        body: {
          ok: false,
          error: sanitized.message,
          ...(sanitized.rateLimited ? { rateLimited: true } : {}),
        },
      };
    }

    // 4. Load the BALE profile from `public.users`. If the auth account has no
    //    profile or an unrecognised role, sign out immediately and return the
    //    same generic 401 so an attacker cannot tell whether an `auth.users`
    //    row existed.
    const { data: profile, error: profileError } = await supabase
      .from('users')
      .select('id, name, email, role, created_at')
      .eq('id', data.user.id)
      .maybeSingle();

    if (profileError) {
      await supabase.auth.signOut().catch(() => {});
      return {
        status: 503,
        body: {
          ok: false,
          error: 'Cannot verify your BALE profile right now. Please try again.',
        },
      };
    }

    if (!profile || (profile.role !== 'founder' && profile.role !== 'supervisor')) {
      await supabase.auth.signOut().catch(() => {});
      return {
        guardFailure: true,
        status: 401,
        body: {
          ok: false,
          error: GENERIC_LOGIN_ERROR,
        },
      };
    }

    return {
      status: 200,
      body: {
        ok: true,
        user: profile,
        role: profile.role,
        ...(data.session?.access_token && data.session?.refresh_token
          ? {
              session: {
                access_token: data.session.access_token,
                refresh_token: data.session.refresh_token,
              },
            }
          : {}),
      },
    };
  } catch (caught) {
    const sanitized = sanitizeLoginError(
      caught instanceof Error ? caught.message : 'Authentication failed'
    );
    return {
      status: sanitized.status,
      body: {
        ok: false,
        error: sanitized.message,
        ...(sanitized.rateLimited ? { rateLimited: true } : {}),
      },
    };
  }
}
