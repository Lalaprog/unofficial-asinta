'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { parseHistoryPage, type HistoryFilters, type HistoryRecord, type HistorySheet } from './history';

type Item = HistorySheet | HistoryRecord;
type State<T> = { key: string; items: T[]; hasMore: boolean; loading: boolean; error: string | null };

/** Keyset paging over an RLS-respecting server query. Never treats failure as empty. */
export function useAttendanceHistory<T extends Item>(mode: 'sheets' | 'records', enabled: boolean, userId: string | undefined, filters: HistoryFilters, revision: number) {
  const { projectId, status, date, search } = filters;
  const key = JSON.stringify([mode, enabled, userId, projectId, status, date, search, revision]);
  const currentKey = useRef(key); currentKey.current = key;
  const requestId = useRef(0);
  const busy = useRef(false);
  const [state, setState] = useState<State<T>>({key: '',items: [],hasMore:false,loading:false,error:null});

  const load = useCallback(async (cursor?: T) => {
    if (!enabled || !userId || (cursor && busy.current)) return;
    const token = ++requestId.current;
    busy.current = true;
    setState((prev) => ({key, items: cursor && prev.key === key ? prev.items : [], hasMore: cursor && prev.key === key ? prev.hasMore : false, loading:true,error:null}));
    try {
      const sheet = mode === 'sheets' ? cursor as HistorySheet | undefined : undefined;
      const record = mode === 'records' ? cursor as HistoryRecord | undefined : undefined;
      const {data, error} = await createClient().rpc('attendance_history_page', {
        p_mode: mode, p_project_id: projectId === 'all' || !projectId ? null : projectId,
        p_status: status === 'all' || !status ? null : status, p_date: date || null,
        p_search: search.trim() || null, p_cursor_date: sheet?.date ?? null,
        p_cursor_project_id: sheet?.project_id ?? null, p_cursor_id: record?.id ?? null,
        p_limit: mode === 'sheets' ? 10 : 20,
      });
      if (error) throw new Error(error.message);
      const page = parseHistoryPage<T>(data, mode);
      if (token !== requestId.current || currentKey.current !== key) return;
      setState((prev) => {
        const existing = cursor && prev.key === key ? prev.items : [];
        const identity = (item: T) => mode === 'sheets' ? `${item.date}:${item.project_id}` : (item as HistoryRecord).id;
        const ids = new Set(existing.map(identity));
        return {key, items:[...existing,...page.items.filter((item) => !ids.has(identity(item)))],hasMore:page.has_more,loading:false,error:null};
      });
    } catch (error) {
      if (token !== requestId.current || currentKey.current !== key) return;
      setState((prev) => ({key,items:cursor && prev.key === key ? prev.items : [],hasMore:cursor && prev.key === key ? prev.hasMore : false,loading:false,error:error instanceof Error ? error.message : 'Unable to load attendance history'}));
    } finally {
      if (token === requestId.current && currentKey.current === key) busy.current = false;
    }
  }, [enabled, userId, key, mode, projectId, status, date, search]);

  useEffect(() => {
    busy.current = false;
    setState({key, items:[],hasMore:false,loading:enabled && Boolean(userId),error:null});
    if (enabled && userId) void load();
    return () => { requestId.current += 1; busy.current = false; };
  }, [key, enabled, userId, load]);

  const current = state.key === key ? state : {key,items:[] as T[],hasMore:false,loading:enabled && Boolean(userId),error:null};
  return {
    ...current,
    loadMore: () => { const last = current.items[current.items.length-1]; if (current.hasMore && last && !current.loading) void load(last); },
    retry: () => void load(),
  };
}
