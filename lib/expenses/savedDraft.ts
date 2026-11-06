import type { ExpenseDraft } from '@/lib/ai/draft';
import type { ExpenseCategory } from '@/types';
import type { ItemInput } from '@/lib/expenses/items';
import type { AICategorizationResult } from '@/lib/ai/groq';

export interface SavedExpenseForm {
  project_id:string; description:string; details:string; amount:string;
  category:ExpenseCategory | ''; expense_date:string; notes:string; receipt_url:string | null; vendor:string;
}
export interface SavedDraftPayload {
  version:1; form:SavedExpenseForm; rows:ItemInput[]; receiptFileName:string | null;
  draft:ExpenseDraft | null; draftInputKind:'text' | 'receipt' | null;
  draftModel:string | null; draftExtractedText:string | null;
  aiResult:AICategorizationResult | null; aiAccepted:boolean; contextWarnings:string[];
}
export interface SavedDraftRow { owner_id:string; draft_id:string; revision:number; payload:SavedDraftPayload; updated_at:string }
const isObject = (x:unknown): x is Record<string, unknown> => Boolean(x && typeof x === 'object' && !Array.isArray(x));
const str = (x:unknown): x is string => typeof x === 'string' && x.length <= 12000;
const optStr = (x:unknown): x is string | null => x === null || str(x);
const strings = (x:unknown): x is string[] => Array.isArray(x) && x.length <= 100 && x.every(str);
const categories = ['','materials','labor','equipment','permits','transportation','other'];

/** Reject malformed or future-version data instead of silently overwriting it. */
export function parseSavedDraft(value:unknown): SavedDraftPayload | null {
  if (!isObject(value) || value.version !== 1 || !isObject(value.form) || !Array.isArray(value.rows) || value.rows.length > 100) return null;
  const f=value.form;
  if (![f.project_id,f.description,f.details,f.amount,f.category,f.expense_date,f.notes,f.vendor].every(str) || !optStr(f.receipt_url) || !categories.includes(f.category as string)) return null;
  if (!value.rows.every(row => isObject(row) && str(row.name) && str(row.quantity) && str(row.amount))) return null;
  if (!strings(value.contextWarnings)) return null;
  if (!optStr(value.receiptFileName) || !optStr(value.draftModel) || !optStr(value.draftExtractedText) || ![null,'receipt','text'].includes(value.draftInputKind as string | null) || typeof value.aiAccepted !== 'boolean') return null;
  if (value.draft !== null) {
    if (!isObject(value.draft) || !(value.draft.degradedReason === undefined || str(value.draft.degradedReason)) || !str(value.draft.description) || !(value.draft.amount === null || (typeof value.draft.amount === 'number' && Number.isFinite(value.draft.amount))) || !optStr(value.draft.expenseDate) || !optStr(value.draft.projectId) || !optStr(value.draft.projectLabel) || !(value.draft.category === null || categories.slice(1).includes(value.draft.category as string)) || !['none','vendor_memory','llm','rules'].includes(value.draft.categorySource as string) || !optStr(value.draft.vendor) || !optStr(value.draft.vendorToken) || typeof value.draft.isBaleHint !== 'boolean' || !optStr(value.draft.noteEvidence) || !strings(value.draft.evidence) || !strings(value.draft.unresolved) || !['llm','rules','none'].includes(value.draft.source as string) || !['text','model-reported'].includes(value.draft.verification as string)) return null;
  }
  if (value.aiResult !== null) {
    if (!isObject(value.aiResult) || !(value.aiResult.degradedReason === undefined || str(value.aiResult.degradedReason)) || !categories.slice(1).includes(value.aiResult.category as string) || typeof value.aiResult.isBale !== 'boolean' || !str(value.aiResult.reasoning) || !strings(value.aiResult.evidence) || !['llm','rules'].includes(value.aiResult.source as string)) return null;
  }
  return value as unknown as SavedDraftPayload;
}

/** JSONB key order may differ from JavaScript insertion order. */
export function stableDraftJson(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (isObject(item)) return Object.fromEntries(Object.keys(item).sort().map(key => [key, normalize(item[key])]));
    return item;
  };
  return JSON.stringify(normalize(value));
}
