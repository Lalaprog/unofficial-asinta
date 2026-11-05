import type { ExpenseLineItem } from '@/types';

export interface ItemInput { name: string; quantity: string; amount: string }
export const blankExpenseItem = (): ItemInput => ({ name: '', quantity: '', amount: '' });

/** Convert user-reviewed rows without inventing missing quantities or prices. */
export function prepareExpenseItems(rows: ItemInput[]): { items: ExpenseLineItem[]; error?: string } {
  if (rows.length > 100) return { items: [], error: 'A receipt can have at most 100 items.' };
  const items: ExpenseLineItem[] = [];
  for (const row of rows) {
    const name = row.name.trim();
    const quantity = row.quantity.trim();
    const amountText = row.amount.trim();
    if (!name && !quantity && !amountText) continue;
    if (!name || name.length > 160) return { items: [], error: 'Give each item a name of up to 160 characters.' };
    if (quantity.length > 60) return { items: [], error: 'Keep each quantity under 60 characters.' };
    if (amountText && !/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(amountText)) {
      return { items: [], error: 'Item amounts must be valid pesos with at most two decimal places.' };
    }
    items.push({ name, quantity: quantity || null, amount: amountText ? Number(amountText) : null });
  }
  return { items };
}

/** Sum in centavos; null means at least one amount was not supplied. */
export function itemSubtotal(items: ExpenseLineItem[]): number | null {
  if (!items.length || items.some(item => item.amount == null)) return null;
  return items.reduce((sum, item) => sum + Math.round((item.amount ?? 0) * 100), 0) / 100;
}

export function itemInputs(items: ExpenseLineItem[] | null | undefined): ItemInput[] {
  return (items || []).map(item => ({ name: item.name, quantity: item.quantity || '', amount: item.amount == null ? '' : String(item.amount) }));
}
