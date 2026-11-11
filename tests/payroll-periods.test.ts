import { describe, expect, it } from 'vitest';
import { supervisorPayrollPeriod, workerPayrollPeriod } from '@/lib/payroll/periods';

describe('agreed calendar payroll periods', () => {
  it.each([
    ['2026-11-15','2026-11-15','2026-11-21'],
    ['2026-11-21','2026-11-15','2026-11-21'],
    ['2026-12-31','2026-12-27','2027-01-02'],
  ])('worker week containing %s', (date, start, end) => {
    expect(workerPayrollPeriod(date)).toEqual({ start, end, plannedRelease: end });
  });
  it.each([
    ['2026-11-01','2026-11-01','2026-11-15'],
    ['2026-11-15','2026-11-01','2026-11-15'],
    ['2026-11-16','2026-11-16','2026-11-30'],
    ['2026-12-31','2026-12-16','2026-12-31'],
    ['2027-01-01','2027-01-01','2027-01-15'],
    ['2027-02-28','2027-02-16','2027-02-28'],
    ['2028-02-29','2028-02-16','2028-02-29'],
    ['2028-03-01','2028-03-01','2028-03-15'],
  ])('supervisor period containing %s', (date, start, end) => {
    expect(supervisorPayrollPeriod(date)).toEqual({ start, end, plannedRelease: end });
  });
  it.each(['2027-02-29', '2026-13-01', '2026-11-31', '2026-1-01', 'invalid'])('rejects invalid dates %s', date => {
    expect(() => workerPayrollPeriod(date)).toThrow();
    expect(() => supervisorPayrollPeriod(date)).toThrow();
  });
});
