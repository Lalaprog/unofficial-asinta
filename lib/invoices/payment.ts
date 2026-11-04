import type { Invoice } from '@/types';

export type InvoicePaymentResult = 'recorded' | 'audit_unconfirmed' | 'stale' | 'unconfirmed' | 'invalid';

/** Calculate from the invoice the user actually saw, not a newer store value. */
export function prepareInvoicePayment(invoice: Invoice, amount: string): { amountPaid: number; status: Invoice['status'] } | null {
  if (!/^\d{1,12}(?:\.\d{1,2})?$/.test(amount)) return null;
  const [whole, decimals = ''] = amount.split('.');
  const amountCents = Number(whole) * 100 + Number(decimals.padEnd(2, '0'));
  const total = Number(invoice.amount);
  const paid = Number(invoice.amount_paid);
  if (!Number.isFinite(total) || !Number.isFinite(paid) || total <= 0 || paid < 0 || invoice.status === 'paid') return null;
  const totalCents = Math.round(total * 100);
  const paidCents = Math.round(paid * 100);
  if (!Number.isSafeInteger(amountCents) || !Number.isSafeInteger(totalCents) || !Number.isSafeInteger(paidCents) || amountCents <= 0 || paidCents >= totalCents || amountCents > totalCents - paidCents) return null;
  const newPaid = paidCents + amountCents;
  return { amountPaid: newPaid / 100, status: newPaid === totalCents ? 'paid' : 'partially_paid' };
}
