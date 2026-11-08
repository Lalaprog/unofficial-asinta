// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('@/lib/attendance/project-roll-call', () => ({ loadProjectRollCall: mock.load }));
import { useProjectRollCall } from '@/lib/attendance/useProjectRollCall';
afterEach(() => vi.resetAllMocks());

describe('project Roll Call loading', () => {
  it('ignores a late response after the selected project changes', async () => {
    let finishOld!: (v: unknown) => void;
    mock.load.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }))
      .mockResolvedValueOnce({workerIds:['new'],records:[]});
    const hook=renderHook(({project}) => useProjectRollCall('user',project,'2026-11-03',true), {initialProps:{project:'old'}});
    hook.rerender({project:'new'});
    await waitFor(() => expect(hook.result.current.status).toBe('ready'));
    expect(hook.result.current.snapshot?.workerIds).toEqual(['new']);
    await act(async () => { finishOld({workerIds:['old'],records:[]}); });
    expect(hook.result.current.snapshot?.workerIds).toEqual(['new']);
  });
  it('reports a failed read instead of an empty team, and supports retry', async () => {
    mock.load.mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce({workerIds:[],records:[]});
    const hook=renderHook(() => useProjectRollCall('user','site','2026-11-03',true));
    await waitFor(() => expect(hook.result.current.status).toBe('error'));
    expect(hook.result.current.snapshot).toBeNull();
    await act(async () => { await hook.result.current.reload(); });
    expect(hook.result.current.status).toBe('ready');
    expect(hook.result.current.snapshot?.workerIds).toEqual([]);
  });
});
