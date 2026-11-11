/** Conservative arithmetic for typed expense notes. Never treats a unit price as a total. */
export interface TextAmountResult {
  amount: number | null;
  reason: string;
}

const NUMBER = String.raw`(?<![\d.,])(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?(?:\s*[kK]\b)?(?!\d|[.,]\d)`;
const MONEY = String.raw`(?:₱\s*|PHP\s*|P\s*)?(${NUMBER})(?:\s*(?:pesos?|php))?`;
const QUANTITY = String.raw`(\d+(?:\.\d{1,3})?)`;
const WORDS = String.raw`[\p{L}][\p{L}\d.'-]*`;
// The price is unambiguously per unit when marked @, x, each, per unit, or bawat.
const LINE = new RegExp(
  String.raw`\b${QUANTITY}\s*(?:${WORDS}\s+){0,7}?(?:(?:@|×|\bx\b|\btig\b|\bbawat\b)\s*${MONEY}(?:\s*(?:each|ea\.?|per\s+${WORDS}|bawat\s+${WORDS}))?|(?:(?:at|for)\s+)?${MONEY}\s*(?:each|ea\.?|per\s+${WORDS}|bawat(?:\s+${WORDS})?))`,
  'giu'
);
const TOTAL = new RegExp(String.raw`\b(?:grand\s+total|amount\s+due|total(?:\s+amount)?|kabuuan)\s*(?:is|of|ay|:|=|-)?\s*${MONEY}`, 'giu');
const TOTAL_SUFFIX = new RegExp(String.raw`${MONEY}\s*(?:in\s+total|total|all\s+in|kabuuan)\b`, 'giu');
const NUMBERS = new RegExp(NUMBER, 'gi');
const QUANTITY_ONLY = /\b\d+(?:\.\d+)?\s*(?:bags?|sacks?|sako|pcs?|pieces?|piraso|units?|cans?|gallons?|liters?|litres?|litro|ltrs?|kg|kilos?|meters?|metres?|metro|rolls?|boxes?|pails?|buckets?|balde|sets?|sheets?|workers?|hours?|days?)\b/i;
const MAX_AMOUNT = 9999999999.99;

function numberValue(raw: string): number | null {
  const compact = raw.replace(/[,\s]/g, '').toLowerCase();
  const k = compact.endsWith('k');
  const value = Number(k ? compact.slice(0, -1) : compact) * (k ? 1000 : 1);
  return Number.isFinite(value) && value > 0 && value <= MAX_AMOUNT ? value : null;
}

function toCents(value: number): number | null {
  const cents = value * 100;
  const rounded = Math.round(cents);
  return Number.isSafeInteger(rounded) && Math.abs(cents - rounded) < 1e-7 ? rounded : null;
}

interface MatchSpan { start: number; end: number; value: number; quote: string }

function totalSpans(text: string): MatchSpan[] {
  const found: MatchSpan[] = [];
  for (const regex of [TOTAL, TOTAL_SUFFIX]) {
    regex.lastIndex = 0;
    for (const match of text.matchAll(regex)) {
      const start = match.index ?? 0;
      // A subtotal is not the final amount, nor is a numeric prefix in an identifier.
      if (/sub\s*$/i.test(text.slice(Math.max(0, start - 8), start))) continue;
      const value = numberValue(match[1]);
      if (value !== null) found.push({ start, end: start + match[0].length, value, quote: match[0].trim() });
    }
  }
  return found.filter((span, i, all) => !all.some((other, j) => j < i && span.start < other.end && span.end > other.start));
}

function lineSpans(text: string): { lines: MatchSpan[]; invalid: boolean } {
  const lines: MatchSpan[] = [];
  let invalid = false;
  LINE.lastIndex = 0;
  for (const match of text.matchAll(LINE)) {
    const quantity = Number(match[1]);
    const unitPrice = numberValue(match[2] || match[3]);
    const cents = unitPrice === null ? null : toCents(quantity * unitPrice);
    if (!Number.isFinite(quantity) || quantity <= 0 || cents === null || cents <= 0 || cents > MAX_AMOUNT * 100) {
      invalid = true;
      continue;
    }
    const start = match.index ?? 0;
    lines.push({ start, end: start + match[0].length, value: cents, quote: match[0].trim() });
  }
  return { lines, invalid };
}

function hasOtherNumbers(text: string, spans: MatchSpan[]): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (/\d/.test(text[index]) && !spans.some((span) => index >= span.start && index < span.end)) return true;
  }
  return false;
}

/**
 * Accept an explicit final total, or calculate only when all numeric values are
 * accounted for by clear quantity × unit-price expressions. Never guess when
 * there are extra numbers, conflicting totals, discounts, or incomplete items.
 */
export function analyzeTextExpenseAmount(text: string): TextAmountResult {
  const totals = totalSpans(text);
  const { lines, invalid } = lineSpans(text);
  if (totals.length > 1) {
    return { amount: null, reason: 'More than one total was stated — enter the final total yourself.' };
  }
  if (totals.length === 1) {
    const total = totals[0];
    if (/^\s*(?:each|ea\b|per\b|bawat\b)/i.test(text.slice(total.end))) {
      return { amount: null, reason: 'The stated amount appears to be per item rather than a final total — check it yourself.' };
    }
    const completeItems = lines.length > 0 && !invalid && !hasOtherNumbers(text, [...lines, total]);
    if (completeItems && lines.reduce((sum, line) => sum + line.value, 0) !== toCents(total.value)) {
      return { amount: null, reason: `The stated ${total.quote} differs from the item calculations — check for fees or discounts and enter the final total yourself.` };
    }
    return { amount: total.value, reason: `Stated total: “${total.quote}”. Review it before saving.` };
  }
  if (lines.length > 0 || invalid) {
    // An unpriced extra item or adjustment makes a line-item sum incomplete.
    // Prefer a blank over silently dropping delivery, discounts or another item.
    const possibleExtra = /\b(?:and|plus|pati|kasama)\s+(?!\d)[\p{L}]/iu.test(text)
      || /\b(?:discount|diskwento|tax|vat|shipping|freight|delivery\s+(?:fee|charge))\b/i.test(text);
    if (invalid || hasOtherNumbers(text, lines) || possibleExtra) {
      return { amount: null, reason: 'The item prices or other numbers are incomplete or ambiguous — enter the final total yourself.' };
    }
    const cents = lines.reduce((sum, line) => sum + line.value, 0);
    if (!Number.isSafeInteger(cents) || cents > MAX_AMOUNT * 100) {
      return { amount: null, reason: 'The calculated total is outside the supported range — enter it yourself.' };
    }
    return { amount: cents / 100, reason: `Calculated from ${lines.map((line) => `“${line.quote}”`).join(' + ')}. Check quantities, prices and any fees before saving.` };
  }
  NUMBERS.lastIndex = 0;
  const numbers = [...text.matchAll(NUMBERS)];
  if (numbers.length === 0) return { amount: null, reason: 'No amount was found in the description — enter it yourself.' };
  const loneNumber = numbers[0];
  const loneSpan = loneNumber ? [{ start: loneNumber.index ?? 0, end: (loneNumber.index ?? 0) + loneNumber[0].length, value: 0, quote: '' }] : [];
  if (numbers.length === 1 && !hasOtherNumbers(text, loneSpan) && !QUANTITY_ONLY.test(text) && !/@|\b(?:each|per|bawat|tig|unit\s+price|subtotal)\b/i.test(text)
    && !/\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d/i.test(text)) {
    const value = numberValue(numbers[0][0]);
    if (value !== null) return { amount: value, reason: `Read “${numbers[0][0]}” as the amount. Review it before saving.` };
  }
  return { amount: null, reason: 'The final total is unclear — specify a total or quantity and price each, or enter it yourself.' };
}

/** Block obvious unrelated requests and instruction overrides, not ordinary expense notes. */
export function isOffTaskExpenseInstruction(text: string): boolean {
  if (/\b(?:ignore|disregard|forget|override)\b.{0,50}\b(?:instructions?|rules?|prompt|previous|above|system)\b/i.test(text)) return true;
  if (/<\/?(?:system|assistant|developer)>|\[(?:system|assistant|developer)\]/i.test(text)) return true;
  if (/\b(?:solve|answer|explain|write|translate|summari[sz]e)\b/i.test(text) && /\b(?:question|equation|math|riddle|essay|poem|story|code|prompt)\b/i.test(text)) return true;
  const question = /^\s*(?:what(?:'s| is)|how (?:do|can|many|much)|who|why|solve|answer)\b/i.test(text);
  if (question && /\d\s*[+÷=]\s*\d/.test(text) && !/\b(?:expense|purchase|bought|paid|bill|receipt|bayad|gastos|binili)\b/i.test(text)) return true;
  if (question && !/\b(?:expense|cost|total|price|purchase|bought|paid|bill|receipt|bayad|gastos|binili|halaga)\b/i.test(text)) return true;
  return false;
}
