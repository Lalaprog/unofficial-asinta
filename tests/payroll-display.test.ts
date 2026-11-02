import { describe, expect, it } from 'vitest';
import { formatRecordedWork } from '@/lib/payroll/display';

describe('payroll attendance display', () => {
  it('reports missing or invalid values without inventing days or hours', () => {
    expect(formatRecordedWork(undefined, 'days')).toBe('Not recorded');
    expect(formatRecordedWork(null, 'hours')).toBe('Not recorded');
    expect(formatRecordedWork(Number.NaN, 'hours')).toBe('Not recorded');
  });

  it('preserves recorded zero and fractional values', () => {
    expect(formatRecordedWork(0, 'days')).toBe('0 days');
    expect(formatRecordedWork(0.5, 'days')).toBe('0.5 days');
    expect(formatRecordedWork(4, 'hours')).toBe('4 hours');
  });
});
