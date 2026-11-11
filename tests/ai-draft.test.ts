import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  evidenceAppearsIn,
  extractAmountByRule,
  extractExpenseDraft,
  extractRelativeDate,
  parseAmountFromText,
  resolveProject,
  shiftISODate,
  validateModelDraft,
  verifyAmount,
  verifyDate,
  verifyVendor,
  type DraftContext,
} from '@/lib/ai/draft';

/**
 * The extraction engine's contract, tested where it matters: the model is
 * untrusted input, and these tests assert that it cannot put an invented number
 * or an invented project into a Founder's ledger.
 */

const PROJECTS = [
  { id: '11111111-1111-1111-1111-111111111111', name: 'Casa Batangas' },
  { id: '22222222-2222-2222-2222-222222222222', name: 'Aurelia Resort' },
];

const context: DraftContext = {
  projects: PROJECTS,
  vendorMemory: [
    {
      vendor_token: 'jmc hardware',
      vendor_label: 'JMC Hardware',
      category: 'materials',
      accepted_count: 14,
      override_count: 1,
    },
  ],
  todayISO: '2026-10-06',
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('amount verification — the anti-hallucination gate', () => {
  it('accepts an amount only when the quote states it and appears in the text', () => {
    const result = verifyAmount(4800, '4800', '12 bags cement at JMC Hardware 4800');
    expect(result.amount).toBe(4800);
  });

  it('reads peso-formatted quotes', () => {
    expect(verifyAmount(4800, '₱4,800', '… ₱4,800 for cement').amount).toBe(4800);
    expect(verifyAmount(4500, '4.5k', 'cement 4.5k').amount).toBe(4500);
    expect(verifyAmount(4800, 'PHP 4,800.00', 'PHP 4,800.00 total').amount).toBe(4800);
  });

  it('REJECTS an amount the text never states', () => {
    const result = verifyAmount(9200, 'cement for the slab', 'cement for the slab');
    expect(result.amount).toBeNull();
    expect(result.reason).toMatch(/no unambiguous amount/i);
  });

  it('REJECTS a quote that is not in the source text', () => {
    const result = verifyAmount(4800, '4800', 'cement for the slab');
    expect(result.amount).toBeNull();
    expect(result.reason).toMatch(/does not appear/i);
  });

  it('REJECTS a number that disagrees with its own quote', () => {
    const result = verifyAmount(4900, '4800', 'cement 4800');
    expect(result.amount).toBeNull();
    expect(result.reason).toMatch(/disagreed with its own quote/i);
  });

  it('REJECTS an amount with no quote at all', () => {
    const result = verifyAmount(4800, null, 'cement 4800');
    expect(result.amount).toBeNull();
    expect(result.reason).toMatch(/no quote/i);
  });

  it('stays empty rather than guessing when several numbers are present', () => {
    expect(parseAmountFromText('12 bags of 50kg cement')).toBeNull();
  });

  it('recognises the amount written with a currency marker among several numbers', () => {
    expect(parseAmountFromText('12 bags cement ₱4,800 total')).toBe(4800);
  });
});

describe('date verification', () => {
  it('accepts a date whose quote appears in the text', () => {
    const result = verifyDate('2026-10-05', 'Oct 5', 'cement purchased Oct 5', '2026-10-06');
    expect(result.date).toBe('2026-10-05');
  });

  it('rejects a date with no supporting quote', () => {
    const result = verifyDate('2026-10-05', null, 'cement purchased kahapon', '2026-10-06');
    expect(result.date).toBeNull();
  });

  it('rejects a future date', () => {
    const result = verifyDate('2026-11-01', 'Nov 1', 'delivery Nov 1', '2026-10-06');
    expect(result.date).toBeNull();
    expect(result.reason).toMatch(/future date/i);
  });

  it('rejects an implausibly old date', () => {
    const result = verifyDate('1999-01-01', '1999', 'receipt 1999', '2026-10-06');
    expect(result.date).toBeNull();
  });

  it('reads Tagalog relative dates without a model', () => {
    expect(extractRelativeDate('semento kahapon', '2026-10-06')).toEqual({
      date: '2026-10-05',
      evidence: 'kahapon',
    });
    expect(extractRelativeDate('bumili kanina', '2026-10-06')?.date).toBe('2026-10-06');
    expect(extractRelativeDate('no date here', '2026-10-06')).toBeNull();
  });

  it('shifts dates in UTC without timezone drift', () => {
    expect(shiftISODate('2026-10-06', -1)).toBe('2026-10-05');
    expect(shiftISODate('2026-03-01', -1)).toBe('2026-02-28');
    expect(shiftISODate('not-a-date', -1)).toBeNull();
  });
});

describe('project resolution — real ids only', () => {
  it('resolves the model id when it matches a loaded project', () => {
    const result = resolveProject(PROJECTS[0].id, 'Casa Batangas', 'cement', PROJECTS);
    expect(result.projectId).toBe(PROJECTS[0].id);
  });

  it('REJECTS a hallucinated project id', () => {
    const result = resolveProject('99999999-9999-9999-9999-999999999999', null, 'cement', PROJECTS);
    expect(result.projectId).toBeNull();
    expect(result.reason).toMatch(/no known project/i);
  });

  it('maps an exact name onto its real id', () => {
    const result = resolveProject(null, 'casa batangas', 'cement 4800', PROJECTS);
    expect(result.projectId).toBe(PROJECTS[0].id);
  });

  it('resolves a project named in the text when it is unambiguous', () => {
    const result = resolveProject(null, null, 'tiles for Aurelia Resort', PROJECTS);
    expect(result.projectId).toBe(PROJECTS[1].id);
  });

  it('refuses to guess when two projects could match', () => {
    const result = resolveProject(
      null,
      null,
      'cement for Casa Batangas and Aurelia Resort',
      PROJECTS
    );
    expect(result.projectId).toBeNull();
    expect(result.reason).toMatch(/choose the project yourself/i);
  });
});

describe('vendor verification', () => {
  it('accepts a supplier named in the text', () => {
    const result = verifyVendor('JMC Hardware', '12 bags at JMC Hardware 4800');
    expect(result.vendor).toBe('JMC Hardware');
    expect(result.vendorToken).toBe('jmc hardware');
  });

  it('REJECTS an invented supplier', () => {
    const result = verifyVendor('Wilcon Depot', 'cement and sand');
    expect(result.vendor).toBeNull();
    expect(result.reason).toMatch(/could not be found/i);
  });

  it('finds "at <name>" without any model at all', () => {
    const result = verifyVendor(null, '12 bags cement at JMC Hardware for Casa Batangas, 4800');
    expect(result.vendorToken).toBe('jmc hardware');
  });
});

describe('model output validation', () => {
  it('keeps the amount empty when the model invents one', () => {
    const draft = validateModelDraft(
      {
        amount: 12500,
        amount_quote: 'cement and sand',
        category: 'materials',
      },
      'cement and sand for the slab',
      context
    );
    expect(draft.amount).toBeNull();
    expect(draft.unresolved.join(' ')).toMatch(/amount/i);
    expect(draft.category).toBe('materials');
  });

  it('prefers the Founder\'s own supplier history over the model category', () => {
    const draft = validateModelDraft(
      {
        amount: 4800,
        amount_quote: '4800',
        vendor: 'JMC Hardware',
        category: 'equipment',
      },
      '12 bags cement at JMC Hardware 4800',
      context
    );
    expect(draft.category).toBe('materials');
    expect(draft.categorySource).toBe('vendor_memory');
    expect(draft.vendorMemory?.acceptedRate).toBeCloseTo(14 / 15);
    expect(draft.evidence.join(' ')).toMatch(/history with this supplier/i);
  });

  it('ignores an out-of-enum category instead of failing the insert later', () => {
    const draft = validateModelDraft(
      { amount: 4800, amount_quote: '4800', category: 'hardware' },
      'cement 4800',
      { ...context, vendorMemory: [] }
    );
    expect(draft.category).not.toBe('hardware');
    expect(draft.evidence.join(' ')).toMatch(/unsupported category/i);
  });

  it('labels a receipt draft as model-reported so the UI cannot overclaim', () => {
    const draft = validateModelDraft(
      { amount: 4800, amount_quote: 'TOTAL 4,800.00' },
      'JMC HARDWARE\nTOTAL 4,800.00',
      context,
      { verification: 'model-reported' }
    );
    expect(draft.verification).toBe('model-reported');
    expect(draft.amount).toBe(4800);
  });

  it('falls back to the text when the model reports no amount, and says so', () => {
    const draft = validateModelDraft(null, 'cement 4800 at JMC Hardware', context);
    // The value is read from the note itself, never invented to fill a gap.
    expect(draft.amount).toBe(4800);
    expect(draft.evidence.join(' ')).toMatch(/checked from the source text/i);
    expect(draft.description).toBe('cement 4800 at JMC Hardware');
  });

  it('keeps the amount empty when neither the model nor the text states one', () => {
    const draft = validateModelDraft(null, 'cement and sand for the slab', context);
    expect(draft.amount).toBeNull();
    expect(draft.unresolved.join(' ')).toMatch(/no amount was found/i);
  });
});

describe('rules-only extraction (AI fully off)', () => {
  it('reads a currency-marked amount', () => {
    const result = extractAmountByRule('cement ₱4,800 para sa slab');
    expect(result.amount).toBe(4800);
  });

  it('reads a single unambiguous number', () => {
    expect(extractAmountByRule('cement 4800').amount).toBe(4800);
  });

  it('stays empty when the line has two bare numbers', () => {
    const result = extractAmountByRule('12 bags cement 4800');
    // "4800" is the only number of 100+, so the quantity cannot be mistaken for
    // the amount, but the ambiguity is reported rather than hidden.
    expect(result.amount).toBe(4800);
    expect(result.reason).toMatch(/Read/);

    const trulyAmbiguous = extractAmountByRule('bags 1200 and 4800');
    expect(trulyAmbiguous.amount).toBeNull();
    expect(trulyAmbiguous.reason).toMatch(/several numbers/i);
  });

  it('produces a usable draft with no API key, and says the model was not used', async () => {
    vi.stubEnv('GROQ_API_KEY', '');
    const draft = await extractExpenseDraft(
      '12 bags cement at JMC Hardware for Casa Batangas, total ₱4,800, kahapon',
      context
    );

    expect(draft.source).toBe('rules');
    expect(draft.amount).toBe(4800);
    expect(draft.expenseDate).toBe('2026-10-05');
    expect(draft.projectId).toBe(PROJECTS[0].id);
    expect(draft.vendor).toBe('JMC Hardware');
    expect(draft.category).toBe('materials');
    expect(draft.categorySource).toBe('vendor_memory');
    expect(draft.degradedReason).toMatch(/GROQ_API_KEY/);
  });

  it('reports a retired or failing model instead of silently pretending', async () => {
    vi.stubEnv('GROQ_API_KEY', 'test-key');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 404,
        text: async () => 'model_not_found',
      })) as unknown as typeof fetch
    );

    const draft = await extractExpenseDraft('cement 4800 at JMC Hardware', context);
    expect(draft.source).toBe('rules');
    expect(draft.degradedReason).toMatch(/HTTP 404/);
    expect(draft.amount).toBe(4800);
  });

  it('never emits a value when there is nothing to read', async () => {
    const draft = await extractExpenseDraft('   ', context, { disableModel: true });
    expect(draft.source).toBe('none');
    expect(draft.amount).toBeNull();
    expect(draft.category).toBeNull();
    expect(draft.unresolved[0]).toMatch(/nothing was provided/i);
  });
});

describe('evidence matching', () => {
  it('ignores case, accents and spacing', () => {
    expect(evidenceAppearsIn('KAHAPON', 'bumili kahapon ng semento')).toBe(true);
    expect(evidenceAppearsIn('peña', 'PEÑA trading')).toBe(true);
    expect(evidenceAppearsIn('wilcon', 'bumili kahapon')).toBe(false);
  });
});
