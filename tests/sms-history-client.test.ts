// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mock=vi.hoisted(()=>({rpc:vi.fn()}));
vi.mock('@/lib/supabase/client',()=>({createClient:()=>({rpc:mock.rpc})}));
import {useSMSHistory,useSMSHistorySummary} from '@/lib/sms/useSMSHistory';
const item=(id:string)=>({id,sent_at:'2026-11-03T00:00:00.123456+00:00',invoice_number:null,recipient:'Ada',phone:'0912',message:'Full message',status:'sent',simulated:false});
const page=(ids:string[],more:boolean)=>({data:{items:ids.map(item),has_more:more},error:null});
const deferred=()=>{let resolve!:(x:unknown)=>void;const promise=new Promise(r=>{resolve=r});return {promise,resolve}};
const filters={search:' literal % ',status:'failed',from:'2026-01-01',to:'2026-11-03'};
beforeEach(()=>mock.rpc.mockReset());afterEach(()=>cleanup());
describe('SMS history client',()=>{
  it('uses unmodified microsecond cursor and retries a failed next page without losing rows',async()=>{
    mock.rpc.mockResolvedValueOnce(page(['a'],true)).mockResolvedValueOnce({error:{message:'offline'}}).mockResolvedValueOnce(page(['b'],false));
    const {result}=renderHook(()=>useSMSHistory(true,'f',filters,0));
    await waitFor(()=>expect(result.current.items).toHaveLength(1));
    expect(mock.rpc).toHaveBeenCalledWith('sms_history_page',expect.objectContaining({p_search:'literal %',p_status:'failed',p_from:'2026-01-01',p_to:'2026-11-03'}));
    act(()=>{result.current.loadMore();result.current.loadMore()});
    await waitFor(()=>expect(result.current.error).toBeTruthy());expect(result.current.items).toHaveLength(1);
    act(()=>result.current.retry());await waitFor(()=>expect(result.current.items).toHaveLength(2));
    expect(mock.rpc).toHaveBeenLastCalledWith('sms_history_page',expect.objectContaining({p_cursor_sent_at:item('a').sent_at,p_cursor_id:'a'}));
    expect(mock.rpc).toHaveBeenCalledTimes(3);
  });
  it('discards obsolete filter, refresh and session responses',async()=>{
    const old=deferred(),newer=deferred(),other=deferred();mock.rpc.mockReturnValueOnce(old.promise).mockReturnValueOnce(newer.promise).mockReturnValueOnce(other.promise);
    const {result,rerender}=renderHook(({search,user,rev})=>useSMSHistory(true,user,{...filters,search},rev),{initialProps:{search:'old',user:'a',rev:0}});
    rerender({search:'new',user:'a',rev:1});
    await act(async()=>{newer.resolve(page(['new'],false))});await act(async()=>{old.resolve(page(['old'],false))});expect(result.current.items[0].id).toBe('new');
    rerender({search:'new',user:'b',rev:1});expect(result.current.items).toHaveLength(0);
    await act(async()=>{other.resolve(page(['other'],false))});expect(result.current.items[0].id).toBe('other');
  });
  it('fails closed on malformed results and refreshes summary after revision',async()=>{
    mock.rpc.mockResolvedValueOnce({data:{items:[],has_more:true},error:null}).mockResolvedValueOnce({data:{total:4,delivered:1},error:null}).mockResolvedValueOnce({data:{total:5,delivered:1},error:null});
    const h=renderHook(()=>useSMSHistory(true,'f',filters,0));await waitFor(()=>expect(h.result.current.error).toBeTruthy());expect(h.result.current.items).toHaveLength(0);
    const s=renderHook(({rev})=>useSMSHistorySummary(true,'f',rev),{initialProps:{rev:0}});await waitFor(()=>expect(s.result.current.value?.total).toBe(4));s.rerender({rev:1});await waitFor(()=>expect(s.result.current.value?.total).toBe(5));
  });
});
