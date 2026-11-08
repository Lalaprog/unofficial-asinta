import { describe, expect, it } from 'vitest';
import { manilaDateISO } from '@/lib/dates/manila';
import { isInvoiceOverdue } from '@/lib/invoices/overdue';

describe('invoice overdue calendar date', () => {
  it('does not classify a due-today invoice as overdue after UTC midnight', () => {
    const today = manilaDateISO(new Date('2026-10-15T02:00:00Z'));
    expect(today).toBe('2026-10-15');
    expect(isInvoiceOverdue({ status: 'sent', due_date: '2026-10-15' }, today)).toBe(false);
    expect(isInvoiceOverdue({ status: 'sent', due_date: '2026-10-14' }, today)).toBe(true);
    expect(isInvoiceOverdue({ status: 'sent', due_date: '2026-10-16' }, today)).toBe(false);
  });
  it('changes at Manila midnight, not the device or UTC midnight', () => {
    const invoice = { status: 'sent', due_date: '2026-10-15' };
    expect(isInvoiceOverdue(invoice, manilaDateISO(new Date('2026-10-15T15:59:59Z')))).toBe(false);
    expect(isInvoiceOverdue(invoice, manilaDateISO(new Date('2026-10-15T16:00:00Z')))).toBe(true);
  });
  it('preserves explicit overdue status, excludes paid/cancelled, and ignores invalid dates', () => {
    const today = '2026-10-15';
    expect(isInvoiceOverdue({ status: 'overdue', due_date: '2026-10-15' }, today)).toBe(true);
    expect(isInvoiceOverdue({ status: 'paid', due_date: '2026-10-01' }, today)).toBe(false);
    expect(isInvoiceOverdue({ status: 'cancelled', due_date: '2026-10-01' }, today)).toBe(false);
    expect(isInvoiceOverdue({ status: 'sent', due_date: '' }, today)).toBe(false);
  });
});
