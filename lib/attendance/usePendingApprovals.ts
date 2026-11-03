'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { parsePendingApprovalPage, type PendingApproval, type PendingApprovalCursor } from './pendingApprovals';

const PAGE_SIZE = 3;

/** Independent, keyset-paginated Founder queue; errors are never treated as empty. */
export function usePendingApprovals(enabled: boolean, userId: string | undefined) {
  const [items, setItems] = useState<PendingApproval[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);
  const loadingRef = useRef(false);
  const identityRef = useRef(`${enabled}:${userId || ''}`);
  identityRef.current = `${enabled}:${userId || ''}`;

  const load = useCallback(async (cursor?: PendingApprovalCursor) => {
    if (!enabled || !userId) return;
    if (cursor && loadingRef.current) return;
    const request = ++requestRef.current;
    const identity = `${enabled}:${userId}`;
    loadingRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const { data, error: rpcError } = await createClient().rpc('pending_attendance_approvals', {
        p_cursor_date: cursor?.date ?? null,
        p_cursor_id: cursor?.id ?? null,
        p_limit: PAGE_SIZE,
      });
      if (rpcError) throw new Error(rpcError.message);
      const page = parsePendingApprovalPage(data);
      if (request !== requestRef.current || identityRef.current !== identity) return;
      setItems((previous) => cursor ? [...previous, ...page.items.filter((item) => !previous.some((old) => old.id === item.id))] : page.items);
      setTotal(page.total);
      setHasMore(page.has_more);
    } catch (err) {
      if (request !== requestRef.current || identityRef.current !== identity) return;
      setError(err instanceof Error ? err.message : 'Unable to load pending approvals');
      if (!cursor) { setItems([]); setTotal(null); setHasMore(false); }
    } finally {
      if (request === requestRef.current && identityRef.current === identity) {
        loadingRef.current = false;
        setLoading(false);
      }
    }
  }, [enabled, userId]);

  useEffect(() => {
    setItems([]); setTotal(null); setHasMore(false); setError(null); loadingRef.current = false;
    if (enabled && userId) void load();
    else setLoading(false);
    return () => { requestRef.current += 1; loadingRef.current = false; };
  }, [enabled, userId, load]);

  const loadMore = () => {
    const last = items[items.length - 1];
    if (hasMore && last) void load({date: last.date, id: last.id});
  };
  const refresh = () => load();
  return { items, total, hasMore, loading, error, loadMore, refresh };
}
