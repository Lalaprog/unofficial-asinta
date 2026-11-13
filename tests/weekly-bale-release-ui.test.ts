// @vitest-environment jsdom
import React from 'react';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const mock=vi.hoisted(()=>({rpc:vi.fn(),today:'2026-11-18',hookToday:'2026-11-18',user:'supervisor',assurance:'ready',supervisor:true,founder:false}));
vi.mock('@/lib/auth/authContext',()=>({useAuth:()=>({user:{id:mock.user},isFounder:mock.founder,isSupervisor:mock.supervisor,assurance:mock.assurance})}));
vi.mock('@/lib/dates/useManilaToday',()=>({useManilaToday:()=>mock.hookToday}));
vi.mock('@/lib/supabase/client',()=>({createClient:()=>({rpc:mock.rpc})}));
vi.mock('@/lib/reminders/scheduler',()=>({getManilaClock:()=>({dateIso:mock.today})}));
import {WeeklyBaleReleasePanel} from '@/components/advances/WeeklyBaleReleasePanel';
const item={request_id:'request',worker_id:'worker',worker_name:'Ada',project_id:'project',project_name:'Site',amount:'100.25',status:'approved_pending_payment',release_date:'2026-11-18',issued_advance_id:null,assignment_review_required:false};
const result={start:'2026-11-15',end:'2026-11-21',items:[item]};
beforeEach(()=>{mock.rpc.mockReset();mock.today='2026-11-18';mock.hookToday='2026-11-18';mock.user='supervisor';mock.assurance='ready';mock.supervisor=true;mock.founder=false;});afterEach(cleanup);
const open=()=>{render(React.createElement(WeeklyBaleReleasePanel));fireEvent.click(screen.getByRole('button',{name:'Experimental weekly Bale release'}));fireEvent.click(screen.getByRole('button',{name:'Load releases'}));};
describe('experimental site-scoped weekly Bale release',()=>{
 it('requires an explicit confirmation that money was already given',async()=>{
  mock.rpc.mockImplementation(async(name:string)=>name==='weekly_bale_release_list'?{data:result,error:null}:{data:{outcome:'updated',request_id:'request',advance_id:'advance'},error:null});
  open();await screen.findByText(/Ada.*Site.*100.25/);fireEvent.click(screen.getByRole('button',{name:'Review external release'}));
  const button=screen.getByRole('button',{name:'Record release'}) as HTMLButtonElement;expect(button.disabled).toBe(true);expect(mock.rpc).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('checkbox',{name:/verified this external release/}));fireEvent.click(button);await screen.findByText(/External release recorded/);
  expect(mock.rpc).toHaveBeenCalledWith('record_weekly_bale_release',{p_request_id:'request'});expect(screen.queryByRole('button',{name:'Review external release'})).toBeNull();
 });
 it('holds a moved or inactive worker for Founder review and rejects missing assignment information',async()=>{
  mock.rpc.mockResolvedValueOnce({data:{...result,items:[{...item,assignment_review_required:true}]},error:null});open();
  expect(await screen.findByText(/Ask the Founder to review before any release/)).toBeTruthy();
  expect((screen.getByRole('button',{name:'Review external release'}) as HTMLButtonElement).disabled).toBe(true);
  mock.rpc.mockResolvedValueOnce({data:{...result,items:[{...item,assignment_review_required:undefined}]},error:null});fireEvent.click(screen.getByRole('button',{name:'Refresh releases'}));
  expect((await screen.findByRole('alert')).textContent).toMatch(/Invalid weekly Bale request/);
  expect(mock.rpc.mock.calls.filter(c=>c[0]==='record_weekly_bale_release')).toHaveLength(0);
 });
 it('requires the Founder to review a changed assignment and confirm the existing external release',async()=>{
  mock.user='founder';mock.founder=true;mock.supervisor=false;
  mock.rpc.mockResolvedValueOnce({data:{...result,items:[{...item,assignment_review_required:true}]},error:null});open();
  expect(await screen.findByText(/Review the original request and site before recording/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'Review external release'}));
  expect(screen.getByText(/Assignment needs Founder review/)).toBeTruthy();
  expect((screen.getByRole('button',{name:'Record release'}) as HTMLButtonElement).disabled).toBe(true);
  expect(mock.rpc.mock.calls.filter(c=>c[0]==='record_weekly_bale_release')).toHaveLength(0);
 });
 it('does not enable release outside the scheduled Wednesday',async()=>{
  mock.today='2026-11-19';mock.hookToday=mock.today;mock.rpc.mockResolvedValue({data:result,error:null});open();await screen.findByText(/Ada.*Site/);
  expect((screen.getByRole('button',{name:'Review external release'}) as HTMLButtonElement).disabled).toBe(true);
 });
 it('discards an open confirmation when Manila date or assurance changes',async()=>{
  mock.rpc.mockResolvedValue({data:result,error:null});const view=render(React.createElement(WeeklyBaleReleasePanel));fireEvent.click(screen.getByRole('button',{name:'Experimental weekly Bale release'}));fireEvent.click(screen.getByRole('button',{name:'Load releases'}));await screen.findByText(/Ada.*Site/);fireEvent.click(screen.getByRole('button',{name:'Review external release'}));fireEvent.click(screen.getByRole('checkbox',{name:/verified this external release/}));
  mock.today='2026-11-19';mock.hookToday=mock.today;view.rerender(React.createElement(WeeklyBaleReleasePanel));expect(screen.queryByRole('button',{name:'Record release'})).toBeNull();expect(screen.queryByText(/Ada.*Site/)).toBeNull();expect(mock.rpc.mock.calls.filter(c=>c[0]==='record_weekly_bale_release')).toHaveLength(0);
  mock.today='2026-11-18';mock.hookToday=mock.today;view.rerender(React.createElement(WeeklyBaleReleasePanel));fireEvent.click(screen.getByRole('button',{name:'Load releases'}));await screen.findByText(/Ada.*Site/);fireEvent.click(screen.getByRole('button',{name:'Review external release'}));mock.assurance='required';view.rerender(React.createElement(WeeklyBaleReleasePanel));expect(screen.queryByRole('button',{name:'Record release'})).toBeNull();expect((screen.getByRole('button',{name:'Load releases'}) as HTMLButtonElement).disabled).toBe(true);
 });
 it('sends nothing if midnight passes between confirmation and clicking record',async()=>{
  mock.rpc.mockResolvedValue({data:result,error:null});open();await screen.findByText(/Ada.*Site/);fireEvent.click(screen.getByRole('button',{name:'Review external release'}));fireEvent.click(screen.getByRole('checkbox',{name:/verified this external release/}));mock.today='2026-11-19';fireEvent.click(screen.getByRole('button',{name:'Record release'}));expect(await screen.findByText(/No request was sent; investigate/)).toBeTruthy();expect(mock.rpc.mock.calls.filter(c=>c[0]==='record_weekly_bale_release')).toHaveLength(0);
 });
 it('rejects an old list response after user change or a Manila midnight rollover',async()=>{
  let resolve!:(value:unknown)=>void;mock.rpc.mockReturnValueOnce(new Promise(r=>resolve=r));const view=render(React.createElement(WeeklyBaleReleasePanel));fireEvent.click(screen.getByRole('button',{name:'Experimental weekly Bale release'}));fireEvent.click(screen.getByRole('button',{name:'Load releases'}));mock.user='different';view.rerender(React.createElement(WeeklyBaleReleasePanel));await act(async()=>resolve({data:result,error:null}));expect(screen.queryByText(/Ada.*Site/)).toBeNull();
  let late!:(value:unknown)=>void;mock.rpc.mockReturnValueOnce(new Promise(r=>late=r));fireEvent.click(screen.getByRole('button',{name:'Load releases'}));mock.today='2026-11-19';await act(async()=>late({data:result,error:null}));expect((await screen.findByRole('alert')).textContent).toMatch(/date changed/);expect(screen.queryByRole('button',{name:'Review external release'})).toBeNull();
 });
 it('fails closed on malformed server list and on uncertain release results',async()=>{
  mock.rpc.mockResolvedValueOnce({data:{...result,items:[item,item]},error:null});open();expect((await screen.findByRole('alert')).textContent).toMatch(/Invalid weekly Bale request/);expect(screen.queryByRole('button',{name:'Review external release'})).toBeNull();
  mock.rpc.mockResolvedValueOnce({data:result,error:null}).mockRejectedValueOnce(new Error('Network lost'));fireEvent.click(screen.getByRole('button',{name:'Load releases'}));await screen.findByText(/Ada.*Site/);
  fireEvent.click(screen.getByRole('button',{name:'Review external release'}));fireEvent.click(screen.getByRole('checkbox',{name:/verified this external release/}));fireEvent.click(screen.getByRole('button',{name:'Record release'}));
  await screen.findByText(/Release not confirmed/);expect(screen.queryByRole('button',{name:'Review external release'})).toBeNull();
 });
});
