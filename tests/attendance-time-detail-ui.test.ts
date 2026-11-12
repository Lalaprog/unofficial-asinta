// @vitest-environment jsdom
import React from 'react';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const mock=vi.hoisted(()=>({rpc:vi.fn()}));
vi.mock('@/lib/supabase/client',()=>({createClient:()=>({rpc:mock.rpc})}));
import { TimeDetailDialog } from '@/components/attendance/TimeDetailDialog';
import type { HistoryRecord } from '@/lib/attendance/history';
const rec={id:'a',worker_id:'w',project_id:'p',date:'2026-10-25',status:'present',hours_worked:8,notes:null,recorded_by:'u',is_founder_override:false,submitted_at:'2026-10-25T12:00:00Z',created_at:'2026-10-25T12:00:00Z',worker_name:'Ada',worker_position:'Mason',project_name:'Site',is_supervisor:false} satisfies HistoryRecord;
beforeEach(()=>{mock.rpc.mockReset();});afterEach(cleanup);
describe('time detail dialog',()=>{
 it('reads first, records hours with an idempotency key and states they do not change payroll',async()=>{
  mock.rpc.mockImplementation(async(name:string,params:Record<string,string>)=>name==='attendance_time_detail_latest'?{data:null,error:null}:{data:{request_id:params.p_request,replayed:false},error:null});
  render(React.createElement(TimeDetailDialog,{record:rec,onClose:vi.fn()}));
  await screen.findByText(/No supplemental time details/);expect(screen.getByText(/not yet used by payroll/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Regular hours (maximum 8)'),{target:{value:'8'}});fireEvent.change(screen.getByLabelText('Overtime hours'),{target:{value:'2.5'}});fireEvent.change(screen.getByLabelText('Reason / source of hours'),{target:{value:'Time sheet'}});fireEvent.click(screen.getByRole('button',{name:'Save time details'}));
  await screen.findByText(/Time details saved/);
  expect(mock.rpc).toHaveBeenLastCalledWith('record_attendance_time_detail',expect.objectContaining({p_attendance:'a',p_expected_submitted_at:rec.submitted_at,p_regular:'8',p_overtime:'2.5',p_note:'Time sheet',p_request:expect.any(String)}));
 });
 it('never enables writing when the initial detail read failed',async()=>{
  mock.rpc.mockResolvedValue({data:null,error:{message:'Unavailable'}});render(React.createElement(TimeDetailDialog,{record:rec,onClose:vi.fn()}));
  await screen.findByRole('alert');fireEvent.click(screen.getByRole('button',{name:'Dismiss'}));expect(screen.queryByRole('button',{name:'Save time details'})).toBeNull();expect(mock.rpc).toHaveBeenCalledTimes(1);
 });
 it('reuses the request id after an unconfirmed response',async()=>{
  mock.rpc.mockResolvedValueOnce({data:null,error:null}).mockResolvedValueOnce({data:null,error:{message:'network timeout'}}).mockImplementationOnce(async(_name:string,p:Record<string,string>)=>({data:{request_id:p.p_request,replayed:true},error:null}));
  render(React.createElement(TimeDetailDialog,{record:rec,onClose:vi.fn()}));await screen.findByText(/No supplemental time details/);
  fireEvent.change(screen.getByLabelText('Regular hours (maximum 8)'),{target:{value:'8'}});fireEvent.change(screen.getByLabelText('Reason / source of hours'),{target:{value:'Sheet'}});fireEvent.click(screen.getByRole('button',{name:'Save time details'}));await screen.findByRole('alert');
  const first=mock.rpc.mock.calls[1][1].p_request;fireEvent.click(screen.getByRole('button',{name:'Dismiss'}));fireEvent.click(screen.getByRole('button',{name:'Save time details'}));await waitFor(()=>expect(mock.rpc).toHaveBeenCalledTimes(3));expect(mock.rpc.mock.calls[2][1].p_request).toBe(first);
 });
});
