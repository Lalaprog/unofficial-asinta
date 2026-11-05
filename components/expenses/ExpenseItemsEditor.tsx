'use client';

import React from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { blankExpenseItem, itemSubtotal, prepareExpenseItems, type ItemInput } from '@/lib/expenses/items';
import { formatPeso } from '@/lib/email/format';

interface Props {
  rows: ItemInput[];
  onChange: (rows: ItemInput[]) => void;
  receiptTotal: string;
}

/** Editable breakdown only; these amounts are never written as extra expenses. */
export function ExpenseItemsEditor({ rows, onChange, receiptTotal }: Props) {
  const parsed = prepareExpenseItems(rows);
  const subtotal = !parsed.error ? itemSubtotal(parsed.items) : null;
  const total = Number(receiptTotal);
  const difference = subtotal !== null && receiptTotal.trim() && Number.isFinite(total)
    ? (Math.round(total * 100) - Math.round(subtotal * 100)) / 100 : null;
  const change = (index: number, patch: Partial<ItemInput>) => onChange(rows.map((row, i) => i === index ? { ...row, ...patch } : row));
  return <section className="space-y-3 rounded-2xl border border-surface-border bg-surface-inset/40 p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div><h3 className="text-sm font-bold text-navy">Receipt items</h3><p className="mt-0.5 text-xs text-ink-secondary">Optional breakdown. The receipt total remains the recorded expense.</p></div>
      <Button type="button" size="sm" variant="secondary" onClick={() => onChange([...rows, blankExpenseItem()])} disabled={rows.length >= 100} leftIcon={<Plus className="h-3.5 w-3.5" />}>Add item</Button>
    </div>
    {rows.map((row, index) => <div key={index} className="grid grid-cols-2 gap-2 rounded-xl border border-surface-border bg-white p-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
      <div className="col-span-2 sm:col-span-1"><Input label={`Item ${index + 1}`} value={row.name} maxLength={160} placeholder="e.g. Cement" onChange={event => change(index, {name:event.target.value})} /></div>
      <Input label={`Quantity ${index + 1}`} value={row.quantity} maxLength={60} placeholder="10 bags" onChange={event => change(index, {quantity:event.target.value})} />
      <Input label={`Item amount ${index + 1} (₱)`} type="number" min="0" step="0.01" value={row.amount} placeholder="0.00" onChange={event => change(index, {amount:event.target.value})} />
      <button type="button" onClick={() => onChange(rows.filter((_, i) => i !== index))} aria-label={`Remove item ${index + 1}`} className="col-span-2 inline-flex min-h-11 items-center justify-center gap-1 rounded-lg text-xs font-semibold text-status-danger hover:bg-status-danger-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand sm:col-span-1 sm:px-2"><Trash2 className="h-4 w-4" /><span className="sm:sr-only">Remove item</span></button>
    </div>)}
    {parsed.error && <p className="text-xs text-status-danger" role="status">{parsed.error}</p>}
    {subtotal !== null && <p className="text-xs text-ink-secondary">Items subtotal: <strong className="text-navy">{formatPeso(subtotal)}</strong>{difference !== null && Math.abs(difference) >= 0.01 ? <span className="ml-2 text-status-warning">Difference from receipt total: {formatPeso(difference)}. Check for delivery, tax or discounts.</span> : null}</p>}
    {parsed.items.length > 0 && subtotal === null && <p className="text-xs text-ink-secondary">Some item amounts are blank, so a subtotal is not shown.</p>}
  </section>;
}
