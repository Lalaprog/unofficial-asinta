// @vitest-environment jsdom
import React from 'react';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const mock=vi.hoisted(()=>({rpc:vi.fn(),today:'2026-11-18'}));
vi.mock('@/lib/auth/authContext',()=>({useAuth:()=>({user:{id:'supervisor'},isFounder:false,isSupervisor:true})}));
vi.mock('@/lib/supabase/client',()=>({createClient:()=>({rpc:mock.rpc})}));
vi.mock('@/lib/reminders/scheduler',()=>({getManilaClock:()=>({dateIso:mock.today})}));
import {WeeklyBaleReleasePanel} from '@/components/advances/WeeklyBaleReleasePanel';
const item={request_id:'request',worker_id:'worker',worker_name:'Ada',project_id:'project',project_name:'Site',amount:'100.25',status:'approved_pending_payment',release_date:'2026-11-18',issued_advance_id:null};
const result={start:'2026-11-15',end:'2026-11-21',items:[item]};
beforeEach(()=>{mock.rpc.mockReset();mock.today='2026-11-18';});afterEach(cleanup);
const open=()=>{render(React.createElement(WeeklyBaleReleasePanel));fireEvent.click(screen.getByRole('button',{name:'Experimental weekly Bale release'}));fireEvent.click(screen.getByRole('button',{name:'Load releases'}));};
describe('experimental site-scoped weekly Bale release',()=>{
 it('requires an explicit confirmation that money was already given',async()=>{
  mock.rpc.mockImplementation(async(name:string)=>name==='weekly_bale_release_list'?{data:result,error:null}:{data:{outcome:'updated',request_id:'request',advance_id:'advance'},error:null});
  open();await screen.findByText(/Ada.*Site.*100.25/);fireEvent.click(screen.getByRole('button',{name:'Review external release'}));
  const button=screen.getByRole('button',{name:'Record release'}) as HTMLButtonElement;expect(button.disabled).toBe(true);expect(mock.rpc).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('checkbox',{name:/verified this external release/}));fireEvent.click(button);await screen.findByText(/External release recorded/);
  expect(mock.rpc).toHaveBeenCalledWith('record_weekly_bale_release',{p_request_id:'request'});expect(screen.queryByRole('button',{name:'Review external release'})).toBeNull();
 });
 it('does not enable release outside the scheduled Wednesday',async()=>{
  mock.today='2026-11-19';mock.rpc.mockResolvedValue({data:result,error:null});open();await screen.findByText(/Ada.*Site/);
  expect((screen.getByRole('button',{name:'Review external release'}) as HTMLButtonElement).disabled).toBe(true);
 });
 it('fails closed on malformed server list and on uncertain release results',async()=>{
  mock.rpc.mockResolvedValueOnce({data:{...result,items:[item,item]},error:null});open();expect((await screen.findByRole('alert')).textContent).toMatch(/Invalid weekly Bale request/);expect(screen.queryByRole('button',{name:'Review external release'})).toBeNull();
  mock.rpc.mockResolvedValueOnce({data:result,error:null}).mockRejectedValueOnce(new Error('Network lost'));fireEvent.click(screen.getByRole('button',{name:'Load releases'}));await screen.findByText(/Ada.*Site/);
  fireEvent.click(screen.getByRole('button',{name:'Review external release'}));fireEvent.click(screen.getByRole('checkbox',{name:/verified this external release/}));fireEvent.click(screen.getByRole('button',{name:'Record release'}));
  await screen.findByText(/Release not confirmed/);expect(screen.queryByRole('button',{name:'Review external release'})).toBeNull();
 });
});
