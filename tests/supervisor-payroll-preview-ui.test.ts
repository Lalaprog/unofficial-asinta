// @vitest-environment jsdom
import React from 'react';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const mock=vi.hoisted(()=>({rpc:vi.fn(),user:'f',founder:true,assurance:'ready',today:'2026-11-18',hookToday:'2026-11-18'}));
vi.mock('@/lib/supabase/client',()=>({createClient:()=>({rpc:mock.rpc})}));
vi.mock('@/lib/auth/authContext',()=>({useAuth:()=>({user:{id:mock.user},isFounder:mock.founder,assurance:mock.assurance})}));
vi.mock('@/lib/reminders/scheduler',()=>({getManilaClock:()=>({dateIso:mock.today})}));
vi.mock('@/lib/dates/useManilaToday',()=>({useManilaToday:()=>mock.hookToday}));
import {SupervisorPayrollPreview} from '@/components/payroll/SupervisorPayrollPreview';
const input={supervisor_id:'s',start:'2026-11-16',end:'2026-11-30',as_of:'2026-11-18',days:[{id:'a',date:'2026-11-16',work_status:'present',status:'approved'},{id:'b',date:'2026-11-17',work_status:'half_day',status:'approved'}],leave:[],identity_needs_review:false,legacy_count:0,overlapping_vouchers:0};
const deferred=()=>{let resolve!:(v:unknown)=>void;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
beforeEach(()=>{mock.rpc.mockReset();mock.user='f';mock.founder=true;mock.assurance='ready';mock.today='2026-11-18';mock.hookToday=mock.today;});afterEach(cleanup);
async function setup(){const view=render(React.createElement(SupervisorPayrollPreview));fireEvent.click(screen.getByRole('button',{name:/Supervisor payroll planning preview/}));fireEvent.click(screen.getByRole('button',{name:'Load Supervisors'}));await screen.findByRole('option',{name:/Ada/});fireEvent.change(screen.getByLabelText('Supervisor'),{target:{value:'s'}});return view;}
describe('Supervisor planning preview UI',()=>{
 it('loads explicitly and shows an illustrative rate and period, never a payment action',async()=>{
  mock.rpc.mockResolvedValueOnce({data:{supervisors:[{id:'s',name:'Ada'}]},error:null}).mockResolvedValueOnce({data:input,error:null});await setup();
  fireEvent.change(screen.getByLabelText('Illustrative daily rate in pesos'),{target:{value:'655.55'}});fireEvent.click(screen.getByRole('button',{name:'Load period'}));
  await screen.findByText(/Illustrative gross: ₱983.33 · 1.5 approved/);expect(screen.getByText(/2026-11-16 to 2026-11-30 · normally paid/)).toBeTruthy();
  expect(screen.getByText('Unmarked · today')).toBeTruthy();expect(screen.getByText(/Read-only planning aid/)).toBeTruthy();expect(screen.queryByRole('button',{name:/^(pay|approve|save|mark paid)/i})).toBeNull();
  expect(mock.rpc.mock.calls.map(c=>c[0])).toEqual(['supervisor_payroll_preview_catalog','supervisor_payroll_preview_inputs']);
 });
 it('withholds estimate when a paid-history signal exists',async()=>{
  mock.rpc.mockResolvedValueOnce({data:{supervisors:[{id:'s',name:'Ada'}]},error:null}).mockResolvedValueOnce({data:{...input,overlapping_vouchers:1},error:null});await setup();fireEvent.change(screen.getByLabelText('Illustrative daily rate in pesos'),{target:{value:'600'}});fireEvent.click(screen.getByRole('button',{name:'Load period'}));
  await screen.findByText(/Illustrative gross unavailable/);expect(screen.getByText(/Possible overlapping payroll voucher requires review/)).toBeTruthy();
 });
 it('clears sensitive previews on assurance loss and refuses to reload until restored',async()=>{
  mock.rpc.mockResolvedValueOnce({data:{supervisors:[{id:'s',name:'Ada'}]},error:null}).mockResolvedValueOnce({data:input,error:null});const view=await setup();fireEvent.change(screen.getByLabelText('Illustrative daily rate in pesos'),{target:{value:'600'}});fireEvent.click(screen.getByRole('button',{name:'Load period'}));await screen.findByText(/Illustrative gross: ₱900.00/);
  mock.assurance='required';view.rerender(React.createElement(SupervisorPayrollPreview));
  expect(screen.queryByText(/Illustrative gross:/)).toBeNull();expect((screen.getByRole('button',{name:'Load Supervisors'}) as HTMLButtonElement).disabled).toBe(true);expect(mock.rpc).toHaveBeenCalledTimes(2);
 });
 it('invalidates late responses and loaded amounts at the Manila day boundary',async()=>{
  const old=deferred();mock.rpc.mockResolvedValueOnce({data:{supervisors:[{id:'s',name:'Ada'}]},error:null}).mockReturnValueOnce(old.promise).mockResolvedValueOnce({data:{...input,as_of:'2026-11-19'},error:null});const view=await setup();fireEvent.click(screen.getByRole('button',{name:'Load period'}));mock.today='2026-11-19';await act(async()=>old.resolve({data:input,error:null}));expect((await screen.findByRole('alert')).textContent).toMatch(/date changed/i);expect(screen.queryByText(/Illustrative gross:/)).toBeNull();
  mock.hookToday=mock.today;view.rerender(React.createElement(SupervisorPayrollPreview));expect(screen.queryByRole('alert')).toBeNull();fireEvent.change(screen.getByLabelText('Illustrative daily rate in pesos'),{target:{value:'600'}});fireEvent.click(screen.getByRole('button',{name:'Load period'}));await screen.findByText(/Illustrative gross: ₱900.00/);mock.today='2026-11-20';mock.hookToday=mock.today;view.rerender(React.createElement(SupervisorPayrollPreview));expect(screen.queryByText(/Illustrative gross:/)).toBeNull();
 });
 it('invalidates both loaded and in-flight estimates on same-tab attendance or leave changes',async()=>{
  const late=deferred();mock.rpc.mockResolvedValueOnce({data:{supervisors:[{id:'s',name:'Ada'}]},error:null}).mockResolvedValueOnce({data:input,error:null}).mockReturnValueOnce(late.promise);await setup();fireEvent.change(screen.getByLabelText('Illustrative daily rate in pesos'),{target:{value:'600'}});fireEvent.click(screen.getByRole('button',{name:'Load period'}));await screen.findByText(/Illustrative gross: ₱900.00/);
  act(()=>window.dispatchEvent(new Event('asinta:supervisor-day-changed')));expect(screen.queryByText(/Illustrative gross:/)).toBeNull();expect(screen.getByRole('alert').textContent).toMatch(/Reload the period/);fireEvent.click(screen.getByRole('button',{name:'Load period'}));act(()=>window.dispatchEvent(new Event('asinta:supervisor-leave-changed')));await act(async()=>late.resolve({data:input,error:null}));expect(screen.queryByText(/Illustrative gross:/)).toBeNull();expect(screen.getByRole('alert').textContent).toMatch(/Reload the period/);
 });
 it('discards a late period response after a change and shows errors',async()=>{
  const old=deferred();mock.rpc.mockResolvedValueOnce({data:{supervisors:[{id:'s',name:'Ada'}]},error:null}).mockReturnValueOnce(old.promise).mockResolvedValueOnce({data:null,error:{message:'Not installed'}});await setup();
  fireEvent.click(screen.getByRole('button',{name:'Load period'}));fireEvent.change(screen.getByLabelText('Date in Supervisor period'),{target:{value:'2026-11-05'}});fireEvent.click(screen.getByRole('button',{name:'Load period'}));
  expect((await screen.findByRole('alert')).textContent).toContain('Not installed');await act(async()=>old.resolve({data:input,error:null}));expect(screen.queryByText(/Illustrative gross/)).toBeNull();
 });
});
