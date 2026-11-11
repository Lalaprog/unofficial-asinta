import { shiftCalendarDate } from '@/lib/dates/manila';

export function firstOfMonth(date: string): string { return `${date.slice(0,7)}-01`; }
export function shiftMonth(month: string, delta: number): string {
  const [y,m] = month.split('-').map(Number);
  return new Date(Date.UTC(y,m-1+delta,1)).toISOString().slice(0,10);
}
export function monthDates(month: string): (string | null)[] {
  const start = new Date(`${month}T00:00:00Z`);
  const next = shiftMonth(month, 1);
  const result: (string|null)[] = Array(start.getUTCDay()).fill(null);
  for (let date = month; date < next; date = shiftCalendarDate(date,1)) result.push(date);
  return result;
}
export function weekDates(date: string): string[] {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  const start = shiftCalendarDate(date,-day);
  return Array.from({length:7},(_,i)=>shiftCalendarDate(start,i));
}
export function parseCalendarCounts(data: unknown, month: string): Map<string,number> {
  if (!Array.isArray(data) || data.length > 43) throw new Error('Invalid calendar response');
  const first=shiftCalendarDate(month,-6), last=shiftCalendarDate(shiftMonth(month,1),5);
  const result = new Map<string,number>();
  for (const row of data) {
    if (!row || typeof row.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.date) || new Date(`${row.date}T00:00:00Z`).toISOString().slice(0,10) !== row.date || row.date < first || row.date > last || result.has(row.date) || !Number.isSafeInteger(row.count) || row.count <= 0) throw new Error('Invalid calendar response');
    result.set(row.date,row.count);
  }
  return result;
}
