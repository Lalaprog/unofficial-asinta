import { describe, expect, it } from 'vitest';
import {
  addDaysIso,
  buildDispatchIdempotencyKey,
  checkReminderEligibility,
  daysBetween,
  determineDueReminder,
  getManilaClock,
  isAuthorizedCronRequest,
  isGlobalAutomaticRemindersEnabled,
  isWithinSendingHours,
  nextEligibleReminder,
} from '@/lib/reminders/scheduler';

describe('global automatic-reminders switch', () => {
  it('is disabled unless the env value is exactly "true"', () => {
    expect(isGlobalAutomaticRemindersEnabled(undefined)).toBe(false);
    expect(isGlobalAutomaticRemindersEnabled('')).toBe(false);
    expect(isGlobalAutomaticRemindersEnabled('false')).toBe(false);
    expect(isGlobalAutomaticRemindersEnabled('1')).toBe(false);
    expect(isGlobalAutomaticRemindersEnabled('TRUE')).toBe(true);
    expect(isGlobalAutomaticRemindersEnabled('true')).toBe(true);
  });
});

describe('invoice eligibility safety checks', () => {
  const base = {
    invoiceStatus: 'pending',
    invoiceAmount: 1000,
    amountPaid: 0,
    automaticRemindersEnabled: true,
    remindersPausedUntil: null as string | null,
    clientPhoneNormalized: '+639178421190' as string | null,
  };

  it('excludes paid, cancelled, and zero-balance invoices', () => {
    expect(checkReminderEligibility({ ...base, invoiceStatus: 'paid' }).reason).toBe('invoice_paid');
    expect(checkReminderEligibility({ ...base, invoiceStatus: 'cancelled' }).reason).toBe('invoice_cancelled');
    expect(checkReminderEligibility({ ...base, amountPaid: 1000 }).reason).toBe('zero_balance');
    expect(checkReminderEligibility({ ...base, invoiceAmount: 0 }).reason).toBe('zero_balance');
  });

  it('excludes invoices with reminders disabled at the invoice level', () => {
    expect(checkReminderEligibility({ ...base, automaticRemindersEnabled: false }).reason).toBe(
      'invoice_reminders_disabled'
    );
  });

  it('excludes paused invoices until the pause expires', () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const past = new Date(Date.now() - 86_400_000).toISOString();
    expect(checkReminderEligibility({ ...base, remindersPausedUntil: future }).reason).toBe(
      'reminders_paused'
    );
    expect(checkReminderEligibility({ ...base, remindersPausedUntil: past }).eligible).toBe(true);
  });

  it('excludes clients without a valid Philippine mobile number', () => {
    expect(checkReminderEligibility({ ...base, clientPhoneNormalized: null }).reason).toBe(
      'invalid_phone'
    );
  });

  it('fails closed on malformed or unsupported invoice details and pause dates', () => {
    expect(checkReminderEligibility({ ...base, invoiceStatus: 'unknown' }).reason).toBe('invalid_invoice_status');
    expect(checkReminderEligibility({ ...base, invoiceAmount: NaN }).reason).toBe('invalid_invoice_amount');
    expect(checkReminderEligibility({ ...base, amountPaid: Infinity }).reason).toBe('invalid_invoice_amount');
    expect(checkReminderEligibility({ ...base, amountPaid: -1 }).reason).toBe('invalid_invoice_amount');
    expect(checkReminderEligibility({ ...base, remindersPausedUntil: 'not a date' }).reason).toBe('invalid_pause');
    expect(checkReminderEligibility({ ...base, now: new Date('invalid') }).reason).toBe('invalid_current_time');
  });

  it('allows an unpaid, enabled, unpaused invoice with a valid phone', () => {
    expect(checkReminderEligibility(base).eligible).toBe(true);
  });
});

describe('reminder schedule', () => {
  it('follows the 3-days-before / due / 3-days-after / weekly cadence', () => {
    expect(determineDueReminder('2026-01-20', '2026-01-17')).toBe('upcoming');
    expect(determineDueReminder('2026-01-20', '2026-01-20')).toBe('due_today');
    expect(determineDueReminder('2026-01-20', '2026-01-23')).toBe('overdue');
    expect(determineDueReminder('2026-01-20', '2026-01-30')).toBe('follow_up');
    expect(determineDueReminder('2026-01-20', '2026-02-06')).toBe('follow_up');
    // Nothing due on off-schedule days:
    expect(determineDueReminder('2026-01-20', '2026-01-18')).toBeNull();
    expect(determineDueReminder('2026-01-20', '2026-01-24')).toBeNull();
    expect(determineDueReminder('2026-01-20', '2026-01-31')).toBeNull();
  });

  it('computes the next eligible reminder date', () => {
    expect(nextEligibleReminder('2026-01-20', '2026-01-10')).toEqual({
      dateIso: '2026-01-17',
      type: 'upcoming',
    });
    expect(nextEligibleReminder('2026-01-20', '2026-01-18')).toEqual({
      dateIso: '2026-01-20',
      type: 'due_today',
    });
    expect(nextEligibleReminder('2026-01-20', '2026-01-21')).toEqual({
      dateIso: '2026-01-23',
      type: 'overdue',
    });
    expect(nextEligibleReminder('2026-01-20', '2026-01-24')).toEqual({
      dateIso: '2026-01-30',
      type: 'follow_up',
    });
  });

  it('daysBetween and addDaysIso are UTC-safe', () => {
    expect(daysBetween('2026-01-20', '2026-01-23')).toBe(3);
    expect(daysBetween('2026-01-20', '2026-01-17')).toBe(-3);
    expect(addDaysIso('2026-01-30', 3)).toBe('2026-02-02');
  });
});

describe('duplicate protection', () => {
  it('builds a deterministic idempotency key', () => {
    const a = buildDispatchIdempotencyKey('inv-1', 'sms', 'due_today', '2026-01-20');
    const b = buildDispatchIdempotencyKey('inv-1', 'sms', 'due_today', '2026-01-20');
    const c = buildDispatchIdempotencyKey('inv-1', 'sms', 'due_today', '2026-01-21');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toBe('inv-1:sms:due_today:2026-01-20');
  });


});

describe('Manila timezone and sending hours', () => {
  it('resolves the Manila calendar date across the UTC boundary', () => {
    // 2026-01-19 17:00 UTC = 2026-01-20 01:00 Manila
    const clock = getManilaClock(new Date('2026-01-19T17:00:00Z'));
    expect(clock.dateIso).toBe('2026-01-20');
    expect(clock.hour).toBe(1);
  });

  it('allows Monday–Saturday 08:00–17:59 Manila only', () => {
    // Tue 2026-01-20 10:00 Manila = 02:00 UTC → allowed
    expect(isWithinSendingHours(new Date('2026-01-20T02:00:00Z'))).toBe(true);
    // Tue 07:59 Manila (23:59 UTC previous day) → blocked (too early)
    expect(isWithinSendingHours(new Date('2026-01-19T23:59:00Z'))).toBe(false);
    // Tue 18:00 Manila = 10:00 UTC → blocked (too late)
    expect(isWithinSendingHours(new Date('2026-01-20T10:00:00Z'))).toBe(false);
    // Sunday 2026-01-18 10:00 Manila = 02:00 UTC Sunday → blocked
    expect(isWithinSendingHours(new Date('2026-01-18T02:00:00Z'))).toBe(false);
    // Saturday 2026-01-17 10:00 Manila → allowed
    expect(isWithinSendingHours(new Date('2026-01-17T02:00:00Z'))).toBe(true);
  });
});

describe('cron authorization', () => {
  it('rejects missing or invalid secrets and accepts the exact bearer token', () => {
    expect(isAuthorizedCronRequest(null, 'secret-123')).toBe(false);
    expect(isAuthorizedCronRequest('', 'secret-123')).toBe(false);
    expect(isAuthorizedCronRequest('Bearer wrong', 'secret-123')).toBe(false);
    expect(isAuthorizedCronRequest('secret-123', 'secret-123')).toBe(false);
    expect(isAuthorizedCronRequest('Bearer secret-1234', 'secret-123')).toBe(false);
    expect(isAuthorizedCronRequest('Bearer secret-123', 'secret-123')).toBe(true);
  });

  it('never authorizes when CRON_SECRET is unset (fails closed)', () => {
    expect(isAuthorizedCronRequest('Bearer ', '')).toBe(false);
    expect(isAuthorizedCronRequest('Bearer undefined', undefined)).toBe(false);
  });
});
