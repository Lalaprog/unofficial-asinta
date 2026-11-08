import { createClient } from '@/lib/supabase/client';
import { parseHistoryPage, type HistoryRecord, type HistoryPage } from '@/lib/attendance/history';

export interface ProjectRollCallSnapshot {
  workerIds: string[];
  records: HistoryRecord[];
}

/**
 * Read the explicit team and every visible attendance row for one site/day.
 * A failed or incomplete read is never interpreted as an empty roster. All
 * reads use the signed-in user's project scope and existing RLS permissions.
 */
export async function loadProjectRollCall(projectId: string, date: string): Promise<ProjectRollCallSnapshot> {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/workers`, { cache: 'no-store' });
  if (!response.ok) throw new Error('Could not load the project team.');
  const team = await response.json();
  if (!Array.isArray(team?.workerIds) || team.workerIds.some((id: unknown) => typeof id !== 'string' || !id) || new Set(team.workerIds).size !== team.workerIds.length) {
    throw new Error('Could not load the complete project team.');
  }

  const records: HistoryRecord[] = [];
  const ids = new Set<string>();
  const workerIds = new Set<string>();
  let cursor: string | null = null;
  const db = createClient();
  // Bound the work and fail closed rather than submit from a partial history.
  for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
    const { data, error }: { data: unknown; error: unknown } = await db.rpc('attendance_history_page', {
      p_mode: 'records', p_project_id: projectId, p_status: null, p_date: date, p_search: null,
      p_cursor_date: null, p_cursor_project_id: null, p_cursor_id: cursor, p_limit: 50,
    });
    if (error) throw new Error('Could not load saved attendance.');
    const page: HistoryPage<HistoryRecord> = parseHistoryPage<HistoryRecord>(data, 'records');
    let previous = cursor;
    for (const record of page.items) {
      if (record.project_id !== projectId || record.date !== date || ids.has(record.id) || workerIds.has(record.worker_id) || (previous && record.id <= previous)) {
        throw new Error('Could not verify saved attendance.');
      }
      ids.add(record.id); workerIds.add(record.worker_id); records.push(record); previous = record.id;
    }
    if (!page.has_more) return { workerIds: [...team.workerIds].sort(), records };
    const next: string | undefined = page.items[page.items.length - 1]?.id;
    if (!next || (cursor && next <= cursor)) throw new Error('Could not verify saved attendance.');
    cursor = next;
  }
  throw new Error('Too many attendance records to load safely.');
}

/** A comparison, not a lock: another user can still change data after this check. */
export function projectRollCallFingerprint(snapshot: ProjectRollCallSnapshot): string {
  return JSON.stringify({
    workerIds: [...snapshot.workerIds].sort(),
    records: [...snapshot.records].sort((a, b) => a.id.localeCompare(b.id)).map((record) => [
      record.id, record.worker_id, record.status, record.hours_worked, record.notes,
      record.recorded_by, record.is_founder_override, record.submitted_at,
    ]),
  });
}
