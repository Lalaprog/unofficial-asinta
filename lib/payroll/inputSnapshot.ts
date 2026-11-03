import type { Advance, Attendance, Payroll, Project, User, Worker } from '@/types';

/** All arrays are produced by a single server-side read snapshot; never fall back to the shared store. */
export interface PayrollInputSnapshot {
  attendance: Attendance[];
  workers: Worker[];
  projects: Project[];
  users: User[];
  advances: Advance[];
  payroll: Payroll[];
}

export function parsePayrollInputSnapshot(value: unknown): PayrollInputSnapshot {
  if (!value || typeof value !== 'object') throw new Error('Invalid payroll input snapshot.');
  const data = value as Partial<PayrollInputSnapshot>;
  if (!Array.isArray(data.attendance) || !Array.isArray(data.workers) || !Array.isArray(data.projects) || !Array.isArray(data.users) || !Array.isArray(data.advances) || !Array.isArray(data.payroll)) throw new Error('Invalid payroll input snapshot.');
  const validNumber = (n: unknown) => n !== null && n !== '' && n !== undefined && Number.isFinite(Number(n));
  if (data.attendance.some(a => !a || typeof a.id !== 'string' || typeof a.worker_id !== 'string' || typeof a.project_id !== 'string' || typeof a.date !== 'string' || !['present','half_day','absent','leave'].includes(a.status) || !validNumber(a.hours_worked) || typeof a.is_founder_override !== 'boolean')) throw new Error('Invalid attendance in payroll snapshot.');
  if (data.workers.some(w => !w || typeof w.id !== 'string' || typeof w.name !== 'string' || typeof w.position !== 'string' || typeof w.active !== 'boolean' || !validNumber(w.pay_rate) || !['daily','hourly'].includes(w.pay_rate_type))) throw new Error('Invalid worker in payroll snapshot.');
  if (data.projects.some(p => !p || typeof p.id !== 'string' || typeof p.name !== 'string')) throw new Error('Invalid project in payroll snapshot.');
  if (data.users.some(u => !u || typeof u.id !== 'string' || typeof u.name !== 'string' || u.role !== 'supervisor')) throw new Error('Invalid supervisor in payroll snapshot.');
  if (data.advances.some(a => !a || typeof a.id !== 'string' || typeof a.worker_id !== 'string' || typeof a.project_id !== 'string' || !validNumber(a.amount) || !validNumber(a.amount_deducted) || !['active','partially_deducted'].includes(a.status))) throw new Error('Invalid advance in payroll snapshot.');
  if (data.payroll.some(p => !p || typeof p.id !== 'string' || typeof p.worker_id !== 'string' || typeof p.period_start !== 'string' || typeof p.period_end !== 'string' || !validNumber(p.other_deductions) || !['draft','reviewed','approved','paid'].includes(p.status))) throw new Error('Invalid voucher in payroll snapshot.');
  // Defend against accidental duplicate vouchers even if a server function is older or misconfigured.
  const keys = new Set<string>();
  for (const pay of data.payroll) {
    const key = `${pay.worker_id}:${pay.period_start}:${pay.period_end}`;
    if (keys.has(key)) throw new Error('Duplicate vouchers already exist for a worker and period. Review them before generating payroll.');
    keys.add(key);
  }
  return data as PayrollInputSnapshot;
}
