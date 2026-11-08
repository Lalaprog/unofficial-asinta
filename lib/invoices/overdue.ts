/** Invoice due dates are calendar dates in Manila, not UTC instants. */
export function isInvoiceOverdue(invoice: { status: string; due_date: string }, today: string): boolean {
  if (invoice.status === 'paid' || invoice.status === 'cancelled') return false;
  return invoice.status === 'overdue' || (/^\d{4}-\d{2}-\d{2}$/.test(invoice.due_date) && invoice.due_date < today);
}
