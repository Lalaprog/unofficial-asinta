import { evidenceAppearsIn, validateModelDraft, type DraftContext, type ExpenseDraft } from '@/lib/ai/draft';

/** A short *verbatim* excerpt, never a generated claim or a dump of OCR text. */
export function receiptDescription(candidate: unknown, text: string): string {
  if (typeof candidate !== 'string') return '';
  const value = candidate.trim();
  if (!value || value.length > 120 || /[\r\n]/.test(value) || !/[\p{L}]/u.test(value)) return '';
  if (/^(?:total|subtotal|amount|change|tax|vat|cash|date|receipt|invoice)\b/i.test(value)) return '';
  // Keep the actual OCR substring, rather than the model's spelling/casing.
  const index = text.indexOf(value);
  return index < 0 ? '' : text.slice(index, index + value.length);
}

/** The model's OCR is untrusted; every value still requires human comparison with the photo. */
export function buildReceiptDraft(fields: Record<string, unknown>, text: string, context: DraftContext, model: string): ExpenseDraft {
  const projectName = typeof fields.project_name === 'string' && evidenceAppearsIn(fields.project_name, text) ? fields.project_name : null;
  const vendor = typeof fields.vendor === 'string' && typeof fields.vendor_quote === 'string' &&
    evidenceAppearsIn(fields.vendor, fields.vendor_quote) && evidenceAppearsIn(fields.vendor_quote, text)
    ? fields.vendor : null;
  // Only accept an exact ISO date; ambiguous local formats need the user's input.
  const date = typeof fields.date === 'string' && typeof fields.date_quote === 'string' &&
    fields.date_quote.includes(fields.date) && evidenceAppearsIn(fields.date_quote, text) ? fields.date : null;
  // Do not turn a line-item price into a total just because the digits exist.
  // Require the cited number to appear on exactly one line explicitly labelled
  // as a total/amount due; the Founder still checks the photo for misreads.
  const quote = typeof fields.amount_quote === 'string' ? fields.amount_quote.trim() : '';
  const quotedLines = quote ? text.split(/\r?\n/).filter((line) => evidenceAppearsIn(quote, line)) : [];
  const hasTotal = quotedLines.length === 1 && /\b(?:total|amount\s+due|balance\s+due)\b/i.test(quotedLines[0]) && !/\b(?:sub\s*total)\b/i.test(quotedLines[0]);
  const draft = validateModelDraft({
    amount: hasTotal ? fields.amount : null, amount_quote: hasTotal ? fields.amount_quote : null,
    date, date_quote: date ? fields.date_quote : null,
    category: fields.category, project_name: projectName,
    vendor, bale: fields.bale === true,
  }, text, context, { model, verification: 'model-reported', requireQuotedAmount: true, allowAmountFallback: false, allowRelativeDate: false, allowVendorInference: false });
  const description = receiptDescription(fields.description, text);
  const unresolved = draft.unresolved.filter((item) => !item.startsWith('No date was stated'));
  const category = draft.categorySource === 'rules' && draft.category === 'other' ? null : draft.category;
  if (!category) unresolved.push('Choose an expense category.');
  if (!description) unresolved.push('No short item description could be verified — enter one yourself.');
  if (!draft.expenseDate) unresolved.push('The receipt date needs your input.');
  if (!vendor && !unresolved.some((item) => item.toLowerCase().includes('supplier'))) unresolved.push('The supplier could not be verified — enter it if needed.');
  return { ...draft, description, category, categorySource: category ? draft.categorySource : 'none', vendor: vendor ? draft.vendor : null, vendorToken: vendor ? draft.vendorToken : null, noteEvidence: null, unresolved };
}
