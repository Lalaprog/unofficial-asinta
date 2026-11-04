/**
 * In-process rate limiting for BALE's API routes.
 *
 * WHY THIS EXISTS
 * ---------------
 * The app had no limiter at all. The routes that matter cost real money or
 * real trust:
 *   - /api/sms/send  → every message is billed by PhilSMS.
 *   - /api/email/test, /api/email/request-payment → outbound mail volume.
 *   - /api/ai/*      → paid Groq tokens.
 * A stuck retry loop in a browser tab was enough to burn an SMS budget.
 *
 * WHAT THIS IS NOT
 * ----------------
 * This is a *single-instance* limiter: counters live in module memory. On a
 * serverless platform that scales horizontally each instance keeps its own
 * counter, so the effective limit is `limit × instanceCount`. It reliably
 * stops accidental loops, double-submits, and casual abuse from one client; it
 * is not a defence against a distributed attacker. The production upgrade path
 * (documented in docs/SECURITY.md) is a shared store — Upstash Redis, or a
 * Supabase table — plugged into the same `checkRateLimit` interface.
 *
 * The login route additionally applies a database-backed, per-email-and-IP
 * cooldown. This file's IP-only counter remains a secondary, per-instance
 * request-volume limit; it also counts successful sign-ins.
 * Neither protects the public Supabase Auth endpoint directly.
 */

export interface RateLimitRule {
  /** Maximum number of requests allowed inside the window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Requests still available after this one. Never negative. */
  remaining: number;
  /** Seconds until the caller should retry. 0 when allowed. */
  retryAfterSeconds: number;
}

interface Bucket {
  /** Timestamps (ms) of requests inside the current window. */
  hits: number[];
}

/**
 * Sliding-window counter. Sliding (rather than fixed-window) so a caller cannot
 * burst `2 × limit` requests across a window boundary.
 */
export class SlidingWindowRateLimiter {
  private buckets = new Map<string, Bucket>();
  private lastSweep = 0;

  /** Sized so a leaked bucket cannot grow without bound. */
  constructor(private readonly maxTrackedKeys = 5_000) {}

  check(key: string, rule: RateLimitRule, now: number = Date.now()): RateLimitDecision {
    this.sweepIfDue(now, rule.windowMs);

    const bucket = this.buckets.get(key) ?? { hits: [] };
    const cutoff = now - rule.windowMs;
    bucket.hits = bucket.hits.filter((timestamp) => timestamp > cutoff);

    if (bucket.hits.length >= rule.limit) {
      const oldest = bucket.hits[0] ?? now;
      const retryAfterMs = Math.max(oldest + rule.windowMs - now, 0);
      this.buckets.set(key, bucket);
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(Math.ceil(retryAfterMs / 1000), 1),
      };
    }

    bucket.hits.push(now);
    this.buckets.set(key, bucket);
    return {
      allowed: true,
      remaining: Math.max(rule.limit - bucket.hits.length, 0),
      retryAfterSeconds: 0,
    };
  }

  /** Test/reset hook. */
  reset(): void {
    this.buckets.clear();
    this.lastSweep = 0;
  }

  get trackedKeyCount(): number {
    return this.buckets.size;
  }

  private sweepIfDue(now: number, windowMs: number): void {
    // Amortised cleanup; a sweep every window keeps memory flat for normal use.
    if (now - this.lastSweep < windowMs) return;
    this.lastSweep = now;

    const cutoff = now - windowMs;
    for (const [key, bucket] of this.buckets) {
      bucket.hits = bucket.hits.filter((timestamp) => timestamp > cutoff);
      if (bucket.hits.length === 0) this.buckets.delete(key);
    }

    // Hard cap: if a hostile client mints keys faster than they expire, drop
    // the oldest insertions rather than growing without limit.
    if (this.buckets.size > this.maxTrackedKeys) {
      const excess = this.buckets.size - this.maxTrackedKeys;
      let removed = 0;
      for (const key of this.buckets.keys()) {
        this.buckets.delete(key);
        if (++removed >= excess) break;
      }
    }
  }
}

/**
 * Named rules for each route. Centralised so the limits are reviewable in one
 * place instead of being scattered magic numbers.
 */
export const RATE_LIMITS = {
  /** SMS costs money per message. A human cannot legitimately send 15 in 10 minutes. */
  smsSend: { limit: 15, windowMs: 10 * 60 * 1000 },
  /** A Founder test-firing SMTP a handful of times per hour is plenty. */
  emailTest: { limit: 5, windowMs: 60 * 60 * 1000 },
  /** Request-for-payment is one email per invoice milestone. */
  emailSend: { limit: 20, windowMs: 60 * 60 * 1000 },
  /** Pure read/preview of email templates. */
  emailPreview: { limit: 60, windowMs: 60 * 1000 },
  /** Groq tokens are paid; typing quickly should not trip this. */
  aiSuggest: { limit: 30, windowMs: 60 * 1000 },
  /** Vision/audio extraction is the most expensive call per request. */
  aiExtract: { limit: 12, windowMs: 60 * 1000 },
  /** Gateway connectivity checks. */
  integrationTest: { limit: 5, windowMs: 15 * 60 * 1000 },
  /**
   * Sign-in attempts per IP (10 per 5 minutes — matches Supabase Auth
   * `sign_in_sign_ups`). Keyed by IP only. The separate shared login guard
   * is keyed by the combination of normalized email and IP.
   */
  authLogin: { limit: 10, windowMs: 5 * 60 * 1000 },
  /** Per-instance secondary limit; Supabase Auth retains its own project limits. */
  authEmailCode: { limit: 3, windowMs: 5 * 60 * 1000 },
} as const satisfies Record<string, RateLimitRule>;

export type RateLimitName = keyof typeof RATE_LIMITS;

const globalLimiter = new SlidingWindowRateLimiter();

/**
 * Shared limiter used by the API routes. Keyed by caller identity when we have
 * one (the authenticated user id) and by client address otherwise.
 */
export function checkRateLimit(
  name: RateLimitName,
  identity: string,
  now: number = Date.now()
): RateLimitDecision {
  return globalLimiter.check(`${name}:${identity}`, RATE_LIMITS[name], now);
}

/** Test hook. Never called from application code. */
export function resetRateLimits(): void {
  globalLimiter.reset();
}

/**
 * Best-effort client address.
 *
 * `x-forwarded-for` is client-controlled unless the request passed through a
 * trusted proxy — production deployments (Vercel, or any reverse proxy) always
 * append the real address, and we take the left-most entry that the platform
 * added. This is a secondary signal only: authenticated routes key on the
 * user id, which cannot be spoofed.
 */
export function getClientAddress(headers: Headers): string {
  const forwardedFor = headers.get('x-forwarded-for');
  if (forwardedFor) {
    const first = forwardedFor.split(',')[0]?.trim();
    if (first) return first;
  }
  return headers.get('x-real-ip')?.trim() || 'unknown';
}

/**
 * Identity for rate limiting: the authenticated user when available, otherwise
 * the client address. Route handlers call `requireFounder` first, so the user
 * id is normally present.
 */
export function getRateLimitIdentity(headers: Headers, userId?: string | null): string {
  return userId ? `user:${userId}` : `ip:${getClientAddress(headers)}`;
}

/**
 * IP-only identity for sign-in rate limiting.
 *
 * This secondary in-process request limiter is deliberately IP-only. The
 * shared login cooldown separately keys on email and IP together.
 */
export function getLoginRateLimitIdentity(headers: Headers): string {
  return `ip:${getClientAddress(headers)}`;
}

export interface RateLimitHeaders {
  'Retry-After': string;
  'X-RateLimit-Limit': string;
  'X-RateLimit-Remaining': string;
}

/** Standard 429 headers so the caller can back off without guessing. */
export function rateLimitHeaders(
  name: RateLimitName,
  decision: RateLimitDecision
): RateLimitHeaders {
  return {
    'Retry-After': String(decision.retryAfterSeconds),
    'X-RateLimit-Limit': String(RATE_LIMITS[name].limit),
    'X-RateLimit-Remaining': String(decision.remaining),
  };
}

/**
 * Human-readable 429 body. Deliberately states the retry delay so the UI can
 * tell the Founder exactly how long to wait instead of "something went wrong".
 */
export function rateLimitMessage(name: RateLimitName, decision: RateLimitDecision): string {
  const minutes = Math.max(Math.ceil(decision.retryAfterSeconds / 60), 1);
  const scope =
    name === 'smsSend'
      ? 'SMS messages outside the business day are usually a stuck tab rather than a human.'
      : name === 'authLogin'
        ? 'Too many sign-in requests from this network.'
        : 'This is a cost-control limit.';
  return `Too many requests (limit: ${RATE_LIMITS[name].limit} per ${Math.round(
    RATE_LIMITS[name].windowMs / 60000
  )} min). Try again in about ${minutes} minute${minutes === 1 ? '' : 's'}. ${scope}`;
}
