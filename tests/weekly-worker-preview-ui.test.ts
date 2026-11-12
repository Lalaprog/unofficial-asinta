// @vitest-environment jsdom
import React from 'react';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const mock=vi.hoisted(()=>({rpc:vi.fn(),user:'founder'}));
vi.mock('@/lib/auth/authContext',()=>({useAuth:()=>({user:{id:mock.user},isFounder:true})}));
vi.mock('@/lib/supabase/client',()=>({createClient:()=>({rpc:mock.rpc})}));
vi.mock('@/lib/reminders/scheduler',()=>({getManilaClock:()=>({dateIso:'2026-11-18'})}));
import {WeeklyWorkerPreview} from '@/components/payroll/WeeklyWorkerPreview';
const snapshot={start:'2026-11-15',end:'2026-11-21',workers:[{id:'w',name:'Ada',position:'Mason',active:true,pay_rate:'655.55',pay_rate_type:'daily',linked_supervisor:false,possible_supervisor:false}],attendance:[{id:'a',worker_id:'w',project_id:'p',date:'2026-11-15',status:'present',hours_worked:'8.00'}],vouchers:[]};
const deferred=()=>{let resolve!:(value:unknown)=>void;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
beforeEach(()=>{mock.rpc.mockReset();mock.user='founder';});afterEach(cleanup);
describe('weekly planning preview',()=>{
 it('loads on request and clearly labels unmarked days and limited estimate',async()=>{
  mock.rpc.mockResolvedValue({data:snapshot,error:null});render(React.createElement(WeeklyWorkerPreview));expect(mock.rpc).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:/Weekly worker planning preview/}));fireEvent.click(screen.getByRole('button',{name:'Load preview'}));
  await screen.findByText('Ada');expect(mock.rpc).toHaveBeenCalledWith('weekly_worker_preview_inputs',{p_start:'2026-11-15'});expect(screen.getByText(/estimated gross: ₱655.55/)).toBeTruthy();expect(screen.getByText(/Past unmarked day/)).toBeTruthy();expect(screen.getByText(/excludes allowances, Bale/)).toBeTruthy();
 });
 it('discards stale responses when the week changes and surfaces failures',async()=>{
  const old=deferred();mock.rpc.mockReturnValueOnce(old.promise).mockResolvedValueOnce({data:null,error:{message:'Unavailable'}});
  render(React.createElement(WeeklyWorkerPreview));fireEvent.click(screen.getByRole('button',{name:/Weekly worker planning preview/}));fireEvent.click(screen.getByRole('button',{name:'Load preview'}));
  fireEvent.change(screen.getByLabelText('Date in worker week'),{target:{value:'2026-11-25'}});fireEvent.click(screen.getByRole('button',{name:'Load preview'}));
  await screen.findByRole('alert');expect(screen.getByRole('alert').textContent).toMatch(/Unavailable/);await act(async()=>old.resolve({data:snapshot,error:null}));expect(screen.queryByText('Ada')).toBeNull();
 });
});
