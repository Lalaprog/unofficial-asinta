/** Calendar dates for site operations, independent of the device's time zone. */
const manilaDateFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Manila',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function manilaDateISO(instant: Date = new Date()): string {
  const parts = manilaDateFormatter.formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

/** Shift an ISO calendar date, rather than subtracting time in the device zone. */
export function shiftCalendarDate(dateISO: string, days: number): string {
  const [year, month, day] = dateISO.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}
