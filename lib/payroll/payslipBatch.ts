import type { PayrollStatus } from '@/types';

export interface BatchPayslip {
  id: string;
  worker_id: string;
  worker_name: string;
  worker_position: string;
  period_start: string;
  period_end: string;
  status: PayrollStatus;
  days_worked: number | null;
  hours_worked: number | null;
  gross_pay: number;
  bale_deduction: number;
  other_deductions: number;
  net_pay: number;
}

/** Validate every server row; never print a partial or cross-period response. */
export function parsePayslipBatch(value: unknown, start: string, end: string): BatchPayslip[] {
  if (!Array.isArray(value) || value.length > 2000) throw new Error('Invalid payslip batch.');
  const ids = new Set<string>();
  const workers = new Set<string>();
  return value.map((item): BatchPayslip => {
    if (!item || typeof item !== 'object') throw new Error('Invalid payslip batch.');
    const row = item as Record<string, unknown>;
    if (typeof row.id !== 'string' || !row.id || typeof row.worker_id !== 'string' || !row.worker_id || ids.has(row.id) || workers.has(row.worker_id)
      || typeof row.worker_name !== 'string' || !row.worker_name.trim() || typeof row.worker_position !== 'string'
      || row.period_start !== start || row.period_end !== end
      || !['draft','reviewed','approved','paid'].includes(String(row.status))
) throw new Error('Invalid payslip batch.');
    const number = (key: string, optional = false): number | null => {
      const input = row[key];
      if (optional && input == null) return null;
      if (input === null || input === '' || input === undefined || !Number.isFinite(Number(input)) || Number(input) < 0) throw new Error('Invalid payslip amount.');
      return Number(input);
    };
    ids.add(row.id); workers.add(row.worker_id);
    return {
      id: row.id, worker_id: row.worker_id, worker_name: row.worker_name, worker_position: row.worker_position,
      period_start: start, period_end: end, status: row.status as PayrollStatus,
      days_worked: number('days_worked', true), hours_worked: number('hours_worked', true),
      gross_pay: number('gross_pay')!, bale_deduction: number('bale_deduction')!,
      other_deductions: number('other_deductions')!, net_pay: number('net_pay')!,
    };
  });
}

export function chunkPayslips<T>(items: T[], perPage = 9): T[][] {
  if (!Number.isInteger(perPage) || perPage < 1) throw new Error('Invalid page size.');
  const pages: T[][] = [];
  for (let i = 0; i < items.length; i += perPage) pages.push(items.slice(i, i + perPage));
  return pages;
}
