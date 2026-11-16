// @vitest-environment jsdom
import React from 'react';
import {act,cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {afterEach,describe,expect,it,vi} from 'vitest';
const mock=vi.hoisted(()=>({rpc:vi.fn()}));
vi.mock('@/lib/supabase/client',()=>({createClient:()=>({rpc:mock.rpc})}));
vi.mock('@/lib/auth/authContext',()=>({useAuth:()=>({user:{id:'founder'},isFounder:true,isSupervisor:false,assurance:'ready'})}));
vi.mock('@/lib/reminders/scheduler',()=>({getManilaClock:()=>({dateIso:'2026-11-18'})}));
vi.mock('@/lib/dates/useManilaToday',()=>({useManilaToday:()=> '2026-11-18'}));
vi.mock('@/components/ui/Modal',()=>({Modal:({isOpen,title,children}:{isOpen:boolean;title:string;children:React.ReactNode})=>isOpen?React.createElement('div',{role:'dialog','aria-label':title},children):null}));
import {SupervisorDayPanel} from '@/components/attendance/SupervisorDayPanel';
import {SupervisorLeavePanel} from '@/components/attendance/SupervisorLeavePanel';
import {SupervisorPayrollPreview} from '@/components/payroll/SupervisorPayrollPreview';
import {usePendingSupervisorLeave} from '@/lib/attendance/usePendingSupervisorLeave';
function Queue(){const state=usePendingSupervisorLeave(true,'founder');return React.createElement('output',null,`Leave queue ${state.status}:${state.count}`);}
afterEach(cleanup);
describe('connected same-tab Supervisor review and planning UI',()=>{
 it('invalidates the loaded estimate on review and refreshes the queue after leave review',async()=>{
  let dayStatus='pending',leaveStatus='pending';
  mock.rpc.mockImplementation(async(name:string)=>{
   if(name==='supervisor_payroll_preview_catalog')return {data:{supervisors:[{id:'sup',name:'Ada'}]},error:null};
   if(name==='supervisor_payroll_preview_inputs')return {data:{supervisor_id:'sup',start:'2026-11-16',end:'2026-11-30',as_of:'2026-11-18',days:[{id:'day',date:'2026-11-16',work_status:'present',status:dayStatus}],leave:leaveStatus==='rejected'?[]:[{id:'leave',start:'2026-11-17',end:'2026-11-17',status:leaveStatus}],identity_needs_review:false,legacy_count:0,overlapping_vouchers:0},error:null};
   if(name==='supervisor_day_list')return {data:{total:1,offset:0,items:[{id:'day',supervisor_name:'Ada',work_date:'2026-11-16',work_status:'present',status:dayStatus,submitted_at:'2026-11-16T00:00:00Z',reviewed_at:dayStatus==='pending'?null:'2026-11-17T00:00:00Z',approved_leave:false,pending_leave:false,legacy_self_records:0,possible_paid_overlap:false,identity_needs_review:false,sites:[]}]},error:null};
   if(name==='review_supervisor_day'){dayStatus='approved';return {data:{id:'day',status:'approved',replayed:false},error:null};}
   if(name==='supervisor_leave_pending_summary')return {data:{pending_count:leaveStatus==='pending'?1:0},error:null};
   if(name==='supervisor_leave_list')return {data:{total:1,offset:0,items:[{id:'leave',supervisor_name:'Ada',start_date:'2026-11-17',end_date:'2026-11-17',kind:'emergency',reason:'',status:leaveStatus,submitted_at:'2026-11-17T00:00:00Z',reviewed_at:leaveStatus==='pending'?null:'2026-11-18T00:00:00Z',possible_paid_overlap:false,identity_needs_review:false}]},error:null};
   if(name==='review_supervisor_leave'){leaveStatus='rejected';return {data:{id:'leave',status:'rejected',replayed:false},error:null};}
   throw Error(`Unexpected RPC ${name}`);
  });
  render(React.createElement(React.Fragment,null,React.createElement(Queue),React.createElement(SupervisorPayrollPreview),React.createElement(SupervisorDayPanel),React.createElement(SupervisorLeavePanel)));await screen.findByText('Leave queue ready:1');
  fireEvent.click(screen.getByRole('button',{name:/Supervisor payroll planning preview/}));fireEvent.click(screen.getByRole('button',{name:'Load Supervisors'}));await screen.findByRole('option',{name:/Ada/});fireEvent.change(screen.getByLabelText('Supervisor'),{target:{value:'sup'}});fireEvent.change(screen.getByLabelText('Illustrative daily rate in pesos'),{target:{value:'600'}});fireEvent.click(screen.getByRole('button',{name:'Load period'}));await screen.findByText(/Pending daily attendance requires review/);expect(screen.getByText(/Pending leave requires review/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:/Supervisor daily attendance/}));fireEvent.click(screen.getByRole('button',{name:'Load daily records'}));await screen.findByText(/Ada · 2026-11-16/);fireEvent.click(screen.getByRole('button',{name:'Approve'}));fireEvent.click(within(screen.getByRole('dialog')).getByRole('button',{name:'Confirm approval'}));await screen.findByText(/Decision recorded/);
  expect(screen.queryByText(/Pending daily attendance requires review/)).toBeNull();expect(screen.getByRole('alert').textContent).toMatch(/Reload the period/);fireEvent.click(screen.getByRole('button',{name:'Load period'}));await screen.findByText(/Pending leave requires review/);expect(screen.queryByText(/Pending daily attendance requires review/)).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:/Supervisor leave requests/}));fireEvent.click(screen.getByRole('button',{name:'Load leave list'}));await screen.findByText(/Ada · emergency · pending/);fireEvent.click(screen.getByRole('button',{name:'Reject'}));fireEvent.click(within(screen.getByRole('dialog')).getByRole('button',{name:'Confirm rejection'}));await screen.findByText('Leave queue ready:0');
  expect(screen.queryByText(/Pending leave requires review/)).toBeNull();expect(screen.getByRole('alert').textContent).toMatch(/Reload the period/);fireEvent.click(screen.getByRole('button',{name:'Load period'}));await screen.findByText(/Illustrative gross: ₱600.00/);
  await act(async()=>{});expect(mock.rpc.mock.calls.some(c=>/payment|payroll_status/.test(c[0]))).toBe(false);
 });
});
