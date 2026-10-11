/**
 * Session-timeout policy and clock arithmetic.
 *
 * Supabase Auth is the ENFORCER: the project-level settings
 * (`auth.sessions.inactivity_timeout`, `auth.sessions.timebox`) decide when a
 * session stops being refreshable. This module is the MESSENGER: it predicts
 * when that will happen so every signed-in user (`founder` and `supervisor`)
 * gets a two-minute warning and a "stay signed in" button instead of being
 * bounced to the login screen mid-task.
 *
 * Role scope: timeouts apply to ALL roles, not Founder-only. Supervisors record
 * attendance, which feeds payroll, so an always-valid session is a standing
 * exposure. In addition, Supabase `inactivity_timeout` and `timebox` are
 * project-wide — per-role enforcement does not exist in GoTrue, so any
 * per-role difference in the browser would be advisory only.
 *
 * Build-time note: `NEXT_PUBLIC_SESSION_*` variables are inlined into the
 * client bundle by `next build`. Changing them in Vercel requires a rebuild,
 * not a redeploy of an existing build artifact.
 *
 * Two limits, deliberately both:
 *   - idle: no user activity for N minutes → the session stops refreshing.
 *     Idle alone can be defeated by a keep-alive request, so…
 *   - absolute: a session that started more than H hours ago ends regardless of
 *     activity. 8 hours covers a full site day without an overnight-open tab.
 *
 * The arithmetic is pure and separate from the React component precisely
 * because the failure modes here are subtle:
 *   - a laptop closed for an hour (timers do not run while suspended),
 *   - a background tab throttled to one timer call per minute,
 *   - `mousemove` firing dozens of times per second.
 * The component re-reads wall-clock time and recomputes on every wake-up, so a
 * missed timer can only ever delay the check, never the logout.
 */

export interface SessionPolicy {
  /** No activity for this long and the session stops being refreshable. */
  idleTimeoutMs: number;
  /** Hard stop for the session, measured from sign-in. */
  absoluteTimeoutMs: number;
  /** How long before the deadline the warning dialog appears. */
  warningMs: number;
}

export const SESSION_POLICY_DEFAULTS = {
  idleMinutes: 20,
  absoluteHours: 8,
  warningSeconds: 120,
} as const;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

function readPositiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Reads the policy from public environment variables (they are shipped to the
 * browser, which is what runs this clock).
 *
 * The defaults MUST match the Supabase project settings documented in
 * supabase/config.toml and docs/SECURITY.md; a mismatch means the dialog warns
 * at the wrong moment, which is a usability bug but never a security hole —
 * the server still refuses the refresh.
 */
export function getSessionPolicy(
  env: Record<string, string | undefined> = process.env
): SessionPolicy {
  const idleMinutes = readPositiveNumber(
    env.NEXT_PUBLIC_SESSION_IDLE_TIMEOUT_MINUTES,
    SESSION_POLICY_DEFAULTS.idleMinutes
  );
  const absoluteHours = readPositiveNumber(
    env.NEXT_PUBLIC_SESSION_ABSOLUTE_TIMEOUT_HOURS,
    SESSION_POLICY_DEFAULTS.absoluteHours
  );
  const warningSeconds = readPositiveNumber(
    env.NEXT_PUBLIC_SESSION_WARNING_SECONDS,
    SESSION_POLICY_DEFAULTS.warningSeconds
  );

  return {
    idleTimeoutMs: idleMinutes * MINUTE_MS,
    absoluteTimeoutMs: absoluteHours * HOUR_MS,
    // A warning longer than the idle window would show immediately on load.
    warningMs: Math.min(warningSeconds * 1000, idleMinutes * MINUTE_MS - 1000),
  };
}

export interface SessionClockInput {
  /** Wall-clock ms of the last observed user activity (or of sign-in). */
  lastActivityAt: number;
  /** Wall-clock ms when this session was established. */
  sessionStartedAt: number;
  /** Injectable for tests. */
  now: number;
  policy: SessionPolicy;
}

export interface SessionClockState {
  /** When the idle clock expires. */
  idleDeadline: number;
  /** When the absolute clock expires. */
  absoluteDeadline: number;
  /** Whichever limit comes first. */
  effectiveDeadline: number;
  /** When the warning dialog should appear. */
  warningAt: number;
  /** ms until the session ends; 0 once expired. */
  msUntilLogout: number;
  /** Which limit is driving the deadline — shown to the user, not guessed. */
  limitingFactor: 'idle' | 'absolute';
  shouldWarn: boolean;
  hasExpired: boolean;
}

/** The single source of truth for "are we nearly out of session?". */
export function computeSessionState(input: SessionClockInput): SessionClockState {
  const { lastActivityAt, sessionStartedAt, now, policy } = input;

  const idleDeadline = lastActivityAt + policy.idleTimeoutMs;
  const absoluteDeadline = sessionStartedAt + policy.absoluteTimeoutMs;
  const limitingFactor: 'idle' | 'absolute' =
    absoluteDeadline <= idleDeadline ? 'absolute' : 'idle';
  const effectiveDeadline = Math.min(idleDeadline, absoluteDeadline);
  const warningAt = effectiveDeadline - policy.warningMs;
  const msUntilLogout = Math.max(effectiveDeadline - now, 0);

  return {
    idleDeadline,
    absoluteDeadline,
    effectiveDeadline,
    warningAt,
    msUntilLogout,
    limitingFactor,
    shouldWarn: now >= warningAt && msUntilLogout > 0,
    hasExpired: msUntilLogout === 0,
  };
}

/**
 * Formats a countdown as `m:ss`.
 *
 * Rounding is UP so the displayed value never promises more time than remains:
 * with 119.4s left the UI shows "2:00", not "1:59" — the safe direction for a
 * boundary a user might act on.
 */
export function formatCountdown(ms: number): string {
  const totalSeconds = Math.max(Math.ceil(ms / 1000), 0);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Screen-reader phrasing. A bare "1:59" is announced as "one colon fifty-nine"
 * by some readers, so the countdown is also spoken in words.
 */
export function describeCountdown(ms: number): string {
  const totalSeconds = Math.max(Math.ceil(ms / 1000), 0);
  if (totalSeconds === 0) return 'signed out now';

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  const minutePart = minutes > 0 ? `${minutes} minute${minutes === 1 ? '' : 's'}` : '';
  const secondPart = seconds > 0 ? `${seconds} second${seconds === 1 ? '' : 's'}` : '';

  if (minutePart && secondPart) return `${minutePart} and ${secondPart}`;
  return minutePart || secondPart;
}

/** Spoken sentence describing why the session is ending. */
export function describeDeadlineReason(limitingFactor: 'idle' | 'absolute'): string {
  return limitingFactor === 'absolute'
    ? 'This session reaches its maximum length of 8 hours.'
    : 'No activity was detected in BALE.';
}

/**
 * One-shot notice handed to the login page after a session ends, so the
 * Founder sees "you were signed out after inactivity" instead of a mysterious
 * bounce to the sign-in form.
 *
 * Stored in sessionStorage (per tab, cleared when the tab closes) and only ever
 * holds a code plus a timestamp — no personal data.
 */
export const AUTH_NOTICE_STORAGE_KEY = 'bale.auth.notice';

/**
 * Set by the Sign out button before calling `supabase.auth.signOut()`. The
 * watcher checks it when SIGNED_OUT arrives, so a deliberate logout is never
 * reported as "you were signed out after inactivity".
 */
export const DELIBERATE_LOGOUT_STORAGE_KEY = 'bale.auth.deliberate_logout';

export type AuthNoticeCode = 'idle_timeout' | 'absolute_timeout' | 'server_ended_session';

export interface AuthNotice {
  code: AuthNoticeCode;
  at: string;
}

export function buildAuthNotice(code: AuthNoticeCode, now: Date = new Date()): AuthNotice {
  return { code, at: now.toISOString() };
}

/** Human-readable login-page message for a notice code. */
export function authNoticeMessage(code: AuthNoticeCode): string {
  switch (code) {
    case 'idle_timeout':
      return 'You were signed out after inactivity. Sign in again to continue where you left off.';
    case 'absolute_timeout':
      return 'Your session reached its maximum length and was closed. Sign in again to continue.';
    case 'server_ended_session':
    default:
      return 'Your session ended at the server and you were signed out. This happens after prolonged inactivity or when the session expires. Sign in again to continue.';
  }
}

export function parseAuthNotice(raw: string | null): AuthNotice | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<AuthNotice>;
    if (
      parsed?.code === 'idle_timeout' ||
      parsed?.code === 'absolute_timeout' ||
      parsed?.code === 'server_ended_session'
    ) {
      return { code: parsed.code, at: typeof parsed.at === 'string' ? parsed.at : new Date().toISOString() };
    }
    return null;
  } catch {
    return null;
  }
}

/** Activity events that count as "the human is still here". */
export const ACTIVITY_EVENTS = [
  'mousedown',
  'keydown',
  'touchstart',
  'pointerdown',
  'wheel',
  'scroll',
  'focus',
] as const;

/**
 * `mousemove` is deliberately NOT in the list above: it fires continuously and
 * would keep a session alive from nothing more than a nudged mouse, which is
 * exactly what an inactivity timeout is meant to catch. A click, a key press,
 * a touch, or a scroll folds back into the throttled handler instead.
 */
export const ACTIVITY_THROTTLE_MS = 15_000;
