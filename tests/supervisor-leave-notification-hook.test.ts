// @vitest-environment jsdom
import React from 'react';
import {act,cleanup,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const mock=vi.hoisted(()=>({rpc:vi.fn()}));
vi.mock('@/lib/supabase/client',()=>({createClient:()=>({rpc:mock.rpc})}));
import {parsePendingLeaveSummary,SUPERVISOR_LEAVE_CHANGED,usePendingSupervisorLeave} from '@/lib/attendance/usePendingSupervisorLeave';
function Probe({enabled,user}:{enabled:boolean;user:string}){const s=usePendingSupervisorLeave(enabled,user);return React.createElement('output',null,`${s.status}:${s.count}`);}
const deferred=()=>{let resolve!:(v:unknown)=>void;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
beforeEach(()=>mock.rpc.mockReset());afterEach(()=>{cleanup();vi.useRealTimers();});
describe('Supervisor pending leave indicator',()=>{
 it('rejects invalid results rather than interpreting failure as an empty queue',()=>{
  expect(parsePendingLeaveSummary({pending_count:3})).toBe(3);
  for(const raw of [null,{}, {pending_count:'0'}, {pending_count:-1}, {pending_count:1.5}, {pending_count:Number.MAX_SAFE_INTEGER+1}])expect(()=>parsePendingLeaveSummary(raw)).toThrow();
 });
 it('loads only while enabled and refreshes on queue change; errors remain unknown',async()=>{
  mock.rpc.mockResolvedValueOnce({data:{pending_count:2},error:null}).mockResolvedValueOnce({data:null,error:{message:'offline'}}).mockResolvedValueOnce({data:{pending_count:0},error:null});
  const view=render(React.createElement(Probe,{enabled:false,user:'founder'}));expect(mock.rpc).not.toHaveBeenCalled();
  view.rerender(React.createElement(Probe,{enabled:true,user:'founder'}));await screen.findByText('ready:2');
  act(()=>window.dispatchEvent(new Event(SUPERVISOR_LEAVE_CHANGED)));await screen.findByText('error:null');
  act(()=>window.dispatchEvent(new Event('focus')));await screen.findByText('ready:0');
  view.rerender(React.createElement(Probe,{enabled:false,user:'founder'}));expect(screen.getByText('idle:null')).toBeTruthy();
  expect(mock.rpc).toHaveBeenCalledTimes(3);
 });
 it('polls on an interval and reports a stalled request as unknown',async()=>{
  vi.useFakeTimers();mock.rpc.mockResolvedValueOnce({data:{pending_count:1},error:null}).mockReturnValueOnce(new Promise(()=>{}));
  render(React.createElement(Probe,{enabled:true,user:'founder'}));await act(async()=>{});
  expect(screen.getByText('ready:1')).toBeTruthy();
  await act(async()=>{vi.advanceTimersByTime(60_000);});expect(mock.rpc).toHaveBeenCalledTimes(2);
  await act(async()=>{vi.advanceTimersByTime(15_000);});expect(screen.getByText('error:null')).toBeTruthy();
 });
 it('discards an old user response and queues a refresh while a request is in flight',async()=>{
  const old=deferred(),next=deferred();mock.rpc.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise).mockResolvedValue({data:{pending_count:0},error:null});
  const view=render(React.createElement(Probe,{enabled:true,user:'a'}));view.rerender(React.createElement(Probe,{enabled:true,user:'b'}));
  act(()=>window.dispatchEvent(new Event(SUPERVISOR_LEAVE_CHANGED)));
  await act(async()=>old.resolve({data:{pending_count:99},error:null}));expect(screen.queryByText('ready:99')).toBeNull();
  await act(async()=>next.resolve({data:{pending_count:1},error:null}));await waitFor(()=>expect(screen.getByText('ready:0')).toBeTruthy());expect(mock.rpc).toHaveBeenCalledTimes(3);
 });
});
