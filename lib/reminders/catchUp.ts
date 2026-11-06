import { addDaysIso, daysBetween, type ScheduledReminderType } from './scheduler';

export interface ReminderSlot { type: ScheduledReminderType; scheduledDate: string }

/** Strictly validate actual calendar dates before doing arithmetic. */
function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number(value.slice(0,4)) < 1900) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * Select ONE most recent scheduled slot, so missed days do not produce a burst
 * of old messages. The returned date is the original schedule date (not the
 * processing date) and must be used in the idempotency key across retries.
 *
 * `enabledFrom` is the Manila calendar date at which this channel became
 * eligible. Old slots before that date are not backfilled after re-enabling.
 * The caller MUST still enforce business hours, controls, invoice eligibility,
 * recent manual sends, provider readiness, logging and idempotency. This pure
 * helper is not wired into the current cron yet and cannot send messages.
 */
export function latestReminderSlot(dueDate: string, today: string, enabledFrom: string): ReminderSlot | null {
  if (![dueDate, today, enabledFrom].every(validDate) || enabledFrom > today) return null;
  const daysPastDue = daysBetween(dueDate, today);
  if (daysPastDue < -3) return null;
  let type: ScheduledReminderType;
  let offset: number;
  if (daysPastDue < 0) { type = 'upcoming'; offset = -3; }
  else if (daysPastDue < 3) { type = 'due_today'; offset = 0; }
  else if (daysPastDue < 10) { type = 'overdue'; offset = 3; }
  else { type = 'follow_up'; offset = 3 + Math.floor((daysPastDue - 3) / 7) * 7; }
  const scheduledDate = addDaysIso(dueDate, offset);
  return scheduledDate < enabledFrom ? null : {type, scheduledDate};
}
