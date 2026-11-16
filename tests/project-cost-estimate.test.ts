import { describe, expect, it } from 'vitest';
import { estimateProjectGross } from '@/lib/payroll/projectCostEstimate';

const work = (projectId:string, hours:bigint, date='2026-11-15') => ({projectId,date,hundredthsOfHour:hours});

describe('illustrative project gross allocation (no ledger writes)', () => {
  it('splits rounded weekly wages by hours, adds approved site allowances and preserves every centavo', () => {
    expect(estimateProjectGross({wageCents:98333n,worked:[work('a',800n),work('b',400n)],allowances:[{projectId:'b',date:'2026-11-15',amountCents:2505n}]})).toEqual([
      {projectId:'a',wageCents:65555n,allowanceCents:0n,grossCents:65555n},
      {projectId:'b',wageCents:32778n,allowanceCents:2505n,grossCents:35283n},
    ]);
  });
  it('breaks equal remainders by ID rather than input ordering', () => {
    const input={wageCents:2n,worked:[work('c',100n),work('a',100n),work('b',100n)],allowances:[]};
    const expected=[{projectId:'a',wageCents:1n,allowanceCents:0n,grossCents:1n},{projectId:'b',wageCents:1n,allowanceCents:0n,grossCents:1n},{projectId:'c',wageCents:0n,allowanceCents:0n,grossCents:0n}];
    expect(estimateProjectGross(input)).toEqual(expected);
    expect(estimateProjectGross({...input,worked:[...input.worked].reverse()})).toEqual(expected);
  });
  it('withholds allocation for missing or unmatched attendance and invalid amounts', () => {
    expect(estimateProjectGross({wageCents:100n,worked:[],allowances:[]})).toBeNull();
    expect(estimateProjectGross({wageCents:100n,worked:[work('a',0n)],allowances:[]})).toBeNull();
    expect(estimateProjectGross({wageCents:-1n,worked:[work('a',100n)],allowances:[]})).toBeNull();
    expect(estimateProjectGross({wageCents:100n,worked:[work('a',100n)],allowances:[{projectId:'b',date:'2026-11-15',amountCents:1n}]})).toBeNull();
    expect(estimateProjectGross({wageCents:100n,worked:[work('a',100n)],allowances:[{projectId:'a',date:'2026-11-16',amountCents:1n}]})).toBeNull();
  });
  it('preserves the rounded wage across many ratios and permits a zero-rate worker', () => {
    for (let cents=0n;cents<110n;cents++) for (let a=1n;a<5n;a++) for (let b=1n;b<5n;b++) {
      const rows=estimateProjectGross({wageCents:cents,worked:[work('a',a),work('b',b)],allowances:[]});
      expect(rows).not.toBeNull();
      expect(rows!.reduce((sum,r)=>sum+r.wageCents,0n)).toBe(cents);
      expect(rows!.reduce((sum,r)=>sum+r.grossCents,0n)).toBe(cents);
    }
  });
});
