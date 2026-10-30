import { describe, expect, it } from 'vitest';
import { getBudgetSummary } from '@/lib/projects/budgetSummary';

describe('project budget presentation', () => {
  it('does not invent a utilization percentage when no estimate exists', () => {
    expect(getBudgetSummary(0, 2000)).toEqual({ percent: null, barPercent: 0, remaining: null, over: null });
    expect(getBudgetSummary(-1, 2000).percent).toBeNull();
  });

  it('shows remaining and over-estimate amounts without hiding overspend', () => {
    expect(getBudgetSummary(1000, 350)).toEqual({ percent: 35, barPercent: 35, remaining: 650, over: 0 });
    expect(getBudgetSummary(1000, 1250)).toEqual({ percent: 125, barPercent: 100, remaining: 0, over: 250 });
    expect(getBudgetSummary(1000, 1000)).toEqual({ percent: 100, barPercent: 100, remaining: 0, over: 0 });
  });
});
