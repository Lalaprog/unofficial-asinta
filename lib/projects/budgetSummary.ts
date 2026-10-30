/** Display calculations for recorded project costs versus an estimate. */
export function getBudgetSummary(estimate: number, recordedCosts: number) {
  const budget = Number.isFinite(estimate) ? Math.max(0, estimate) : 0;
  const costs = Number.isFinite(recordedCosts) ? recordedCosts : 0;
  if (budget === 0) {
    return { percent: null, barPercent: 0, remaining: null, over: null };
  }
  const percent = (costs / budget) * 100;
  return {
    percent,
    barPercent: Math.min(100, Math.max(0, percent)),
    remaining: Math.max(0, budget - costs),
    over: Math.max(0, costs - budget),
  };
}
