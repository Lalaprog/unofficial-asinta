/**
 * Conservative, no-send catch-up planning. This is not wired to cron and is
 * not authorization to send: callers would still need fresh eligibility,
 * provider readiness, a durable cross-send reservation and a final recheck.
 */
import { latestReminderSlot, type ReminderSlot } from './catchUp';
import { addDaysIso, getManilaClock, isWithinSendingHours } from './scheduler';

export type CatchUpPlan = { ok: true; slot: ReminderSlot } | { ok: false; reason: string };

// Only unambiguous, valid ISO instants with an explicit timezone are accepted.
function instant(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return null;
  const day = new Date(`${match[1]}T00:00:00.000Z`);
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0,10) !== match[1] || Number(match[1].slice(0,4)) < 1900 || Number(match[1].slice(0,4)) >= 9999) return null;
  if (Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59) return null;
  if (match[5] !== 'Z') {
    const hour = Number(match[5].slice(1,3)), minute = Number(match[5].slice(4,6));
    if (hour > 14 || minute > 59 || (hour === 14 && minute !== 0)) return null;
  }
  const result = new Date(value);
  return Number.isFinite(result.getTime()) ? result : null;
}

/**
 * Approved conservative policy, not active in production:
 * - Eligibility or schedule changes at/after 8 AM exclude that whole Manila
 *   day's slot. This avoids backfilling when a channel/invoice is re-enabled.
 * - A previous contact on this channel on/after the slot date covers that slot;
 *   and no new automatic contact is planned within 24 hours of a previous
 *   contact on this same channel. Email and SMS are independent.
 * - An unresolved prior attempt blocks planning until reviewed.
 * Required timestamps must come from authoritative server-controlled sources;
 * null `lastContactAt` means an authoritative successful read found none.
 * The invoice and due-date epochs are not yet stored by the application.
 */
export function planCatchUp(params: {
  dueDate: string;
  now: Date;
  channelEffectiveSince: string;
  invoiceEffectiveSince: string;
  scheduleEffectiveSince: string;
  pausedUntil: string | null;
  lastContactAt: string | null;
  unresolvedAttempt: boolean;
}): CatchUpPlan {
  if (!(params.now instanceof Date) || !Number.isFinite(params.now.getTime())) return {ok:false,reason:'invalid_now'};
  if (typeof params.unresolvedAttempt !== 'boolean') return {ok:false,reason:'contact_history_unavailable'};
  if (!isWithinSendingHours(params.now)) return {ok:false,reason:'outside_sending_hours'};
  const nowMs = params.now.getTime();
  const epochs = [params.channelEffectiveSince, params.invoiceEffectiveSince, params.scheduleEffectiveSince].map(instant);
  if (epochs.some(value => !value || value.getTime() > nowMs)) return {ok:false,reason:'eligibility_history_unavailable'};
  if (params.pausedUntil !== null) {
    const pause = instant(params.pausedUntil);
    if (!pause) return {ok:false,reason:'invalid_pause'};
    if (pause.getTime() > nowMs) return {ok:false,reason:'invoice_paused'};
    epochs.push(pause);
  }
  if (params.unresolvedAttempt) return {ok:false,reason:'unresolved_attempt'};
  let lastContact: Date | null = null;
  if (params.lastContactAt !== null) {
    lastContact = instant(params.lastContactAt);
    if (!lastContact || lastContact.getTime() > nowMs) return {ok:false,reason:'contact_history_unavailable'};
  }
  // For eligibility at or after 8:00, exclude the date itself. This also
  // handles a Sunday slot when activation happened after its scheduled time.
  const eligibleDates = (epochs as Date[]).map(epoch => {
    const clock = getManilaClock(epoch);
    return clock.hour >= 8 ? addDaysIso(clock.dateIso, 1) : clock.dateIso;
  });
  const enabledFrom = eligibleDates.sort().at(-1)!;
  const slot = latestReminderSlot(params.dueDate, getManilaClock(params.now).dateIso, enabledFrom);
  if (!slot) return {ok:false,reason:'no_eligible_slot'};
  if (lastContact && getManilaClock(lastContact).dateIso >= slot.scheduledDate) return {ok:false,reason:'slot_already_covered'};
  if (lastContact && nowMs - lastContact.getTime() < 24 * 60 * 60 * 1000) return {ok:false,reason:'recent_contact'};
  return {ok:true,slot};
}
