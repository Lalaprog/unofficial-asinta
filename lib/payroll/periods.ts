/** Calendar periods only. These helpers do not generate or change payroll. */
export interface PayrollPeriod {
  start: string;
  end: string;
  plannedRelease: string;
}

function parseDate(dateISO: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) throw new Error('Expected an ISO calendar date');
  const date = new Date(`${dateISO}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== dateISO) throw new Error('Invalid calendar date');
  return date;
}

function iso(date: Date): string { return date.toISOString().slice(0, 10); }

/** The worker week runs Sunday–Saturday, independent of device time zone. */
export function workerPayrollPeriod(dateISO: string): PayrollPeriod {
  const date = parseDate(dateISO);
  const start = new Date(date);
  start.setUTCDate(start.getUTCDate() - start.getUTCDay());
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);
  return { start: iso(start), end: iso(end), plannedRelease: iso(end) };
}

/** Supervisor periods are 1–15 and 16–month-end, not rolling 15-day blocks. */
export function supervisorPayrollPeriod(dateISO: string): PayrollPeriod {
  const date = parseDate(dateISO);
  const firstHalf = date.getUTCDate() <= 15;
  const start = new Date(date);
  start.setUTCDate(firstHalf ? 1 : 16);
  const end = new Date(date);
  if (firstHalf) end.setUTCDate(15);
  else end.setUTCMonth(end.getUTCMonth() + 1, 0);
  return { start: iso(start), end: iso(end), plannedRelease: iso(end) };
}
