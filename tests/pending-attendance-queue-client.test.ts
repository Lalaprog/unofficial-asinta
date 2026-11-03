// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ rpc: mock.rpc }) }));
import { usePendingApprovals } from '@/lib/attendance/usePendingApprovals';
import { parsePendingApprovalPage } from '@/lib/attendance/pendingApprovals';

const row = (id: string, date = '2025-01-01') => ({ id, date, worker_name: 'Sam', project_name: 'Site' });
const response = (items: ReturnType<typeof row>[], total: number, has_more: boolean) => ({data: {items, total, has_more}, error: null});
const deferred = () => {
  let resolve!: (value: unknown) => void;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};
beforeEach(() => mock.rpc.mockReset());
afterEach(() => cleanup());

describe('pending approval query client', () => {
  it('requests only for a Founder, pages by last date/id, and refreshes from the beginning', async () => {
    mock.rpc.mockResolvedValueOnce(response([row('a'), row('b'), row('c')], 4, true))
      .mockResolvedValueOnce(response([row('d', '2024-12-31')], 4, false))
      .mockResolvedValueOnce(response([row('b')], 1, false));
    const {result, rerender} = renderHook(({enabled}) => usePendingApprovals(enabled, 'founder'), {initialProps:{enabled:false}});
    expect(mock.rpc).not.toHaveBeenCalled();
    rerender({enabled:true});
    await waitFor(() => expect(result.current.items).toHaveLength(3));
    expect(mock.rpc).toHaveBeenCalledWith('pending_attendance_approvals', {p_cursor_date:null,p_cursor_id:null,p_limit:3});
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.items).toHaveLength(4));
    expect(mock.rpc).toHaveBeenLastCalledWith('pending_attendance_approvals', {p_cursor_date:'2025-01-01',p_cursor_id:'c',p_limit:3});
    expect(result.current.hasMore).toBe(false);
    await act(async () => { await result.current.refresh(); });
    expect(result.current.items.map(item => item.id)).toEqual(['b']);
    expect(result.current.total).toBe(1);
  });

  it('shows an error rather than claiming there are no approvals and supports retry', async () => {
    mock.rpc.mockResolvedValueOnce({ data:null, error:{message:'missing function'} }).mockResolvedValueOnce(response([row('old')],1,false));
    const {result} = renderHook(() => usePendingApprovals(true, 'founder'));
    await waitFor(() => expect(result.current.error).toBe('missing function'));
    expect(result.current.total).toBeNull();
    await act(async () => { await result.current.refresh(); });
    expect(result.current.error).toBeNull(); expect(result.current.items[0].id).toBe('old');
  });

  it('discards stale responses on refresh and account change', async () => {
    const first = deferred(), second = deferred(), third = deferred();
    mock.rpc.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockReturnValueOnce(third.promise);
    const {result, rerender} = renderHook(({id}) => usePendingApprovals(true, id), {initialProps:{id:'a'}});
    let refreshed!: Promise<void>;
    act(() => { refreshed = result.current.refresh(); });
    await act(async () => { second.resolve(response([row('new')],1,false)); await refreshed; });
    await act(async () => { first.resolve(response([row('stale')],1,false)); });
    expect(result.current.items.map(item => item.id)).toEqual(['new']);
    rerender({id:'b'});
    expect(result.current.items).toHaveLength(0);
    await act(async () => { third.resolve(response([row('b-user')],1,false)); });
    expect(result.current.items[0].id).toBe('b-user');
  });

  it('rejects invalid RPC results rather than reporting an empty queue', () => {
    for (const bad of [null, {}, {items:[], total:-1, has_more:false}, {items:[{}], total:1, has_more:false}]) {
      expect(() => parsePendingApprovalPage(bad)).toThrow();
    }
  });
});
