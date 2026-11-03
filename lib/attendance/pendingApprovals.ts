import type { Attendance } from '@/types';

export interface PendingApproval extends Attendance {
  worker_name: string | null;
  worker_position: string | null;
  project_name: string | null;
}

export interface PendingApprovalPage {
  items: PendingApproval[];
  total: number;
  has_more: boolean;
}

export interface PendingApprovalCursor { date: string; id: string }

/** Parse defensively: an unavailable or incompatible RPC is an error, not an empty queue. */
export function parsePendingApprovalPage(value: unknown): PendingApprovalPage {
  if (!value || typeof value !== 'object') throw new Error('Invalid approval queue response');
  const page = value as Partial<PendingApprovalPage>;
  if (!Array.isArray(page.items) || !Number.isSafeInteger(page.total) || (page.total ?? -1) < 0 || typeof page.has_more !== 'boolean') {
    throw new Error('Invalid approval queue response');
  }
  for (const item of page.items) {
    if (!item || typeof item.id !== 'string' || typeof item.date !== 'string') throw new Error('Invalid approval queue record');
  }
  return page as PendingApprovalPage;
}
