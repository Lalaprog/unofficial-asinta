import type { Attendance } from '@/types';

export interface HistorySheet {
  date: string;
  project_id: string;
  project_name: string | null;
  record_count: number;
  present_count: number;
  half_day_count: number;
  absent_count: number;
  leave_count: number;
  pending_count: number;
}
export interface HistoryRecord extends Attendance {
  worker_name: string | null;
  worker_position: string | null;
  project_name: string | null;
  is_supervisor: boolean;
}
export interface HistoryFilters { projectId: string; status: string; date: string; search: string }
export interface HistoryPage<T> { items: T[]; has_more: boolean }

export function parseHistoryPage<T extends HistorySheet | HistoryRecord>(data: unknown, mode: 'sheets' | 'records'): HistoryPage<T> {
  if (!data || typeof data !== 'object') throw new Error('Invalid attendance history response');
  const value = data as Partial<HistoryPage<T>>;
  if (!Array.isArray(value.items) || typeof value.has_more !== 'boolean' || (value.has_more && value.items.length === 0)) throw new Error('Invalid attendance history response');
  for (const item of value.items) {
    if (!item || typeof item.date !== 'string' || typeof item.project_id !== 'string') throw new Error('Invalid attendance history item');
    if (mode === 'sheets') {
      const sheet = item as HistorySheet;
      if (![sheet.record_count, sheet.present_count, sheet.half_day_count, sheet.absent_count, sheet.leave_count, sheet.pending_count].every((n) => Number.isSafeInteger(n) && n >= 0)) throw new Error('Invalid attendance history counts');
    } else {
      const record = item as HistoryRecord;
      if (typeof record.id !== 'string' || typeof record.worker_id !== 'string' || typeof record.is_supervisor !== 'boolean' || typeof record.is_founder_override !== 'boolean' || !['present', 'half_day', 'absent', 'leave'].includes(record.status)) throw new Error('Invalid attendance history record');
    }
  }
  return value as HistoryPage<T>;
}
