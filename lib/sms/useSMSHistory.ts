'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { parseSMSHistoryPage, parseSMSHistorySummary, type SMSHistoryFilters, type SMSHistoryItem, type SMSHistorySummary } from './history';

type State = { key: string; items: SMSHistoryItem[]; hasMore: boolean; loading: boolean; error: string | null };
export function useSMSHistory(enabled: boolean, userId: string | undefined, filters: SMSHistoryFilters, revision: number) {
  const { search, status, from, to } = filters;
  const key = JSON.stringify([enabled,userId,search,status,from,to,revision]);
  const currentKey = useRef(key); currentKey.current = key;
  const sequence = useRef(0), busy = useRef(false);
  const [state,setState] = useState<State>({key:'',items:[],hasMore:false,loading:false,error:null});
  const load = useCallback(async (cursor?: SMSHistoryItem) => {
    if (!enabled || !userId || (cursor && busy.current)) return;
    const token = ++sequence.current; busy.current = true;
    setState(prev => ({key,items:cursor && prev.key === key ? prev.items : [],hasMore:cursor && prev.key === key ? prev.hasMore : false,loading:true,error:null}));
    try {
      const {data,error} = await createClient().rpc('sms_history_page', {p_search:search.trim() || null,p_status:status === 'all' ? null : status,p_from:from || null,p_to:to || null,p_cursor_sent_at:cursor?.sent_at ?? null,p_cursor_id:cursor?.id ?? null,p_limit:25});
      if (error) throw error;
      const page = parseSMSHistoryPage(data);
      if (token !== sequence.current || currentKey.current !== key) return;
      setState(prev => {
        const existing = cursor && prev.key === key ? prev.items : [];
        const ids = new Set(existing.map(item => item.id));
        return {key,items:[...existing,...page.items.filter(item => !ids.has(item.id))],hasMore:page.has_more,loading:false,error:null};
      });
    } catch {
      if (token !== sequence.current || currentKey.current !== key) return;
      setState(prev => ({key,items:cursor && prev.key === key ? prev.items : [],hasMore:cursor && prev.key === key ? prev.hasMore : false,loading:false,error:'Could not load SMS history. Check your connection and try again.'}));
    } finally { if (token === sequence.current && currentKey.current === key) busy.current = false; }
  },[enabled,userId,key,search,status,from,to]);
  useEffect(() => {
    busy.current = false;
    setState({key,items:[],hasMore:false,loading:enabled && Boolean(userId),error:null});
    if (enabled && userId) void load();
    return () => { sequence.current += 1; busy.current = false; };
  },[enabled,userId,key,load]);
  const current = state.key === key ? state : {key,items:[],hasMore:false,loading:enabled && Boolean(userId),error:null};
  return {...current, loadMore: () => { const last=current.items[current.items.length-1]; if (current.hasMore && last && !current.loading) void load(last); }, retry: () => { const last=current.items[current.items.length-1]; void load(last && current.hasMore ? last : undefined); }};
}

export function useSMSHistorySummary(enabled: boolean, userId: string | undefined, revision: number) {
  const key = JSON.stringify([enabled,userId,revision]);
  const [state,setState] = useState<{key:string; value:SMSHistorySummary|null; error:boolean}>({key:'',value:null,error:false});
  useEffect(() => {
    let active = true;
    setState({key,value:null,error:false});
    if (enabled && userId) void (async () => {
      try {
        const {data,error} = await createClient().rpc('sms_history_summary');
        if (error) throw error;
        const value = parseSMSHistorySummary(data);
        if (active) setState({key,value,error:false});
      } catch { if (active) setState({key,value:null,error:true}); }
    })();
    return () => { active = false; };
  },[enabled,userId,key]);
  return state.key === key ? state : {key,value:null,error:false};
}
