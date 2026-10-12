import { describe, expect, it } from 'vitest';
import {
  parseAttendanceDraft,
  serializeAttendanceDraft,
  type AttendanceDraftMap,
} from '@/lib/attendance/drafts';

describe('browser-local attendance drafts', () => {
  it('round-trips statuses and notes without changing attendance semantics', () => {
    const entries: AttendanceDraftMap = {
      workerA: { status: 'present', notes: 'Concrete pour, north wing' },
      workerB: { status: 'half_day', notes: '' },
      workerC: { status: null, notes: 'Needs follow-up' },
    };

    const raw = serializeAttendanceDraft(entries, '2026-10-12T08:00:00.000Z');

    expect(parseAttendanceDraft(raw)).toEqual(entries);
  });

  it('ignores malformed worker entries and rejects unsupported versions', () => {
    const raw = JSON.stringify({
      version: 1,
      savedAt: '2026-10-12T08:00:00.000Z',
      entries: {
        workerA: { status: 'absent', notes: '' },
        workerB: { status: 'pending', notes: 'Invalid status' },
        workerC: { status: 'leave', notes: 17 },
      },
    });

    expect(parseAttendanceDraft(raw)).toEqual({ workerA: { status: 'absent', notes: '' } });
    expect(parseAttendanceDraft(JSON.stringify({ version: 2, entries: {} }))).toBeNull();
  });

  it('returns null for missing or invalid JSON', () => {
    expect(parseAttendanceDraft(null)).toBeNull();
    expect(parseAttendanceDraft('{bad json')).toBeNull();
  });
});
