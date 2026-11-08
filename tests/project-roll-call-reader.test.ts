import { beforeEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ rpc: vi.fn(), fetch: vi.fn() }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ rpc: mock.rpc }) }));
import { loadProjectRollCall, projectRollCallFingerprint } from '@/lib/attendance/project-roll-call';

const record = (id: string, worker: string) => ({ id, worker_id: worker, project_id: 'p', date: '2026-11-03', status: 'present', hours_worked: 8, notes: '', recorded_by: 'u', is_founder_override: false, submitted_at: 'now', created_at: 'now', worker_name: null, worker_position: null, project_name: 'Site', is_supervisor: false });
beforeEach(() => { vi.resetAllMocks(); vi.stubGlobal('fetch', mock.fetch); mock.fetch.mockResolvedValue({ ok: true, json: async () => ({ workerIds: ['b', 'a'] }) }); });

describe('complete project Roll Call reads', () => {
  it('loads every page and retains records with unavailable worker details', async () => {
    mock.rpc.mockResolvedValueOnce({ data: { items: [record('1', 'a')], has_more: true }, error: null })
      .mockResolvedValueOnce({ data: { items: [record('2', 'old')], has_more: false }, error: null });
    const result = await loadProjectRollCall('p', '2026-11-03');
    expect(result.workerIds).toEqual(['a', 'b']);
    expect(result.records.map(r => r.worker_id)).toEqual(['a', 'old']);
    expect(mock.rpc.mock.calls[1][1].p_cursor_id).toBe('1');
    expect(mock.fetch).toHaveBeenCalledWith('/api/projects/p/workers', { cache: 'no-store' });
  });
  it('fails closed on an unavailable team or a malformed or partial history', async () => {
    mock.fetch.mockResolvedValueOnce({ ok: false });
    await expect(loadProjectRollCall('p', '2026-11-03')).rejects.toThrow();
    mock.rpc.mockResolvedValueOnce({ data: { items: [], has_more: true }, error: null });
    await expect(loadProjectRollCall('p', '2026-11-03')).rejects.toThrow();
    mock.rpc.mockResolvedValueOnce({ data: { items: [record('1', 'a'), record('2', 'a')], has_more: false }, error: null });
    await expect(loadProjectRollCall('p', '2026-11-03')).rejects.toThrow();
    mock.rpc.mockResolvedValueOnce({ data: { items: [{ ...record('1', 'a'), project_id: 'other' }], has_more: false }, error: null });
    await expect(loadProjectRollCall('p', '2026-11-03')).rejects.toThrow();
  });
  it('rejects duplicate team IDs and out-of-order history pages', async () => {
    mock.fetch.mockResolvedValueOnce({ok:true,json:async()=>({workerIds:['same','same']})});
    await expect(loadProjectRollCall('p','2026-11-03')).rejects.toThrow();
    mock.rpc.mockResolvedValueOnce({data:{items:[record('2','a'),record('1','b')],has_more:false},error:null});
    await expect(loadProjectRollCall('p','2026-11-03')).rejects.toThrow();
  });
  it('compares content independent of ordering and notices attendance changes', () => {
    const one = { workerIds: ['a', 'b'], records: [record('1', 'a'), record('2', 'b')] } as Awaited<ReturnType<typeof loadProjectRollCall>>;
    expect(projectRollCallFingerprint(one)).toBe(projectRollCallFingerprint({ workerIds: ['b', 'a'], records: [...one.records].reverse() }));
    expect(projectRollCallFingerprint(one)).not.toBe(projectRollCallFingerprint({ ...one, records: [{ ...one.records[0], notes: 'changed' }, one.records[1]] }));
  });
});
