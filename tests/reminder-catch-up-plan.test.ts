import { describe, expect, it } from 'vitest';
import { planCatchUp } from '@/lib/reminders/planCatchUp';
function input() {
  return {dueDate:'2026-11-01', now:new Date('2026-11-02T00:00:00Z'), channelEffectiveSince:'2026-10-01T00:00:00Z', invoiceEffectiveSince:'2026-10-01T00:00:00Z', scheduleEffectiveSince:'2026-10-01T00:00:00Z', pausedUntil:null as string | null, lastContactAt:null as string | null, unresolvedAttempt:false};
}
describe('conservative catch-up planning (unwired)', () => {
  it('catches up one Sunday slot on Monday, preserving its original date', () => {
    expect(planCatchUp(input())).toEqual({ok:true,slot:{type:'due_today',scheduledDate:'2026-11-01'}});
  });
  it('blocks outside approved hours including Sunday, 7:59 and 18:00 Manila', () => {
    for (const now of ['2026-11-01T04:00:00Z','2026-11-01T23:59:59Z','2026-11-02T10:00:00Z']) {
      expect(planCatchUp({...input(),now:new Date(now)})).toEqual({ok:false,reason:'outside_sending_hours'});
    }
  });
  it('does not backfill prior slots after enabling, unpausing or changing a due date', () => {
    for (const key of ['channelEffectiveSince','invoiceEffectiveSince','scheduleEffectiveSince'] as const) {
      expect(planCatchUp({...input(),[key]:'2026-11-01T00:00:00Z'})).toEqual({ok:false,reason:'no_eligible_slot'});
      expect(planCatchUp({...input(),[key]:'2026-10-31T23:59:59Z'})).toEqual({ok:true,slot:{type:'due_today',scheduledDate:'2026-11-01'}});
    }
    expect(planCatchUp({...input(),pausedUntil:'2026-11-01T00:00:00Z'})).toEqual({ok:false,reason:'no_eligible_slot'});
    expect(planCatchUp({...input(),pausedUntil:'2026-11-02T01:00:00Z'})).toEqual({ok:false,reason:'invoice_paused'});
  });
  it('does not send a covered slot, flood after a recent contact, or proceed with an unresolved attempt', () => {
    expect(planCatchUp({...input(),lastContactAt:'2026-11-01T01:00:00Z'})).toEqual({ok:false,reason:'slot_already_covered'});
    expect(planCatchUp({...input(),dueDate:'2026-11-02',lastContactAt:'2026-11-01T01:00:00Z'})).toEqual({ok:false,reason:'recent_contact'});
    expect(planCatchUp({...input(),unresolvedAttempt:true})).toEqual({ok:false,reason:'unresolved_attempt'});
  });
  it('rejects ambiguous, invalid and future time data rather than guessing', () => {
    for (const epoch of ['2026-10-01','2026-02-30T00:00:00Z','2026-10-01T25:00:00Z','2026-10-01T00:00:00+14:01','2026-11-02T00:00:01Z']) {
      expect(planCatchUp({...input(),channelEffectiveSince:epoch})).toEqual({ok:false,reason:'eligibility_history_unavailable'});
    }
    expect(planCatchUp({...input(),lastContactAt:'bad'})).toEqual({ok:false,reason:'contact_history_unavailable'});
    expect(planCatchUp({...input(),pausedUntil:'bad'})).toEqual({ok:false,reason:'invalid_pause'});
    expect(planCatchUp({...input(),dueDate:'2026-02-30'})).toEqual({ok:false,reason:'no_eligible_slot'});
    expect(planCatchUp({...input(),now:new Date('bad')})).toEqual({ok:false,reason:'invalid_now'});
  });
  it('returns only the latest weekly slot rather than every missed reminder', () => {
    expect(planCatchUp({...input(), now:new Date('2026-11-30T01:00:00Z')})).toEqual({ok:true,slot:{type:'follow_up',scheduledDate:'2026-11-25'}});
  });
});
