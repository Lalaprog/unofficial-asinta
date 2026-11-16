// @vitest-environment jsdom
import React from 'react';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const mock=vi.hoisted(()=>({rpc:vi.fn()}));vi.mock('@/lib/supabase/client',()=>({createClient:()=>({rpc:mock.rpc})}));
import {AssignmentHistory} from '@/components/workforce/AssignmentHistory';
import {assignmentHistoryPreviewEnabled,parseAssignmentHistory} from '@/lib/workforce/assignmentHistory';
const item=(id:string)=>({id,project_id:'p',project_name:'Site A',event_type:'baseline_active',occurred_at:'2026-10-15T00:00:00Z',actor_id:null});
const page=(items:unknown[],more=false)=>({worker_id:'worker',items,has_more:more});
beforeEach(()=>mock.rpc.mockReset());afterEach(()=>{cleanup();vi.unstubAllEnvs();});
describe('Founder assignment history candidate',()=>{
 it('is independently default-off',()=>{vi.stubEnv('NEXT_PUBLIC_ASSIGNMENT_HISTORY_PREVIEW','false');expect(assignmentHistoryPreviewEnabled()).toBe(false);vi.stubEnv('NEXT_PUBLIC_ASSIGNMENT_HISTORY_PREVIEW','true');expect(assignmentHistoryPreviewEnabled()).toBe(true);});
 it('loads on demand and correctly labels baseline as an observation, not a start',async()=>{
  mock.rpc.mockResolvedValue({data:page([item('a')]),error:null});render(React.createElement(AssignmentHistory,{workerId:'worker',workerName:'Ada'}));expect(mock.rpc).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'Assignment history for Ada'}));expect(await screen.findByText(/Active at baseline/)).toBeTruthy();expect(screen.getByText(/not when an assignment started or ended/)).toBeTruthy();
 });
 it('clears partial data on page errors and ignores a response after closing',async()=>{
  mock.rpc.mockResolvedValueOnce({data:page(Array.from({length:25},(_,i)=>item(String(30-i).padStart(2,'0'))),true),error:null}).mockResolvedValueOnce({data:page([item('30')]),error:null});render(React.createElement(AssignmentHistory,{workerId:'worker',workerName:'Ada'}));fireEvent.click(screen.getByRole('button',{name:'Assignment history for Ada'}));await screen.findByRole('button',{name:'Show older assignments'});fireEvent.click(screen.getByRole('button',{name:'Show older assignments'}));await screen.findByRole('alert');expect(screen.queryByText(/Active at baseline/)).toBeNull();
  let resolve!:(x:unknown)=>void;mock.rpc.mockReturnValueOnce(new Promise(r=>{resolve=r;}));fireEvent.click(screen.getByRole('button',{name:'Refresh assignment history'}));fireEvent.click(screen.getByRole('button',{name:'Assignment history for Ada'}));resolve({data:page([item('a')]),error:null});await Promise.resolve();expect(screen.queryByText(/Active at baseline/)).toBeNull();
 });
 it('rejects wrong worker, duplicate events and fabricated baseline actors',()=>{
  expect(parseAssignmentHistory(page([item('a')]),'worker').items).toHaveLength(1);for(const value of [{...page([]),worker_id:'other'},page([item('a'),item('a')]),page([{...item('a'),actor_id:'person'}]),page([item('a')],true)])expect(()=>parseAssignmentHistory(value,'worker')).toThrow();
 });
});
