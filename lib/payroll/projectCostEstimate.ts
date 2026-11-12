/** Read-only illustration. This is not a paid-payroll posting or an accounting ledger. */
export type CostEstimateInput = {
  wageCents: bigint;
  worked: { projectId: string; date: string; hundredthsOfHour: bigint }[];
  allowances: { projectId: string; date: string; amountCents: bigint }[];
};
export type ProjectCostEstimate = { projectId: string; wageCents: bigint; allowanceCents: bigint; grossCents: bigint };

/**
 * Allocate the already-rounded weekly wage by recorded hours, using largest
 * remainder and project ID for deterministic ties. Current OT has the same
 * hourly rate as regular time. Approved allowances follow their recorded site.
 * Returns null rather than inventing an attribution. No Bale is added or
 * subtracted: this illustrates gross earnings, not net cash or a ledger cost.
 */
export function estimateProjectGross(input: CostEstimateInput): ProjectCostEstimate[] | null {
  if (input.wageCents < 0n || !input.worked.length) return null;
  const sites = new Map<string, { hours: bigint; allowance: bigint }>();
  const days = new Set<string>();
  for (const work of input.worked) {
    if (!work.projectId || !work.date || work.hundredthsOfHour <= 0n) return null;
    const site = sites.get(work.projectId) ?? { hours: 0n, allowance: 0n };
    site.hours += work.hundredthsOfHour;
    sites.set(work.projectId, site);
    days.add(JSON.stringify([work.projectId, work.date]));
  }
  for (const allowance of input.allowances) {
    const site = sites.get(allowance.projectId);
    if (!site || allowance.amountCents <= 0n || !days.has(JSON.stringify([allowance.projectId, allowance.date]))) return null;
    site.allowance += allowance.amountCents;
  }
  const totalHours = [...sites.values()].reduce((sum, site) => sum + site.hours, 0n);
  if (totalHours <= 0n) return null;
  const allocated = [...sites].map(([projectId, site]) => {
    const numerator = input.wageCents * site.hours;
    return { projectId, allowanceCents: site.allowance, wageCents: numerator / totalHours, remainder: numerator % totalHours };
  });
  const assigned = allocated.reduce((sum, site) => sum + site.wageCents, 0n);
  const leftover = input.wageCents - assigned; // Always less than the number of sites.
  const byRemainder = [...allocated].sort((a,b) => a.remainder === b.remainder ? (a.projectId < b.projectId ? -1 : a.projectId > b.projectId ? 1 : 0) : a.remainder > b.remainder ? -1 : 1);
  for (let i = 0; i < Number(leftover); i++) byRemainder[i].wageCents += 1n;
  return allocated.sort((a,b) => a.projectId < b.projectId ? -1 : a.projectId > b.projectId ? 1 : 0)
    .map(({projectId, wageCents, allowanceCents}) => ({projectId, wageCents, allowanceCents, grossCents: wageCents + allowanceCents}));
}
