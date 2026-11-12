// @vitest-environment jsdom
import React from 'react';
import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const mock=vi.hoisted(()=>({founder:false,rpc:vi.fn()}));
vi.mock('@/lib/supabase/client',()=>({createClient:()=>({rpc:mock.rpc})}));
vi.mock('@/lib/auth/authContext',()=>({useAuth:()=>({user:{id:mock.founder?'founder':'sup'},isFounder:mock.founder,isSupervisor:!mock.founder})}));
vi.mock('@/components/ui/Modal',()=>({Modal:({isOpen,title,description,children}:{isOpen:boolean;title:string;description:string;children:React.ReactNode})=>isOpen?React.createElement('div',{role:'dialog','aria-label':title},React.createElement('p',null,description),children):null}));
import {SupervisorLeavePanel} from '@/components/attendance/SupervisorLeavePanel';
import {parseSupervisorLeaveList} from '@/lib/attendance/supervisorLeave';
const item={id:'request',supervisor_name:'Ada',start_date:'2020-01-01',end_date:'2020-01-02',kind:'emergency',reason:'Urgent',status:'pending',submitted_at:'2020-01-02T00:00:00Z',reviewed_at:null,possible_paid_overlap:true,identity_needs_review:true};
beforeEach(()=>{mock.founder=false;mock.rpc.mockReset();});afterEach(cleanup);
describe('Supervisor leave UI',()=>{
 it('requires a loaded list, sends emergency leave, and reuses an unchanged request ID after an ambiguous error',async()=>{
  mock.rpc.mockImplementation(async(name:string,p:Record<string,string>)=>name==='supervisor_leave_list'?{data:{total:0,offset:0,items:[]},error:null}:mock.rpc.mock.calls.filter(c=>c[0]==='submit_supervisor_leave').length===1?{data:null,error:{message:'Connection lost'}}:{data:{id:p.p_id,status:'pending',replayed:true},error:null});
  render(React.createElement(SupervisorLeavePanel));fireEvent.click(screen.getByRole('button',{name:/Supervisor leave requests/}));
  expect(screen.getByText(/does not update attendance or payroll yet/)).toBeTruthy();expect(screen.queryByRole('button',{name:'Submit leave request'})).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'Load leave list'}));await screen.findByText('No leave requests found.');
  fireEvent.change(screen.getByLabelText('First day'),{target:{value:'2020-01-01'}});fireEvent.change(screen.getByLabelText('Last day'),{target:{value:'2020-01-02'}});fireEvent.change(screen.getByLabelText('Leave type'),{target:{value:'emergency'}});
  fireEvent.click(screen.getByRole('button',{name:'Submit leave request'}));await screen.findByText(/Submission not confirmed/);
  fireEvent.click(screen.getByRole('button',{name:'Submit leave request'}));await screen.findByText(/Request recorded as pending/);
  const calls=mock.rpc.mock.calls.filter(c=>c[0]==='submit_supervisor_leave');expect(calls).toHaveLength(2);expect(calls[0][1].p_id).toBe(calls[1][1].p_id);expect(calls[0][1]).toMatchObject({p_kind:'emergency',p_start:'2020-01-01',p_end:'2020-01-02'});
 });
 it('shows possible paid overlap to Founder and requires explicit confirmation',async()=>{
  mock.founder=true;mock.rpc.mockResolvedValueOnce({data:{total:1,offset:0,items:[item]},error:null}).mockResolvedValueOnce({data:{id:'request',status:'approved',replayed:false},error:null});
  const changed=vi.fn();window.addEventListener('asinta:supervisor-leave-changed',changed);
  render(React.createElement(SupervisorLeavePanel));fireEvent.click(screen.getByRole('button',{name:/Supervisor leave requests/}));fireEvent.click(screen.getByRole('button',{name:'Load leave list'}));await screen.findByText(/Possible paid payroll overlap: review/);
  expect(screen.getByText(/identity may not match/)).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:'Approve'}));const dialog=screen.getByRole('dialog');expect(within(dialog).getByText(/does not change attendance or payroll/)).toBeTruthy();expect(mock.rpc).toHaveBeenCalledTimes(1);
  fireEvent.click(within(dialog).getByRole('button',{name:'Confirm approval'}));await screen.findByText(/Decision recorded/);expect(mock.rpc).toHaveBeenLastCalledWith('review_supervisor_leave',{p_id:'request',p_decision:'approved'});expect(changed).toHaveBeenCalledTimes(1);window.removeEventListener('asinta:supervisor-leave-changed',changed);
 });
 it('loads subsequent pages rather than hiding requests beyond the first hundred',async()=>{
  const first=Array.from({length:100},(_,i)=>({...item,id:`row-${i}`}));
  mock.founder=true;mock.rpc.mockImplementation(async(_name:string,p:{p_offset:number})=>({data:p.p_offset===0?{total:101,offset:0,items:first}:{total:101,offset:100,items:[{...item,id:'last',supervisor_name:'Last Supervisor'}]},error:null}));
  render(React.createElement(SupervisorLeavePanel));fireEvent.click(screen.getByRole('button',{name:/Supervisor leave requests/}));fireEvent.click(screen.getByRole('button',{name:'Load leave list'}));await screen.findByText(/Showing 1–100 of 101/);
  fireEvent.click(screen.getByRole('button',{name:'Next requests'}));await screen.findByText(/Last Supervisor/);expect(mock.rpc).toHaveBeenLastCalledWith('supervisor_leave_list',{p_offset:100});
 });
 it('does not show a previous account’s late response',async()=>{
  let resolve!:(value:unknown)=>void;mock.rpc.mockImplementation(()=>new Promise(r=>{resolve=r;}));
  const view=render(React.createElement(SupervisorLeavePanel));fireEvent.click(screen.getByRole('button',{name:/Supervisor leave requests/}));fireEvent.click(screen.getByRole('button',{name:'Load leave list'}));
  mock.founder=true;view.rerender(React.createElement(SupervisorLeavePanel));
  await act(async()=>resolve({data:{total:1,offset:0,items:[{...item,possible_paid_overlap:null,identity_needs_review:null}]},error:null}));
  expect(screen.queryByText(/Ada · emergency/)).toBeNull();
 });
 it('fails closed on incomplete responses or invalid review context',async()=>{
  mock.rpc.mockResolvedValue({data:{total:2,offset:0,items:[]},error:null});render(React.createElement(SupervisorLeavePanel));fireEvent.click(screen.getByRole('button',{name:/Supervisor leave requests/}));fireEvent.click(screen.getByRole('button',{name:'Load leave list'}));await screen.findByRole('alert');expect(screen.queryByRole('button',{name:'Submit leave request'})).toBeNull();
  expect(()=>parseSupervisorLeaveList({total:1,offset:0,items:[item]},false)).toThrow(/review context/);
  await waitFor(()=>expect(mock.rpc).toHaveBeenCalledTimes(1));
 });
});
