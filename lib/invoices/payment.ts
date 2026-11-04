import type { Invoice, InvoiceStatus } from '@/types';

/** Stored before sending, so an uncertain response can retry the same operation. */
export interface InvoicePaymentAttempt {
  requestId: string;
  invoiceId: string;
  amount: string;
  expectedTotal: number;
  expectedPaid: number;
  expectedStatus: InvoiceStatus;
}

export type InvoicePaymentResult = {
  outcome: 'recorded' | 'already_recorded' | 'stale' | 'invalid_balance' | 'invalid' | 'not_found' | 'request_mismatch' | 'unconfirmed' | 'unavailable';
  invoice?: Invoice | null;
};

export const PAYMENT_STORAGE_PREFIX = 'asinta:invoice-payment:v1:';
const statuses = ['draft', 'pending', 'partially_paid', 'paid', 'overdue', 'cancelled'];
export const isPaymentAmount = (value: string) => /^(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/.test(value) && Number(value) > 0;

export const paymentStorageKey = (invoiceId: string, requestId: string) =>
  `${PAYMENT_STORAGE_PREFIX}${invoiceId}:${requestId}`;

export function readPaymentAttempt(storage: Storage, invoiceId: string, preferredRequestId?: string): InvoicePaymentAttempt | null {
  const prefix = `${PAYMENT_STORAGE_PREFIX}${invoiceId}:`;
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key?.startsWith(prefix)) keys.push(key);
  }
  keys.sort();
  if (preferredRequestId) {
    const preferred = paymentStorageKey(invoiceId, preferredRequestId);
    if (!keys.includes(preferred)) return null;
    keys.splice(keys.indexOf(preferred), 1);
    keys.unshift(preferred);
  }
  if (!keys.length) return null;
  const raw = storage.getItem(keys[0]);
  if (raw === null) throw new Error('The saved payment attempt changed.');
  const entry = JSON.parse(raw) as InvoicePaymentAttempt;
  if (!entry || typeof entry.requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(entry.requestId) ||
      entry.invoiceId !== invoiceId || keys[0] !== paymentStorageKey(invoiceId, entry.requestId) ||
      typeof entry.amount !== 'string' || !isPaymentAmount(entry.amount) ||
      typeof entry.expectedTotal !== 'number' || !Number.isFinite(entry.expectedTotal) ||
      typeof entry.expectedPaid !== 'number' || !Number.isFinite(entry.expectedPaid) || !statuses.includes(entry.expectedStatus)) {
    throw new Error('The saved payment attempt could not be read.');
  }
  return entry;
}

export function savePaymentAttempt(storage: Storage, attempt: InvoicePaymentAttempt): void {
  // Each request has its own key: one tab can never erase another tab's attempt.
  storage.setItem(paymentStorageKey(attempt.invoiceId, attempt.requestId), JSON.stringify(attempt));
  if (JSON.stringify(readPaymentAttempt(storage, attempt.invoiceId, attempt.requestId)) !== JSON.stringify(attempt)) {
    throw new Error('The payment attempt could not be saved.');
  }
}

export function clearPaymentAttempt(storage: Storage, attempt: InvoicePaymentAttempt): void {
  storage.removeItem(paymentStorageKey(attempt.invoiceId, attempt.requestId));
}
