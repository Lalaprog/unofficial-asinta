import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RATE_LIMITS,
  SlidingWindowRateLimiter,
  checkRateLimit,
  getClientAddress,
  getLoginRateLimitIdentity,
  getRateLimitIdentity,
  rateLimitHeaders,
  rateLimitMessage,
  resetRateLimits,
} from '@/lib/rateLimit';
import {
  GENERIC_LOGIN_ERROR,
  authenticateLoginRequest,
  friendlyAuthError,
  sanitizeLoginError,
  type MinimalLoginSupabaseClient,
} from '@/lib/auth/login';

afterEach(() => {
  resetRateLimits();
});

describe('sliding-window rate limiter', () => {
  it('allows requests up to the limit and refuses the next one', () => {
    const limiter = new SlidingWindowRateLimiter();
    const rule = { limit: 3, windowMs: 60_000 };

    expect(limiter.check('k', rule, 1_000).allowed).toBe(true);
    expect(limiter.check('k', rule, 1_001).allowed).toBe(true);
    expect(limiter.check('k', rule, 1_002).allowed).toBe(true);

    const refused = limiter.check('k', rule, 1_003);
    expect(refused.allowed).toBe(false);
    expect(refused.remaining).toBe(0);
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('reports the true wait time, not a rounded-down one', () => {
    const limiter = new SlidingWindowRateLimiter();
    const rule = { limit: 1, windowMs: 10_000 };

    limiter.check('k', rule, 0);
    // 9.2s left → must round UP so the caller does not retry too early.
    const refused = limiter.check('k', rule, 800);
    expect(refused.retryAfterSeconds).toBe(10);
  });

  it('slides: capacity returns as old hits age out', () => {
    const limiter = new SlidingWindowRateLimiter();
    const rule = { limit: 2, windowMs: 1_000 };

    limiter.check('k', rule, 0);
    limiter.check('k', rule, 500);
    expect(limiter.check('k', rule, 900).allowed).toBe(false);

    // The first hit (t=0) has aged out by t=1001.
    expect(limiter.check('k', rule, 1_001).allowed).toBe(true);
  });

  it('keeps counters independent per key', () => {
    const limiter = new SlidingWindowRateLimiter();
    const rule = { limit: 1, windowMs: 60_000 };

    expect(limiter.check('founder-a', rule, 0).allowed).toBe(true);
    expect(limiter.check('founder-b', rule, 0).allowed).toBe(true);
    expect(limiter.check('founder-a', rule, 0).allowed).toBe(false);
  });

  it('caps tracked keys so a hostile client cannot grow memory without bound', () => {
    const limiter = new SlidingWindowRateLimiter(50);
    for (let i = 0; i < 500; i += 1) {
      // Each key is used once, then a sweep runs on the next window boundary.
      limiter.check(`key-${i}`, { limit: 5, windowMs: 1 }, i * 10);
    }
    expect(limiter.trackedKeyCount).toBeLessThanOrEqual(50);
  });
});

describe('route limits', () => {
  it('names a limit for every cost-bearing route', () => {
    expect(Object.keys(RATE_LIMITS)).toEqual(
      expect.arrayContaining(['smsSend', 'emailTest', 'emailSend', 'aiSuggest', 'aiExtract'])
    );
  });

  it('keeps SMS the tightest limit — each message is billed', () => {
    expect(RATE_LIMITS.smsSend.limit).toBeLessThan(RATE_LIMITS.emailSend.limit);
  });

  it('applies the limit per identity and returns retry headers', () => {
    const rule = RATE_LIMITS.aiSuggest;
    for (let i = 0; i < rule.limit; i += 1) {
      expect(checkRateLimit('aiSuggest', 'user:abc', 0).allowed).toBe(true);
    }

    const decision = checkRateLimit('aiSuggest', 'user:abc', 0);
    expect(decision.allowed).toBe(false);

    const headers = rateLimitHeaders('aiSuggest', decision);
    expect(Number(headers['Retry-After'])).toBeGreaterThan(0);
    expect(headers['X-RateLimit-Limit']).toBe(String(rule.limit));
    expect(headers['X-RateLimit-Remaining']).toBe('0');
  });

  it('states the retry delay in the message instead of "something went wrong"', () => {
    const decision = { allowed: false, remaining: 0, retryAfterSeconds: 120 };
    const message = rateLimitMessage('smsSend', decision);
    expect(message).toMatch(/too many requests/i);
    expect(message).toMatch(/2 minutes/);
    expect(message).toMatch(/limit: 15/);
  });
});

describe('caller identity', () => {
  it('prefers the authenticated user id over the client address', () => {
    const headers = new Headers({ 'x-forwarded-for': '203.0.113.9, 10.0.0.1' });
    expect(getRateLimitIdentity(headers, 'user-123')).toBe('user:user-123');
    expect(getRateLimitIdentity(headers, null)).toBe('ip:203.0.113.9');
  });

  it('falls back to a stable placeholder when no address is present', () => {
    expect(getClientAddress(new Headers())).toBe('unknown');
  });

  it('keys login rate limits by IP only — never by email/account (no account lockout)', () => {
    const headers = new Headers({ 'x-forwarded-for': '203.0.113.42' });
    expect(getLoginRateLimitIdentity(headers)).toBe('ip:203.0.113.42');
    expect(RATE_LIMITS.authLogin).toEqual({ limit: 10, windowMs: 5 * 60 * 1000 });
  });
});

describe('login rate limiting and non-enumerating errors', () => {
  function makeMockLoginClient(overrides?: {
    authError?: { message?: string; status?: number; code?: string } | null;
    profile?: { id: string; name: string; email: string; role: 'founder' | 'supervisor'; created_at: string } | null;
  }): { client: MinimalLoginSupabaseClient; signInSpy: ReturnType<typeof vi.fn>; signOutSpy: ReturnType<typeof vi.fn> } {
    const signInSpy = vi.fn(async () => ({
      data: overrides?.authError
        ? { user: null, session: null }
        : {
            user: { id: 'user-1', email: 'junel@asinta.ph' },
            session: { access_token: 'tok-a', refresh_token: 'tok-r' },
          },
      error: overrides?.authError ?? null,
    }));
    const signOutSpy = vi.fn(async () => ({}));
    const profile =
      overrides && 'profile' in overrides
        ? overrides.profile ?? null
        : {
            id: 'user-1',
            name: 'Junel',
            email: 'junel@asinta.ph',
            role: 'founder' as const,
            created_at: '2026-10-06T00:00:00Z',
          };

    const client: MinimalLoginSupabaseClient = {
      auth: {
        signInWithPassword: signInSpy,
        signOut: signOutSpy,
      },
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: profile, error: null }),
          }),
        }),
      }),
    };

    return { client, signInSpy, signOutSpy };
  }

  it('never reveals whether an account exists across distinct Supabase error messages', () => {
    const messages = [
      'Invalid login credentials',
      'Email not confirmed',
      'User not found',
      'Invalid email or password',
      'User banned',
      'Signups not allowed for this instance',
    ];

    for (const msg of messages) {
      const sanitized = sanitizeLoginError(msg);
      expect(sanitized.status).toBe(401);
      expect(sanitized.message).toBe(GENERIC_LOGIN_ERROR);
      expect(friendlyAuthError(msg)).toBe(GENERIC_LOGIN_ERROR);
    }
  });

  it('returns the same generic 401 when an auth.users row has no public.users profile', async () => {
    const { client, signOutSpy } = makeMockLoginClient({ profile: null });
    const outcome = await authenticateLoginRequest({
      headers: new Headers({ 'x-forwarded-for': '198.51.100.10' }),
      payload: { email: 'orphan@asinta.ph', password: 'some-password' },
      supabase: client,
    });

    expect(outcome.status).toBe(401);
    expect(outcome.body.error).toBe(GENERIC_LOGIN_ERROR);
    expect(signOutSpy).toHaveBeenCalledTimes(1);
  });

  it('enforces 10 attempts per 5 minutes per IP without locking out the target Founder email on another IP', async () => {
    const attackerHeaders = new Headers({ 'x-forwarded-for': '198.51.100.77' });
    const founderHeaders = new Headers({ 'x-forwarded-for': '203.0.113.5' });
    const { client: failingClient, signInSpy: failSpy } = makeMockLoginClient({
      authError: { message: 'Invalid login credentials', status: 400 },
    });

    for (let i = 0; i < 10; i += 1) {
      const res = await authenticateLoginRequest({
        headers: attackerHeaders,
        payload: { email: 'junel@asinta.ph', password: `wrong-${i}` },
        supabase: failingClient,
        now: 1_000,
      });
      expect(res.status).toBe(401);
    }
    expect(failSpy).toHaveBeenCalledTimes(10);

    // 11th attempt from the attacker IP is blocked before calling Supabase Auth.
    const blocked = await authenticateLoginRequest({
      headers: attackerHeaders,
      payload: { email: 'junel@asinta.ph', password: 'wrong-11' },
      supabase: failingClient,
      now: 1_000,
    });
    expect(blocked.status).toBe(429);
    expect(blocked.body.rateLimited).toBe(true);
    expect(failSpy).toHaveBeenCalledTimes(10);

    // Meanwhile the real Founder on a different IP can still sign in to the
    // exact same email address — no account lockout DoS.
    const { client: validClient } = makeMockLoginClient();
    const legitimate = await authenticateLoginRequest({
      headers: founderHeaders,
      payload: { email: 'junel@asinta.ph', password: 'correct-password', captchaToken: 'cf-token' },
      supabase: validClient,
      now: 1_000,
    });
    expect(legitimate.status).toBe(200);
    expect(legitimate.body.ok).toBe(true);
    expect(legitimate.body.role).toBe('founder');
  });
});

