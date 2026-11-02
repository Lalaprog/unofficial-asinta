/**
 * Pure scheduling logic for safe automatic SMS reminders.
 *
 * No I/O here — the cron route (/api/cron/reminders) and the Founder-facing
 * reminder queue both build on these functions, and unit tests exercise them
 * directly.
 */

const MANILA_TIME_ZONE = 'Asia/Manila';

/** Sending window: Monday–Saturday, 8:00 AM – 6:00 PM Asia/Manila. */
const SENDING_HOURS = { startHour: 8, endHour: 18 } as const;

/** Days before the due date at which the first reminder becomes eligible. */
export const REMINDER_LEAD_DAYS = 3;

/** Days after the due date of the "overdue" reminder. */
export const REMINDER_OVERDUE_DAYS = 3;

/** Repeat interval for as long as a balance remains. */
export const REMINDER_FOLLOW_UP_INTERVAL_DAYS = 7;

export interface ManilaClock {
  /** ISO date YYYY-MM-DD in Asia/Manila. */
  dateIso: string;
  /** 0 = Sunday … 6 = Saturday, in Asia/Manila. */
  dayOfWeek: number;
  /** 0–23 hour of day in Asia/Manila. */
  hour: number;
}

/** Resolves the current wall-clock values in Asia/Manila for a given instant. */
export function getManilaClock(now: Date = new Date()): ManilaClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: MANILA_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
    weekday: 'short',
  }).formatToParts(now);

  const get = (type: string) => parts.find((part) => part.type === type)?.value || '';
  const weekdayMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  const hourRaw = Number.parseInt(get('hour'), 10);

  return {
    dateIso: `${get('year')}-${get('month')}-${get('day')}`,
    dayOfWeek: weekdayMap[get('weekday')] ?? 0,
    hour: hourRaw === 24 ? 0 : hourRaw,
  };
}

/** Professional hours: Monday–Saturday, 8:00 AM to 5:59 PM Asia/Manila. */
export function isWithinSendingHours(now: Date = new Date()): boolean {
  const clock = getManilaClock(now);
  if (clock.dayOfWeek === 0) return false; // Sunday
  return clock.hour >= SENDING_HOURS.startHour && clock.hour < SENDING_HOURS.endHour;
}

/** Whole-day difference between two ISO dates (b - a). */
export function daysBetween(aIso: string, bIso: string): number {
  const a = Date.UTC(
    Number(aIso.slice(0, 4)), Number(aIso.slice(5, 7)) - 1, Number(aIso.slice(8, 10))
  );
  const b = Date.UTC(
    Number(bIso.slice(0, 4)), Number(bIso.slice(5, 7)) - 1, Number(bIso.slice(8, 10))
  );
  return Math.round((b - a) / 86_400_000);
}

export type ScheduledReminderType = 'upcoming' | 'due_today' | 'overdue' | 'follow_up';

/** Adds whole days to an ISO date string (UTC-safe). */
export function addDaysIso(dateIso: string, days: number): string {
  const base = Date.UTC(
    Number(dateIso.slice(0, 4)), Number(dateIso.slice(5, 7)) - 1, Number(dateIso.slice(8, 10))
  );
  return new Date(base + days * 86_400_000).toISOString().slice(0, 10);
}

/** Next reminder on or after `todayIso` for an unpaid invoice. */
export function nextEligibleReminder(
  dueDateIso: string,
  todayIso: string
): { dateIso: string; type: ScheduledReminderType } {
  const fixed: Array<[number, ScheduledReminderType]> = [
    [-REMINDER_LEAD_DAYS, 'upcoming'],
    [0, 'due_today'],
    [REMINDER_OVERDUE_DAYS, 'overdue'],
  ];
  for (const [offset, type] of fixed) {
    const dateIso = addDaysIso(dueDateIso, offset);
    if (dateIso >= todayIso) return { dateIso, type };
  }
  const daysPastDue = daysBetween(dueDateIso, todayIso);
  const cycles = Math.max(1, Math.ceil((daysPastDue - 3) / 7));
  let offset = 3 + 7 * cycles;
  if (addDaysIso(dueDateIso, offset) < todayIso) offset += 7;
  return { dateIso: addDaysIso(dueDateIso, offset), type: 'follow_up' };
}

/**
 * Schedule:
 * - 3 days before due date  → upcoming
 * - on the due date         → due_today
 * - 3 days after due date   → overdue
 * - every 7 days afterwards → follow_up (while a balance remains)
 *
 * Returns the reminder due TODAY (Manila date) or null when none is due.
 */
export function determineDueReminder(
  dueDateIso: string,
  todayIso: string
): ScheduledReminderType | null {
  const daysPastDue = daysBetween(dueDateIso, todayIso);

  if (daysPastDue === -REMINDER_LEAD_DAYS) return 'upcoming';
  if (daysPastDue === 0) return 'due_today';
  if (daysPastDue === REMINDER_OVERDUE_DAYS) return 'overdue';
  if (
    daysPastDue > REMINDER_OVERDUE_DAYS &&
    (daysPastDue - REMINDER_OVERDUE_DAYS) % REMINDER_FOLLOW_UP_INTERVAL_DAYS === 0
  ) {
    return 'follow_up';
  }
  return null;
}

/**
 * The reminder stage an unpaid invoice is currently in — used to label the
 * reminder queue.
 *
 * This is the single source of truth for the stage boundaries. The reminders
 * page previously re-derived them with different rules (`<= 7 days` counted as
 * overdue), so the queue could label an invoice "Overdue" while the scheduler
 * was already in its weekly follow-up cycle.
 */
export function classifyReminderStage(
  dueDateIso: string,
  todayIso: string
): ScheduledReminderType {
  const daysPastDue = daysBetween(dueDateIso, todayIso);
  if (daysPastDue < 0) return 'upcoming';
  if (daysPastDue === 0) return 'due_today';
  if (daysPastDue <= REMINDER_OVERDUE_DAYS) return 'overdue';
  return 'follow_up';
}

/**
 * Deterministic idempotency key. Combined with the UNIQUE database
 * constraint on reminder_dispatches.idempotency_key, this guarantees a given
 * reminder is dispatched at most once even if the cron job runs repeatedly.
 */
export function buildDispatchIdempotencyKey(
  invoiceId: string,
  channel: 'sms' | 'email',
  reminderType: ScheduledReminderType,
  scheduledDateIso: string
): string {
  return `${invoiceId}:${channel}:${reminderType}:${scheduledDateIso}`;
}

export interface ReminderEligibilityInput {
  invoiceStatus: string;
  invoiceAmount: number;
  amountPaid: number;
  automaticRemindersEnabled: boolean;
  remindersPausedUntil?: string | null;
  clientPhoneNormalized: string | null;
  /** Current instant (for pause comparisons). */
  now?: Date;
}

export interface ReminderEligibility {
  eligible: boolean;
  reason?: string;
}

/** Safety checks applied before ANY automatic send. */
export function checkReminderEligibility(input: ReminderEligibilityInput): ReminderEligibility {
  const now = input.now ?? new Date();
  const balance = input.invoiceAmount - input.amountPaid;

  if (input.invoiceStatus === 'paid') return { eligible: false, reason: 'invoice_paid' };
  if (input.invoiceStatus === 'cancelled') return { eligible: false, reason: 'invoice_cancelled' };
  if (input.invoiceStatus === 'draft') return { eligible: false, reason: 'invoice_draft' };
  if (balance <= 0) return { eligible: false, reason: 'zero_balance' };
  if (!input.automaticRemindersEnabled) return { eligible: false, reason: 'invoice_reminders_disabled' };
  if (input.remindersPausedUntil && new Date(input.remindersPausedUntil).getTime() > now.getTime()) {
    return { eligible: false, reason: 'reminders_paused' };
  }
  if (!input.clientPhoneNormalized) return { eligible: false, reason: 'invalid_phone' };

  return { eligible: true };
}

/** True when the platform-wide automatic reminder switch is on. */
export function isGlobalAutomaticRemindersEnabled(
  envValue: string | undefined = process.env.AUTOMATIC_REMINDERS_ENABLED
): boolean {
  return (envValue || '').trim().toLowerCase() === 'true';
}

/** Constant-time-ish comparison for the cron secret. */
export function isAuthorizedCronRequest(
  authorizationHeader: string | null,
  cronSecret: string | undefined = process.env.CRON_SECRET
): boolean {
  const secret = (cronSecret || '').trim();
  if (!secret) return false;
  const header = (authorizationHeader || '').trim();
  const expected = `Bearer ${secret}`;
  if (header.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i += 1) {
    mismatch |= header.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return mismatch === 0;
}
