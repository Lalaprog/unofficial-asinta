// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mock=vi.hoisted(()=>({rpc:vi.fn()}));
vi.mock('@/lib/supabase/client',()=>({createClient:()=>({rpc:mock.rpc})}));
import {useAttendanceHistory} from '@/lib/attendance/useAttendanceHistory';
import {parseHistoryPage, type HistorySheet} from '@/lib/attendance/history';
const sheet=(date:string,project_id:string)=>({date,project_id,project_name:'Site',record_count:1,present_count:1,half_day_count:0,absent_count:0,leave_count:0,pending_count:0});
const page=(items:HistorySheet[],has_more:boolean)=>({data:{items,has_more},error:null});
const deferred=()=>{let resolve!:(value:unknown)=>void;const promise=new Promise(r=>{resolve=r});return {promise,resolve}};
beforeEach(()=>mock.rpc.mockReset());afterEach(()=>cleanup());

describe('history page client',()=>{
  it('passes filters to the server and pages using the last sheet cursor',async()=>{
    mock.rpc.mockResolvedValueOnce(page([sheet('2026-01-01','a')],true)).mockResolvedValueOnce(page([sheet('2025-01-01','b')],false));
    const {result}=renderHook(()=>useAttendanceHistory<HistorySheet>('sheets',true,'founder',{projectId:'all',status:'leave',date:'',search:' old '},0));
    await waitFor(()=>expect(result.current.items).toHaveLength(1));
    expect(mock.rpc).toHaveBeenCalledWith('attendance_history_page',expect.objectContaining({p_mode:'sheets',p_search:'old',p_status:'leave',p_limit:10,p_cursor_date:null}));
    act(()=>result.current.loadMore());await waitFor(()=>expect(result.current.items).toHaveLength(2));
    expect(mock.rpc).toHaveBeenLastCalledWith('attendance_history_page',expect.objectContaining({p_cursor_date:'2026-01-01',p_cursor_project_id:'a'}));
  });
  it('discards stale responses on filter and user changes',async()=>{
    const old=deferred(),newer=deferred(),otherUser=deferred();mock.rpc.mockReturnValueOnce(old.promise).mockReturnValueOnce(newer.promise).mockReturnValueOnce(otherUser.promise);
    const {result,rerender}=renderHook(({search,user})=>useAttendanceHistory<HistorySheet>('sheets',true,user,{projectId:'all',status:'all',date:'',search},0),{initialProps:{search:'old',user:'f'}});
    rerender({search:'new',user:'f'});
    await act(async()=>{newer.resolve(page([sheet('2025-01-01','new')],false))});
    await act(async()=>{old.resolve(page([sheet('2020-01-01','old')],false))});
    expect(result.current.items[0].project_id).toBe('new');
    rerender({search:'new',user:'other'});expect(result.current.items).toHaveLength(0);
    await act(async()=>{otherUser.resolve(page([sheet('2026-01-01','other')],false))});expect(result.current.items[0].project_id).toBe('other');
  });
  it('keeps existing pages on a failed load-more and offers retry, never a false empty state',async()=>{
    mock.rpc.mockResolvedValueOnce(page([sheet('2026-01-01','a')],true)).mockResolvedValueOnce({data:null,error:{message:'offline'}}).mockResolvedValueOnce(page([sheet('2026-01-01','a')],false));
    const {result}=renderHook(()=>useAttendanceHistory<HistorySheet>('sheets',true,'f',{projectId:'all',status:'all',date:'',search:''},0));
    await waitFor(()=>expect(result.current.items).toHaveLength(1));act(()=>result.current.loadMore());await waitFor(()=>expect(result.current.error).toBe('offline'));
    expect(result.current.items).toHaveLength(1);act(()=>result.current.retry());await waitFor(()=>expect(result.current.error).toBeNull());
  });
  it('rejects records returned for the wrong site or date',async()=>{
    mock.rpc.mockResolvedValueOnce({data:{items:[{id:'r',worker_id:'w',project_id:'other',date:'2026-01-01',status:'present',is_supervisor:false,is_founder_override:false}],has_more:false},error:null});
    const {result}=renderHook(()=>useAttendanceHistory('records',true,'f',{projectId:'site',status:'all',date:'2026-01-01',search:''},0));
    await waitFor(()=>expect(result.current.error).toMatch(/requested scope/));
    expect(result.current.items).toHaveLength(0);
  });
  it('rejects malformed responses',()=>{for(const bad of [null,{}, {items:[],has_more:true},{items:[{date:'2025-01-01',project_id:'x'}],has_more:false}]) expect(()=>parseHistoryPage(bad,'sheets')).toThrow()});
});
