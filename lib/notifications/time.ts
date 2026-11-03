/** Ages for stored notification events, never for a derived task's render time. */
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const absoluteFormatter = new Intl.DateTimeFormat('en-PH', {
  timeZone: 'Asia/Manila',
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
  timeZoneName: 'short',
});

const olderDateFormatter = new Intl.DateTimeFormat('en-PH', {
  timeZone: 'Asia/Manila',
  year: 'numeric',
  month: 'short',
  day: 'numeric',
});

export interface NotificationTimestamp {
  /** Normalized source timestamp, suitable for <time dateTime>. */
  dateTime: string;
  relativeLabel: string;
  absoluteLabel: string;
  /** A device clock behind the stored event must not produce a negative age. */
  isAheadOfDevice: boolean;
}

function parseTimestamp(value: string | null | undefined): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Missing/invalid event times return null so callers can omit the timestamp.
 * Explicit offsets are respected; Philippine time is used only for display.
 */
export function getNotificationTimestamp(
  value: string | null | undefined,
  now: number
): NotificationTimestamp | null {
  const occurredAt = parseTimestamp(value);
  if (occurredAt === null || !Number.isFinite(now)) return null;

  const date = new Date(occurredAt);
  const elapsed = now - occurredAt;
  let relativeLabel: string;

  if (elapsed < 0) {
    relativeLabel = 'time unavailable';
  } else if (elapsed < 5 * SECOND) {
    relativeLabel = 'just now';
  } else if (elapsed < MINUTE) {
    const seconds = Math.floor(elapsed / SECOND);
    relativeLabel = `${seconds} seconds ago`;
  } else if (elapsed < HOUR) {
    const minutes = Math.floor(elapsed / MINUTE);
    relativeLabel = `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`;
  } else if (elapsed < DAY) {
    const hours = Math.floor(elapsed / HOUR);
    relativeLabel = `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  } else if (elapsed < 7 * DAY) {
    const days = Math.floor(elapsed / DAY);
    relativeLabel = `${days} ${days === 1 ? 'day' : 'days'} ago`;
  } else {
    relativeLabel = olderDateFormatter.format(date);
  }

  return {
    dateTime: date.toISOString(),
    relativeLabel,
    absoluteLabel: `${absoluteFormatter.format(date)} (Philippine time)`,
    isAheadOfDevice: elapsed < 0,
  };
}

/** Preserve the newest real event time, including clock skew for disclosure. */
export function getNewestNotificationTimestamp(
  values: Array<string | null | undefined>
): string | undefined {
  let newest: string | undefined;
  let newestTime = -Infinity;
  for (const value of values) {
    const parsed = parseTimestamp(value);
    if (parsed !== null && parsed > newestTime) {
      newest = value ?? undefined;
      newestTime = parsed;
    }
  }
  return newest;
}
