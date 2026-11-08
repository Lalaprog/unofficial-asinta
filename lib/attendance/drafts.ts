import { AttendanceStatus } from '@/types';

export interface AttendanceDraftEntry {
  status: AttendanceStatus | null;
  notes: string;
}

export type AttendanceDraftMap = Record<string, AttendanceDraftEntry>;

interface StoredAttendanceDraft {
  version: 1;
  savedAt: string;
  entries: AttendanceDraftMap;
}

const VALID_STATUSES: AttendanceStatus[] = ['present', 'half_day', 'absent', 'leave'];

/** Parse a browser-local attendance draft without trusting stored JSON. */
export function parseAttendanceDraft(raw: string | null): AttendanceDraftMap | null {
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const stored = parsed as Partial<StoredAttendanceDraft>;
  if (
    stored.version !== 1 ||
    !stored.entries ||
    typeof stored.entries !== 'object' ||
    Array.isArray(stored.entries)
  ) {
    return null;
  }

  const entries: AttendanceDraftMap = {};
  Object.entries(stored.entries).forEach(([workerId, value]) => {
    if (!workerId || !value || typeof value !== 'object') return;
    const candidate = value as Partial<AttendanceDraftEntry>;
    const validStatus =
      candidate.status === null || VALID_STATUSES.includes(candidate.status as AttendanceStatus);
    if (!validStatus || typeof candidate.notes !== 'string') return;

    entries[workerId] = {
      status: candidate.status as AttendanceStatus | null,
      notes: candidate.notes,
    };
  });

  return entries;
}

export function serializeAttendanceDraft(
  entries: AttendanceDraftMap,
  savedAt = new Date().toISOString()
): string {
  const payload: StoredAttendanceDraft = {
    version: 1,
    savedAt,
    entries,
  };
  return JSON.stringify(payload);
}

/**
 * For workflows that would rewrite the draft, require every stored entry to
 * parse. Otherwise preserve the original raw draft instead of dropping fields.
 */
export function parseCompleteAttendanceDraft(raw: string | null): AttendanceDraftMap | null {
  const parsed = parseAttendanceDraft(raw);
  if (!parsed || !raw) return null;
  try {
    const stored = JSON.parse(raw) as { entries: Record<string, unknown> };
    return Object.keys(stored.entries).length === Object.keys(parsed).length ? parsed : null;
  } catch {
    return null;
  }
}
