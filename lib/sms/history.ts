import type { SMSLog } from '@/types';

export type SMSHistoryItem = SMSLog & { invoice_number: string | null; simulated: boolean };
export type SMSHistoryFilters = { search: string; status: string; from: string; to: string };
export type SMSHistoryPage = { items: SMSHistoryItem[]; has_more: boolean };
export type SMSHistorySummary = { total: number; delivered: number };

export function parseSMSHistoryPage(data: unknown): SMSHistoryPage {
  if (!data || typeof data !== 'object') throw new Error('Invalid SMS history response');
  const page = data as SMSHistoryPage;
  if (!Array.isArray(page.items) || typeof page.has_more !== 'boolean' || (page.has_more && !page.items.length) || page.items.length > 25) throw new Error('Invalid SMS history response');
  for (const item of page.items) {
    if (!item || typeof item.id !== 'string' || typeof item.sent_at !== 'string' || !Number.isFinite(Date.parse(item.sent_at)) || typeof item.recipient !== 'string' || typeof item.phone !== 'string' || typeof item.message !== 'string' || typeof item.simulated !== 'boolean' || !['pending','sent','delivered','failed'].includes(item.status) || !(item.invoice_number === null || typeof item.invoice_number === 'string')) throw new Error('Invalid SMS history item');
  }
  return page;
}
export function parseSMSHistorySummary(data: unknown): SMSHistorySummary {
  if (!data || typeof data !== 'object') throw new Error('Invalid SMS summary response');
  const summary = data as SMSHistorySummary;
  if (!Number.isSafeInteger(summary.total) || !Number.isSafeInteger(summary.delivered) || summary.total < 0 || summary.delivered < 0 || summary.delivered > summary.total) throw new Error('Invalid SMS summary response');
  return summary;
}
