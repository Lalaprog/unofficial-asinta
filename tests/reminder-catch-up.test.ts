import { describe, expect, it } from 'vitest';
import { latestReminderSlot } from '@/lib/reminders/catchUp';
import { buildDispatchIdempotencyKey, isWithinSendingHours } from '@/lib/reminders/scheduler';

describe('future reminder catch-up planning (not connected to cron)',()=>{
 const enabled='2026-01-01', due='2026-01-20';
 it('selects the latest schedule slot, not a pile of missed messages',()=>{
  expect(latestReminderSlot(due,'2026-01-16',enabled)).toBeNull();
  expect(latestReminderSlot(due,'2026-01-18',enabled)).toEqual({type:'upcoming',scheduledDate:'2026-01-17'});
  expect(latestReminderSlot(due,'2026-01-22',enabled)).toEqual({type:'due_today',scheduledDate:'2026-01-20'});
  expect(latestReminderSlot(due,'2026-01-28',enabled)).toEqual({type:'overdue',scheduledDate:'2026-01-23'});
  expect(latestReminderSlot(due,'2026-02-14',enabled)).toEqual({type:'follow_up',scheduledDate:'2026-02-13'});
 });
 it('preserves a Sunday slot for Monday and uses the same key on later attempts',()=>{
  const sunday='2026-11-01', monday='2026-11-02';const first=latestReminderSlot(sunday,sunday,'2026-10-01')!;const second=latestReminderSlot(sunday,monday,'2026-10-01')!;
  expect(first).toEqual({type:'due_today',scheduledDate:sunday});expect(second).toEqual(first);
  expect(buildDispatchIdempotencyKey('invoice','sms',first.type,first.scheduledDate)).toBe(buildDispatchIdempotencyKey('invoice','sms',second.type,second.scheduledDate));
  expect(isWithinSendingHours(new Date('2026-11-01T02:00:00Z'))).toBe(false);expect(isWithinSendingHours(new Date('2026-11-02T02:00:00Z'))).toBe(true);
 });
 it('does not backfill slots from before a channel was enabled',()=>{
  expect(latestReminderSlot(due,'2026-01-22','2026-01-21')).toBeNull();
  expect(latestReminderSlot(due,'2026-01-23','2026-01-21')).toEqual({type:'overdue',scheduledDate:'2026-01-23'});
  expect(latestReminderSlot(due,'2026-01-22','2026-01-23')).toBeNull();
 });
 it('rejects malformed and impossible dates rather than rolling them over',()=>{
  expect(latestReminderSlot('2026-02-30','2026-03-01',enabled)).toBeNull();expect(latestReminderSlot(due,'not a date',enabled)).toBeNull();expect(latestReminderSlot(due,'2026-02-13','1899-01-01')).toBeNull();
  expect(latestReminderSlot('2024-02-29','2024-03-03','2024-01-01')).toEqual({type:'overdue',scheduledDate:'2024-03-03'});
 });
});
