// @vitest-environment jsdom
import React from 'react';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {HistoryRecord} from '@/lib/attendance/history';
const mock=vi.hoisted(()=>({rpc:vi.fn(),user:'founder',assurance:'ready'}));
vi.mock('@/lib/auth/authContext',()=>({useAuth:()=>({user:{id:mock.user},isFounder:true,isSupervisor:false,assurance:mock.assurance})}));
vi.mock('@/lib/supabase/client',()=>({createClient:()=>({rpc:mock.rpc})}));
import {AttendanceTimeDetails,AttendanceTimeLabel} from '@/components/attendance/AttendanceTimeDetails';
const row={id:'a',worker_id:'w',project_id:'site',date:'2024-11-03',status:'present',hours_worked:8,submitted_at:'2024-11-03T08:00:00+00:00',is_supervisor:false} as HistoryRecord;
const item={id:'a',worker_id:'w',project_id:'site',date:'2024-11-03',status:'present',hours_worked:8,submitted_at:'2024-11-03T08:00:00+00:00',detail:{regular_hours:'8.00',overtime_hours:'2.50',stale:false}};
const view=(records:HistoryRecord[]=[row],userId='founder',revision=0)=>React.createElement(AttendanceTimeDetails,{records,userId,revision,loading:false},...records.map(r=>React.createElement(AttendanceTimeLabel,{key:r.id,id:r.id})));
beforeEach(()=>{vi.stubEnv('NEXT_PUBLIC_FINANCE_FOUNDATION_PREVIEW','true');vi.stubEnv('NEXT_PUBLIC_ATTENDANCE_TIME_HISTORY_PREVIEW','true');mock.rpc.mockReset();mock.user='founder';mock.assurance='ready';});afterEach(()=>{cleanup();vi.unstubAllEnvs();});
describe('attendance regular/OT history enrichment',()=>{
 it('is off unless both switches are enabled',()=>{
  vi.stubEnv('NEXT_PUBLIC_ATTENDANCE_TIME_HISTORY_PREVIEW','false');render(view());expect(mock.rpc).not.toHaveBeenCalled();expect(screen.queryByText(/regular\/OT details/i)).toBeNull();
 });
 it('shows current, stale and unavailable details without assuming zero',async()=>{
  const rows=[row,{...row,id:'b'},{...row,id:'c'}] as HistoryRecord[];
  mock.rpc.mockResolvedValue({data:{items:[item,{...item,id:'b',detail:{...item.detail,stale:true}},{...item,id:'c',detail:null}]},error:null});render(view(rows));
  await screen.findByText('Regular 8.00 h · OT 2.50 h');expect(screen.getByText(/outdated; review required/)).toBeTruthy();expect(screen.getByText('No visible regular/OT details')).toBeTruthy();expect(mock.rpc).toHaveBeenCalledWith('attendance_history_time_batch',{p_ids:['a','b','c']});
 });
 it('fails closed for changed snapshots or errors, then retries',async()=>{
  mock.rpc.mockResolvedValueOnce({data:{items:[{...item,status:'absent'}]},error:null}).mockResolvedValueOnce({data:{items:[item]},error:null});render(view());expect((await screen.findByRole('alert')).textContent).toMatch(/Attendance changed/);expect(screen.queryByText(/Regular 8.00/)).toBeNull();fireEvent.click(screen.getByRole('button',{name:'Retry time details'}));await screen.findByText('Regular 8.00 h · OT 2.50 h');
 });
 it('discards an old response after account, assurance or attendance changes',async()=>{
  let resolve!:(v:unknown)=>void;mock.rpc.mockReturnValueOnce(new Promise(r=>resolve=r));const v=render(view());mock.assurance='required';v.rerender(view());await act(async()=>resolve({data:{items:[item]},error:null}));expect(screen.queryByText(/Regular 8.00/)).toBeNull();expect(screen.getByText(/authorized, assured session/)).toBeTruthy();
  mock.assurance='ready';mock.rpc.mockResolvedValueOnce({data:{items:[item]},error:null});v.rerender(view());await screen.findByText(/Regular 8.00/);v.rerender(view([{...row,hours_worked:7} as HistoryRecord]));expect(screen.queryByText(/Regular 8.00/)).toBeNull();
 });
 it('chunks 101 records and withholds all results if any chunk fails',async()=>{
  const rows=Array.from({length:101},(_,n)=>({...row,id:`id-${String(n).padStart(3,'0')}`})) as HistoryRecord[];
  mock.rpc.mockImplementation(async(_name:string,p:{p_ids:string[]})=>p.p_ids.length===1?{data:null,error:{message:'offline'}}:{data:{items:p.p_ids.map(id=>({...item,id}))},error:null});render(view(rows));await screen.findByRole('alert');expect(screen.queryByText(/Regular 8.00/)).toBeNull();expect(mock.rpc).toHaveBeenCalledTimes(2);expect(mock.rpc.mock.calls[0][1].p_ids).toHaveLength(100);
 });
 it('does not silently truncate more than 500 loaded rows',async()=>{
  const rows=Array.from({length:501},(_,n)=>({...row,id:`id-${n}`})) as HistoryRecord[];render(view(rows));await waitFor(()=>expect(screen.getByRole('alert').textContent).toMatch(/Too many loaded records/));expect(mock.rpc).not.toHaveBeenCalled();
 });
});
