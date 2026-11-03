/**
 * The extraction engine behind Tracks E, B and D.
 *
 *   Track E  one messy line of text        → draft
 *   Track B  a photo of a receipt          → draft
 *
 * Text and receipt inputs use shared verification rules. The input differs; the rules do not:
 *
 *   1. The model EXTRACTS. It never decides and it never writes to the ledger —
 *      the Founder reviews every prefilled field and presses Save.
 *   2. NEVER INVENT A VALUE. Every extracted amount/date/vendor must be backed
 *      by a verbatim quote from the source text; the quote is checked against
 *      the source before the value is accepted. A missing amount stays empty.
 *      Amount hallucination is the one failure that corrupts a ledger.
 *   3. REAL DATABASE IDS ONLY. A project resolves to a real `project_id` or to
 *      null. A model returning a free-text project name that matches nothing is
 *      reported as unresolved, not inserted.
 *   4. Rules fill the gaps. With no API key, no network, or a retired model,
 *      the deterministic layer still drafts what the text itself states, and
 *      `degradedReason` says exactly why the model was not used.
 */

import { isExpenseCategory, type ExpenseCategory } from '@/lib/ai/categories';
import { categorizeWithRules } from '@/lib/ai/groq';
import { requestGroqJson } from '@/lib/ai/groqClient';
import { getTextModel } from '@/lib/ai/models';
import {
  decideCategory,
  resolveVendorToken,
  suggestFromVendorMemory,
  type CategorySource,
  type VendorMemoryRow,
  type VendorMemorySuggestion,
} from '@/lib/ai/vendorMemory';

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

export interface DraftProjectOption {
  id: string;
  name: string;
}

export interface DraftContext {
  projects: DraftProjectOption[];
  /** Existing vendor memory rows (may be empty — the draft still works). */
  vendorMemory: VendorMemoryRow[];
  /** Today's date in the firm's timezone (Asia/Manila), as YYYY-MM-DD. */
  todayISO: string;
}

export interface ExpenseDraft {
  /** The original text for typed drafts; receipt drafts use a short checked excerpt. */
  description: string;
  amount: number | null;
  expenseDate: string | null;
  projectId: string | null;
  projectLabel: string | null;
  category: ExpenseCategory | null;
  categorySource: CategorySource | 'none';
  vendor: string | null;
  vendorToken: string | null;
  /** A hint only. Advancing money stays a separate, explicitly confirmed step. */
  isBaleHint: boolean;
  /** Verbatim quote the draft is based on, when there is one. */
  noteEvidence: string | null;
  /** Human-readable justification for each prefilled field. */
  evidence: string[];
  /** Fields that remain empty because nothing could be verified. */
  unresolved: string[];
  source: 'llm' | 'rules' | 'none';
  degradedReason?: string;
  vendorMemory?: VendorMemorySuggestion;
  /** Receipt input: what the model read, for side-by-side review. */
  extractedText?: string;
  /**
   * How much of this draft is checkable:
   *   'text'    — every value was verified against the source text.
   *   'model-reported' — a photo draft: values are quoted from the
   *                      model's OWN transcription, which a human must check.
   * The UI must label the second case honestly.
   */
  verification: 'text' | 'model-reported';
}

/* -------------------------------------------------------------------------- */
/* Deterministic helpers (pure — unit-tested)                                  */
/* -------------------------------------------------------------------------- */

/** Lowercase, diacritics stripped, whitespace collapsed. */
export function normalizeForMatch(value: string | null | undefined): string {
  return (value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** True when `needle` appears verbatim (modulo case/diacritics/spacing) in `haystack`. */
export function evidenceAppearsIn(needle: string | null | undefined, haystack: string): boolean {
  const candidate = normalizeForMatch(needle);
  if (!candidate) return false;
  return normalizeForMatch(haystack).includes(candidate);
}

/**
 * Parses a peso amount out of a quoted piece of text.
 *
 * Handles what people actually type: "4800", "₱4,800", "4,800.00", "4.5k",
 * "15k pesos", "PHP 1200". Returns null when the quote contains no single
 * unambiguous number — "2 bags of 50kg cement for 4800" is ambiguous only if
 * more than one candidate of the same rank exists, which the caller handles.
 */
export function parseAmountFromText(raw: string | null | undefined): number | null {
  if (!raw) return null;

  const text = raw.replace(/[\u00a0\u202f]/g, ' ').toLowerCase();

  // hmm: unanchored "k" suffix must not match "kg".
  const kMatch = text.match(/(\d+(?:[.,]\d+)?)\s*k\b(?!g)/);
  if (kMatch) {
    const value = Number(kMatch[1].replace(',', '.'));
    if (Number.isFinite(value)) return Math.round(value * 1000);
  }

  const cleaned = text.replace(/(\d)[\s,](?=\d{3}\b)/g, '$1'); // 4 800 / 4,800 → 4800
  const numbers = cleaned.match(/\d+(?:\.\d+)?/g);
  if (!numbers || numbers.length === 0) return null;

  const parsed = numbers
    .map((token) => Number(token))
    .filter((value) => Number.isFinite(value) && value > 0);

  if (parsed.length === 0) return null;
  if (parsed.length === 1) return parsed[0];

  // Several numbers: only a currency marker disambiguates.
  const currencyMatch = cleaned.match(/(?:₱|php|pesos?)\s*(\d+(?:\.\d+)?)/);
  if (currencyMatch) return Number(currencyMatch[1]);

  return null;
}

export interface AmountVerification {
  amount: number | null;
  reason: string;
}

/**
 * Accepts a model-proposed amount ONLY when the quote it cites contains that
 * exact number and that quote really appears in the source.
 *
 * This is the anti-hallucination gate. A model that "helpfully" supplies a
 * plausible price with no basis in the text fails here and the field stays
 * empty — a blank field costs the Founder five seconds; a wrong amount costs
 * them a wrong set of books.
 */
export function verifyAmount(
  proposedAmount: unknown,
  quotedEvidence: unknown,
  sourceText: string
): AmountVerification {
  const quote = typeof quotedEvidence === 'string' ? quotedEvidence.trim() : '';

  if (!quote) {
    return { amount: null, reason: 'The draft gave no quote for the amount, so it was not filled in.' };
  }
  if (!evidenceAppearsIn(quote, sourceText)) {
    return {
      amount: null,
      reason: `The quoted amount (“${quote}”) does not appear in the description, so it was not filled in.`,
    };
  }

  const fromQuote = parseAmountFromText(quote);
  if (fromQuote === null) {
    // The quote may be a sentence ("₱4,800 para sa semento") — retry on the
    // whole source only when the quote itself yields nothing AND the proposed
    // number is present verbatim in the source.
    const proposed = Number(proposedAmount);
    if (Number.isFinite(proposed) && proposed > 0) {
      const normalizedSource = normalizeForMatch(sourceText).replace(/[\s,]/g, '');
      const forms = [
        String(proposed),
        proposed.toFixed(2),
        proposed.toFixed(2).replace(/\.00$/, ''),
      ].map((form) => form.replace(/[\s,]/g, ''));
      if (forms.some((form) => normalizedSource.includes(form))) {
        return { amount: proposed, reason: `Read “${quote}” as ${proposed}.` };
      }
    }
    return { amount: null, reason: 'No unambiguous amount could be read from the quoted text.' };
  }

  // If the model also proposed a number, it must agree with its own quote.
  const proposed = Number(proposedAmount);
  if (Number.isFinite(proposed) && proposed > 0 && Math.abs(proposed - fromQuote) > 0.01) {
    return {
      amount: null,
      reason: `The draft's amount (${proposed}) disagreed with its own quote (“${quote}” → ${fromQuote}), so it was not filled in.`,
    };
  }

  return { amount: fromQuote, reason: `Read “${quote}” as ${fromQuote}.` };
}

/** Relative-date vocabulary, checked against the text before it is trusted. */
const RELATIVE_DATE_TOKENS: Array<{ token: string; daysAgo: number }> = [
  { token: 'kahapon', daysAgo: 1 },
  { token: 'yesterday', daysAgo: 1 },
  { token: 'kanina', daysAgo: 0 },
  { token: 'ngayon', daysAgo: 0 },
  { token: 'today', daysAgo: 0 },
  { token: 'kagabi', daysAgo: 1 },
];

/** Shifts an ISO date by whole days, in UTC, without timezone surprises. */
export function shiftISODate(isoDate: string, days: number): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) return null;
  const base = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const shifted = new Date(base + days * 86_400_000);
  return shifted.toISOString().slice(0, 10);
}

export function isValidISODate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * Deterministic date extraction from Tagalog/English relative words. Kept in
 * code (not the prompt) because it is arithmetic, and because it must work with
 * the AI switched off entirely.
 */
export function extractRelativeDate(
  sourceText: string,
  todayISO: string
): { date: string; evidence: string } | null {
  const normalized = normalizeForMatch(sourceText);
  for (const { token, daysAgo } of RELATIVE_DATE_TOKENS) {
    if (!normalized.includes(token)) continue;
    const date = shiftISODate(todayISO, -daysAgo);
    if (date) return { date, evidence: token };
  }
  return null;
}

export interface DateVerification {
  date: string | null;
  evidence: string | null;
  reason: string;
}

/**
 * Accepts a model-proposed date only when its quote appears in the source and
 * the value is sane: not in the future (beyond tomorrow, for timezone slack),
 * and not before the app existed.
 */
export function verifyDate(
  proposedDate: unknown,
  quotedEvidence: unknown,
  sourceText: string,
  todayISO: string
): DateVerification {
  const quote = typeof quotedEvidence === 'string' ? quotedEvidence.trim() : '';
  if (!quote || !evidenceAppearsIn(quote, sourceText)) {
    return { date: null, evidence: null, reason: 'The draft cited no date that appears in the text.' };
  }
  if (!isValidISODate(proposedDate)) {
    return { date: null, evidence: quote, reason: 'The draft produced an unreadable date.' };
  }

  if (shiftISODate(todayISO, 1)! < proposedDate) {
    return { date: null, evidence: quote, reason: 'The draft produced a future date, which was rejected.' };
  }
  if (proposedDate < '2015-01-01') {
    return { date: null, evidence: quote, reason: 'The draft produced an implausibly old date, which was rejected.' };
  }

  return { date: proposedDate, evidence: quote, reason: `Read “${quote}” as ${proposedDate}.` };
}

export interface ProjectResolution {
  projectId: string | null;
  projectLabel: string | null;
  reason: string;
}

/**
 * Maps a draft onto a REAL project id, or nothing.
 *
 * Order: the model's id (verified against the loaded list — a hallucinated UUID
 * can never be inserted) → the model's name (exact normalised match) → a unique
 * name found literally in the text. Two or more candidate projects is reported
 * as ambiguous rather than resolved by guessing.
 */
export function resolveProject(
  proposedId: unknown,
  proposedName: unknown,
  sourceText: string,
  projects: DraftProjectOption[]
): ProjectResolution {
  const byId = projects.find((project) => project.id === proposedId);
  if (byId) {
    return {
      projectId: byId.id,
      projectLabel: byId.name,
      reason: `Matched project “${byId.name}”.`,
    };
  }

  const normalizedName = normalizeForMatch(typeof proposedName === 'string' ? proposedName : '');
  if (normalizedName) {
    const exact = projects.filter((project) => normalizeForMatch(project.name) === normalizedName);
    if (exact.length === 1) {
      return {
        projectId: exact[0].id,
        projectLabel: exact[0].name,
        reason: `Matched project name “${exact[0].name}”.`,
      };
    }
    if (exact.length > 1) {
      return {
        projectId: null,
        projectLabel: null,
        reason: `“${proposedName}” matches ${exact.length} projects — choose the project yourself.`,
      };
    }
  }

  // Last resort: exactly one project whose name literally appears in the text.
  const text = normalizeForMatch(sourceText);
  const contained = projects.filter((project) => {
    const name = normalizeForMatch(project.name);
    return name.length >= 6 && text.includes(name);
  });
  if (contained.length === 1) {
    return {
      projectId: contained[0].id,
      projectLabel: contained[0].name,
      reason: `The description names “${contained[0].name}”.`,
    };
  }
  if (contained.length > 1) {
    return {
      projectId: null,
      projectLabel: null,
      reason: `${contained.length} known projects are named in the description — choose the project yourself.`,
    };
  }

  return {
    projectId: null,
    projectLabel: null,
    reason: 'No known project was named — choose the project yourself.',
  };
}

export interface VendorVerification {
  vendor: string | null;
  vendorToken: string | null;
  reason: string;
}

/**
 * Accepts a vendor only when it traces back to the text (or to a known supplier
 * name). An invented supplier would pollute vendor memory with a key that never
 * appears again.
 */
export function verifyVendor(
  proposedVendor: unknown,
  sourceText: string,
  knownVendors: VendorMemoryRow[] = []
): VendorVerification {
  const candidate = typeof proposedVendor === 'string' ? proposedVendor.trim() : '';

  if (candidate && evidenceAppearsIn(candidate, sourceText)) {
    return { vendor: candidate, vendorToken: resolveVendorToken(candidate, sourceText), reason: `“${candidate}” is named in the text.` };
  }

  // A supplier the firm already knows, named in the text (even partially).
  const tokenFromText = resolveVendorToken(null, sourceText);
  if (tokenFromText) {
    const known = knownVendors.find((row) => row.vendor_token === tokenFromText);
    return {
      vendor: known?.vendor_label || tokenFromText,
      vendorToken: tokenFromText,
      reason: `“${known?.vendor_label || tokenFromText}” appears in the text.`,
    };
  }

  if (candidate) {
    return {
      vendor: null,
      vendorToken: null,
      reason: `“${candidate}” could not be found in the description, so no supplier was recorded.`,
    };
  }

  return { vendor: null, vendorToken: null, reason: 'No supplier was named in the description.' };
}

/**
 * Rule-only amount extraction for the degraded path.
 *
 * Deliberately conservative: one number, or one currency-marked number. Two
 * bare numbers ("12 bags … 4800") are reported as ambiguous rather than
 * guessed — "12" would otherwise become a ₱12 expense.
 */
export function extractAmountByRule(sourceText: string): AmountVerification {
  const currencyMatch = sourceText.match(/(?:₱|php|pesos?)\s*([\d][\d,.\s]*)/i);
  if (currencyMatch) {
    const value = parseAmountFromText(currencyMatch[0]);
    if (value !== null) return { amount: value, reason: `Read “${currencyMatch[0].trim()}” as ${value}.` };
  }

  const numbers = sourceText.match(/\d[\d,]*(?:\.\d+)?/g) ?? [];
  const distinct = Array.from(new Set(numbers));
  if (distinct.length === 0) {
    return { amount: null, reason: 'No amount was found in the description — enter it yourself.' };
  }
  if (distinct.length === 1) {
    const value = parseAmountFromText(distinct[0]);
    return value === null
      ? { amount: null, reason: 'No amount could be read from the description.' }
      : { amount: value, reason: `Read “${distinct[0]}” as ${value}.` };
  }

  // Several numbers and no currency marker: pick a large one only if it is the
  // sole large one (quantities like "12 bags" or "50kg" stay out of the way).
  const large = distinct.filter((token) => parseAmountFromText(token)! >= 100);
  if (large.length === 1) {
    const value = parseAmountFromText(large[0])!;
    return { amount: value, reason: `Read “${large[0]}” as ${value}.` };
  }

  return {
    amount: null,
    reason: `Several numbers appear (${distinct.slice(0, 4).join(', ')}) and none is clearly the amount — enter it yourself.`,
  };
}

/* -------------------------------------------------------------------------- */
/* Rule-only draft (works with AI fully off)                                   */
/* -------------------------------------------------------------------------- */

export function buildRuleDraft(
  sourceText: string,
  context: DraftContext,
  options: { verification?: ExpenseDraft['verification'] } = {}
): ExpenseDraft {
  const verification = options.verification ?? 'text';
  const rules = categorizeWithRules(sourceText);
  const amount = extractAmountByRule(sourceText);
  const relativeDate = extractRelativeDate(sourceText, context.todayISO);
  const project = resolveProject(null, null, sourceText, context.projects);
  const vendor = verifyVendor(null, sourceText, context.vendorMemory);

  const memoryRow = vendor.vendorToken
    ? context.vendorMemory.find((row) => row.vendor_token === vendor.vendorToken) ?? null
    : null;
  const decision = decideCategory({
    vendorToken: vendor.vendorToken ?? '',
    memory: memoryRow,
    llmCategory: null,
    rulesCategory: rules.category,
    rulesEvidence: rules.evidence,
  });

  const unresolved: string[] = [];
  if (amount.amount === null) unresolved.push(amount.reason);
  if (!project.projectId) unresolved.push(project.reason);
  if (!relativeDate) unresolved.push('No date was stated — the form default (today) is used until you change it.');
  if (!vendor.vendor) unresolved.push(vendor.reason);

  return {
    description: sourceText,
    amount: amount.amount,
    expenseDate: relativeDate?.date ?? null,
    projectId: project.projectId,
    projectLabel: project.projectLabel,
    category: decision.category,
    categorySource: decision.source,
    vendor: vendor.vendor,
    vendorToken: vendor.vendorToken,
    isBaleHint: rules.isBale,
    noteEvidence: relativeDate?.evidence ?? null,
    evidence: [
      `Built-in rules (no model was used): ${rules.reasoning}`,
      amount.reason,
      project.reason,
      vendor.reason,
      decision.explanation,
    ].filter(Boolean),
    unresolved,
    source: 'rules',
    vendorMemory: decision.vendorMemory,
    verification,
  };
}

/* -------------------------------------------------------------------------- */
/* LLM extraction                                                              */
/* -------------------------------------------------------------------------- */

export function buildDraftSystemPrompt(projects: DraftProjectOption[]): string {
  const projectList =
    projects.length > 0
      ? projects.map((project) => `- ${project.id} :: ${project.name}`).join('\n')
      : '(no projects are registered yet)';

  return `You extract a single construction expense from a Filipino (Taglish) site note for Asinta Architects.

The projects that exist in the database are:
${projectList}

Return ONLY this JSON object:
{
  "amount": <number or null>,
  "amount_quote": "<the exact substring of the note that states the amount, or null>",
  "date": "<YYYY-MM-DD or null>",
  "date_quote": "<the exact substring of the note that states the date, or null>",
  "category": "<materials|labor|equipment|permits|transportation|other or null>",
  "project_id": "<the id from the list above, or null>",
  "project_name": "<the project name from the list above, or null>",
  "vendor": "<the supplier or shop named in the note, or null>",
  "note_quote": "<a short exact substring of the note worth keeping, or null>",
  "bale": <true or false>
}

Hard rules:
- NEVER invent a value. If the note does not state an amount, amount is null and amount_quote is null.
- amount_quote and date_quote MUST be copied character-for-character from the note. Do not paraphrase, translate, or reformat them.
- amount must equal the number written in amount_quote. "4,800" → 4800. "4.5k" → 4500. "₱4,800.00" → 4800.
- project_id must be an id from the list above; if no project in the list is clearly meant, use null for both project fields.
- category must be one of the six listed values.
- bale is true only when the note describes a cash advance to a worker (bale, advance, ayuda, pamasahe).
- Tagalog time words: kahapon = yesterday, kanina/ngayon = today, kagabi = last night.
- Output JSON only. No prose, no markdown.`;
}

interface LlmDraftFields {
  amount?: unknown;
  amount_quote?: unknown;
  date?: unknown;
  date_quote?: unknown;
  category?: unknown;
  project_id?: unknown;
  project_name?: unknown;
  vendor?: unknown;
  note_quote?: unknown;
  bale?: unknown;
}

export interface ExtractDraftOptions {
  /** Force the rule layer; used by tests and when the caller wants no network. */
  disableModel?: boolean;
  /** Overrides the source text used for evidence checking (photo input). */
  verification?: ExpenseDraft['verification'];
  /** Extra instruction appended for vision calls (e.g. "read the receipt"). */
  extraSystemInstruction?: string;
}

/**
 * The one extraction entry point. Always resolves to a usable draft; when the
 * model is unavailable the deterministic layer fills in what it can and
 * `degradedReason` (or `source: 'rules'`) says so.
 */
export async function extractExpenseDraft(
  sourceText: string,
  context: DraftContext,
  options: ExtractDraftOptions = {}
): Promise<ExpenseDraft> {
  const trimmed = (sourceText || '').trim();
  if (!trimmed) {
    return {
      description: '',
      amount: null,
      expenseDate: null,
      projectId: null,
      projectLabel: null,
      category: null,
      categorySource: 'none',
      vendor: null,
      vendorToken: null,
      isBaleHint: false,
      noteEvidence: null,
      evidence: [],
      unresolved: ['Nothing was provided to read.'],
      source: 'none',
      verification: options.verification ?? 'text',
    };
  }

  if (options.disableModel) {
    return buildRuleDraft(trimmed, context, { verification: options.verification });
  }

  const system = [buildDraftSystemPrompt(context.projects), options.extraSystemInstruction]
    .filter(Boolean)
    .join('\n\n');

  const result = await requestGroqJson({
    model: getTextModel(),
    system,
    user: `Site note: ${trimmed}`,
  });

  if (!result.ok) {
    const fallback = buildRuleDraft(trimmed, context, { verification: options.verification });
    return {
      ...fallback,
      degradedReason: `${result.reason} The built-in rules drafted what the text states; check every field.`,
    };
  }

  return validateModelDraft(result.parsed as LlmDraftFields, trimmed, context, {
    model: result.model,
    verification: options.verification,
  });
}

/**
 * Turns raw model output into a draft, applying every verification gate.
 *
 * Exported because it is the part worth testing: the model is a string of
 * untrusted JSON, and this function is what stands between it and the ledger.
 */
export function validateModelDraft(
  raw: LlmDraftFields | null | undefined,
  sourceText: string,
  context: DraftContext,
  options: { model?: string; verification?: ExpenseDraft['verification']; requireQuotedAmount?: boolean; allowAmountFallback?: boolean; allowRelativeDate?: boolean; allowVendorInference?: boolean } = {}
): ExpenseDraft {
  const verification = options.verification ?? 'text';
  const rules = categorizeWithRules(sourceText);
  const fields = raw ?? {};

  const proposed = typeof fields.amount === 'number' || (typeof fields.amount === 'string' && fields.amount.trim() !== '') ? Number(fields.amount) : NaN;
  const modelAmount = options.requireQuotedAmount && !(Number.isFinite(proposed) && proposed > 0)
    ? { amount: null, reason: 'No readable total was identified — enter the amount yourself.' }
    : verifyAmount(fields.amount, fields.amount_quote, sourceText);
  /**
   * If the model produced no verified amount, fall back to the text itself.
   * The rule layer reads the digits that are actually written down (with the
   * matched substring as evidence), so this cannot introduce a value the note
   * does not contain — it only rescues a field the model failed to report.
   */
  const amount =
    modelAmount.amount !== null || options.allowAmountFallback === false ? modelAmount : extractAmountByRule(sourceText);
  const modelDate = verifyDate(fields.date, fields.date_quote, sourceText, context.todayISO);
  const relativeDate = options.allowRelativeDate === false ? null : extractRelativeDate(sourceText, context.todayISO);
  const project = resolveProject(fields.project_id, fields.project_name, sourceText, context.projects);
  const vendor = options.allowVendorInference === false && !fields.vendor
    ? { vendor: null, vendorToken: null, reason: 'No supplier could be verified — enter it if needed.' }
    : verifyVendor(fields.vendor, sourceText, context.vendorMemory);

  const llmCategory = isExpenseCategory(fields.category) ? (fields.category as ExpenseCategory) : null;

  const memoryRow = vendor.vendorToken
    ? context.vendorMemory.find((row) => row.vendor_token === vendor.vendorToken) ?? null
    : null;

  const decision = decideCategory({
    vendorToken: vendor.vendorToken ?? '',
    memory: memoryRow,
    llmCategory,
    rulesCategory: rules.category,
    rulesEvidence: rules.evidence,
  });

  // Relative Tagalog words are arithmetic, so they beat a date the model
  // derived from the same words. Otherwise the model's verified date is used.
  const expenseDate = relativeDate?.date ?? modelDate.date;
  const dateReason = relativeDate
    ? `“${relativeDate.evidence}” means ${relativeDate.date}.`
    : modelDate.reason;

  const evidence: string[] = [];
  evidence.push(amount.reason);
  if (modelAmount.amount === null && amount.amount !== null) {
    evidence.push(`The model's amount was not used (${modelAmount.reason}) — the text itself states it.`);
  }
  evidence.push(dateReason);
  evidence.push(project.reason);
  evidence.push(vendor.reason);
  evidence.push(decision.explanation);
  if (llmCategory && decision.source === 'vendor_memory') {
    evidence.push(`The model suggested “${llmCategory}”, but your history with this supplier was used instead.`);
  }
  if (!llmCategory && fields.category) {
    evidence.push(`The model returned an unsupported category (“${String(fields.category)}”), which was ignored.`);
  }

  const unresolved: string[] = [];
  if (amount.amount === null) unresolved.push(amount.reason);
  if (!project.projectId) unresolved.push(project.reason);
  if (!expenseDate) unresolved.push('No date was stated — the form default (today) is used until you change it.');
  if (!vendor.vendor) unresolved.push(vendor.reason);

  const noteQuote =
    typeof fields.note_quote === 'string' && evidenceAppearsIn(fields.note_quote, sourceText)
      ? fields.note_quote.trim()
      : null;

  return {
    description: sourceText,
    amount: amount.amount,
    expenseDate,
    projectId: project.projectId,
    projectLabel: project.projectLabel,
    category: decision.category,
    categorySource: decision.source,
    vendor: vendor.vendor,
    vendorToken: vendor.vendorToken,
    isBaleHint: Boolean(fields.bale) || rules.isBale,
    noteEvidence: noteQuote,
    evidence,
    unresolved,
    source: 'llm',
    vendorMemory: decision.vendorMemory ?? suggestFromVendorMemory(memoryRow) ?? undefined,
    verification,
  };
}

/**
 * Context helper shared by the routes: builds the draft context from the
 * ledger-shaped rows the API loaded. Kept here so text and photo callers
 * cannot build subtly different contexts.
 */
export function buildDraftContext(input: {
  projects: Array<{ id: string; name: string }>;
  vendorMemory?: VendorMemoryRow[];
  todayISO: string;
}): DraftContext {
  return {
    projects: input.projects.map((project) => ({ id: project.id, name: project.name })),
    vendorMemory: input.vendorMemory ?? [],
    todayISO: input.todayISO,
  };
}
