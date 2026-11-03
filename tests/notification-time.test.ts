import { describe, expect, it } from 'vitest';
import { getNewestNotificationTimestamp, getNotificationTimestamp } from '@/lib/notifications/time';

const NOW = Date.parse('2026-11-03T12:00:00.000Z');
const atAge = (milliseconds: number) => new Date(NOW - milliseconds).toISOString();

describe('stored notification ages', () => {
  it.each([
    [0, 'just now'],
    [4_999, 'just now'],
    [5_000, '5 seconds ago'],
    [59_999, '59 seconds ago'],
    [60_000, '1 minute ago'],
    [119_999, '1 minute ago'],
    [120_000, '2 minutes ago'],
    [3_599_999, '59 minutes ago'],
    [3_600_000, '1 hour ago'],
    [7_200_000, '2 hours ago'],
    [86_399_999, '23 hours ago'],
    [86_400_000, '1 day ago'],
    [6 * 86_400_000, '6 days ago'],
  ])('formats an age of %ims as %s', (age, expected) => {
    expect(getNotificationTimestamp(atAge(age), NOW)?.relativeLabel).toBe(expected);
  });

  it('uses a Philippine calendar date after seven days, not an approximate week count', () => {
    const result = getNotificationTimestamp('2026-10-27T03:59:00.000Z', NOW);
    expect(result?.relativeLabel).toBe('Oct 27, 2026');
    expect(result?.absoluteLabel).toContain('11:59:00');
    expect(result?.absoluteLabel).toContain('Philippine time');
    expect(result?.dateTime).toBe('2026-10-27T03:59:00.000Z');
  });

  it('respects explicit offsets rather than treating local-looking database times as UTC', () => {
    const result = getNotificationTimestamp('2026-11-03T19:59:00+08:00', NOW);
    expect(result?.relativeLabel).toBe('1 minute ago');
    expect(result?.dateTime).toBe('2026-11-03T11:59:00.000Z');
  });

  it.each([undefined, null, '', '   ', 'not a timestamp'])('omits an absent or invalid event time: %s', (value) => {
    expect(getNotificationTimestamp(value, NOW)).toBeNull();
  });

  it('discloses clock skew instead of showing a negative age or pretending it is new', () => {
    const result = getNotificationTimestamp(atAge(-60_000), NOW);
    expect(result?.isAheadOfDevice).toBe(true);
    expect(result?.relativeLabel).toBe('time unavailable');
    expect(result?.dateTime).toBe('2026-11-03T12:01:00.000Z');
  });
});

describe('grouped notification timestamps', () => {
  it('chooses the newest stored event, independent of input order', () => {
    const oldest = atAge(7_200_000);
    const newest = atAge(30_000);
    expect(getNewestNotificationTimestamp([oldest, newest, atAge(60_000)])).toBe(newest);
    expect(getNewestNotificationTimestamp([newest, oldest])).toBe(newest);
  });

  it('ignores missing and invalid values without inventing a fallback', () => {
    const valid = atAge(60_000);
    expect(getNewestNotificationTimestamp([undefined, 'bad', null, valid])).toBe(valid);
    expect(getNewestNotificationTimestamp([undefined, 'bad', null])).toBeUndefined();
    expect(getNewestNotificationTimestamp([])).toBeUndefined();
  });

  it('does not hide a future source timestamp behind an older valid one', () => {
    const future = atAge(-60_000);
    expect(getNewestNotificationTimestamp([future, atAge(60_000)])).toBe(future);
  });
});
