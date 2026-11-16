// @vitest-environment jsdom
import React from 'react';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const mock=vi.hoisted(()=>({rpc:vi.fn()}));
vi.mock('@/lib/supabase/client',()=>({createClient:()=>({rpc:mock.rpc})}));
vi.mock('@/lib/auth/authContext',()=>({useAuth:()=>({user:{id:'founder'}})}));
import { TimeDetailDialog } from '@/components/attendance/TimeDetailDialog';
import type { HistoryRecord } from '@/lib/attendance/history';
import {timeDetailAttemptKey} from '@/lib/attendance/timeDetailAttempt';
const rec={id:'a',worker_id:'w',project_id:'p',date:'2026-10-25',status:'present',hours_worked:8,notes:null,recorded_by:'u',is_founder_override:false,submitted_at:'2026-10-25T12:00:00Z',created_at:'2026-10-25T12:00:00Z',worker_name:'Ada',worker_position:'Mason',project_name:'Site',is_supervisor:false} satisfies HistoryRecord;
beforeEach(()=>{mock.rpc.mockReset();sessionStorage.clear();});afterEach(()=>{cleanup();vi.restoreAllMocks();sessionStorage.clear();});
describe('time detail dialog',()=>{
 it('reads first, records hours with an idempotency key and states they do not change payroll',async()=>{
  mock.rpc.mockImplementation(async(name:string,params:Record<string,string>)=>name==='attendance_time_detail_latest'?{data:null,error:null}:{data:{request_id:params.p_request,replayed:false},error:null});
  render(React.createElement(TimeDetailDialog,{record:rec,onClose:vi.fn()}));
  await screen.findByText(/No supplemental time details/);expect(screen.getByText(/not yet used by the legacy payroll/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Regular hours (maximum 8)'),{target:{value:'8'}});fireEvent.change(screen.getByLabelText('Overtime hours'),{target:{value:'2.5'}});fireEvent.change(screen.getByLabelText('Reason / source of hours'),{target:{value:'Time sheet'}});fireEvent.click(screen.getByRole('button',{name:'Save time details'}));
  await screen.findByText(/Time details saved/);
  expect(mock.rpc).toHaveBeenLastCalledWith('record_attendance_time_detail',expect.objectContaining({p_attendance:'a',p_expected_submitted_at:rec.submitted_at,p_regular:'8',p_overtime:'2.5',p_note:'Time sheet',p_request:expect.any(String)}));
 });
 it('never enables writing when the initial detail read failed',async()=>{
  mock.rpc.mockResolvedValue({data:null,error:{message:'Unavailable'}});render(React.createElement(TimeDetailDialog,{record:rec,onClose:vi.fn()}));
  await screen.findByRole('alert');fireEvent.click(screen.getByRole('button',{name:'Dismiss'}));expect(screen.queryByRole('button',{name:'Save time details'})).toBeNull();expect(mock.rpc).toHaveBeenCalledTimes(1);
 });
 it('blocks new hours if retry storage is malformed, inaccessible, or tied to changed attendance',async()=>{
  mock.rpc.mockResolvedValue({data:null,error:null});sessionStorage.setItem(timeDetailAttemptKey('founder','a'),'broken');
  const first=render(React.createElement(TimeDetailDialog,{record:rec,onClose:vi.fn()}));await screen.findByText(/No supplemental time details/);expect(screen.queryByRole('button',{name:'Save time details'})).toBeNull();first.unmount();
  sessionStorage.clear();const storage=vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw Error('blocked');});const second=render(React.createElement(TimeDetailDialog,{record:rec,onClose:vi.fn()}));await screen.findByText(/No supplemental time details/);fireEvent.change(screen.getByLabelText('Regular hours (maximum 8)'),{target:{value:'8'}});fireEvent.change(screen.getByLabelText('Reason / source of hours'),{target:{value:'Sheet'}});fireEvent.click(screen.getByRole('button',{name:'Save time details'}));await screen.findByText(/Retry storage could not be verified/);expect(mock.rpc.mock.calls.filter(c=>c[0]==='record_attendance_time_detail')).toHaveLength(0);second.unmount();storage.mockRestore();
  sessionStorage.setItem(timeDetailAttemptKey('founder','a'),JSON.stringify({version:1,actor:'founder',attendance:'a',worker:'w',project:'p',date:rec.date,submittedAt:rec.submitted_at,id:'70000000-0000-4000-8000-000000000003',regular:'8',overtime:'2',note:'Sheet'}));
  render(React.createElement(TimeDetailDialog,{record:{...rec,submitted_at:'2026-10-26T12:00:00Z'},onClose:vi.fn()}));await screen.findByText(/Attendance or account details changed/);expect((screen.getByRole('button',{name:'Retry exact time details'}) as HTMLButtonElement).disabled).toBe(true);
 });
 it('reuses the request id after an unconfirmed response',async()=>{
  mock.rpc.mockResolvedValueOnce({data:null,error:null}).mockResolvedValueOnce({data:null,error:{message:'network timeout'}}).mockImplementationOnce(async(_name:string,p:Record<string,string>)=>({data:{request_id:p.p_request,replayed:true},error:null}));
  render(React.createElement(TimeDetailDialog,{record:rec,onClose:vi.fn()}));await screen.findByText(/No supplemental time details/);
  fireEvent.change(screen.getByLabelText('Regular hours (maximum 8)'),{target:{value:'8'}});fireEvent.change(screen.getByLabelText('Reason / source of hours'),{target:{value:'Sheet'}});fireEvent.click(screen.getByRole('button',{name:'Save time details'}));await screen.findByRole('alert');
  const first=mock.rpc.mock.calls[1][1].p_request;expect(screen.queryByLabelText('Regular hours (maximum 8)')).toBeNull();fireEvent.click(screen.getByRole('button',{name:'Retry exact time details'}));await waitFor(()=>expect(mock.rpc).toHaveBeenCalledTimes(3));expect(mock.rpc.mock.calls[2][1].p_request).toBe(first);
 });
});
