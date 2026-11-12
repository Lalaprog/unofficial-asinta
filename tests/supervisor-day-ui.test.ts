// @vitest-environment jsdom
import React from 'react';
import {act,cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const mock=vi.hoisted(()=>({founder:false,rpc:vi.fn()}));
vi.mock('@/lib/supabase/client',()=>({createClient:()=>({rpc:mock.rpc})}));
vi.mock('@/lib/auth/authContext',()=>({useAuth:()=>({user:{id:mock.founder?'founder':'supervisor'},isFounder:mock.founder,isSupervisor:!mock.founder})}));
vi.mock('@/components/ui/Modal',()=>({Modal:({isOpen,title,description,children}:{isOpen:boolean;title:string;description:string;children:React.ReactNode})=>isOpen?React.createElement('div',{role:'dialog','aria-label':title},React.createElement('p',null,description),children):null}));
import {SupervisorDayPanel} from '@/components/attendance/SupervisorDayPanel';
import {parseSupervisorDayList} from '@/lib/attendance/supervisorDay';
const item={id:'request',supervisor_name:'Ada',work_date:'2020-01-01',work_status:'present',status:'pending',submitted_at:'2020-01-01T12:00:00Z',reviewed_at:null,approved_leave:false,pending_leave:false,legacy_self_records:1,possible_paid_overlap:true,identity_needs_review:false,sites:[{id:'a',name:'Site A',has_entries:false},{id:'b',name:'Site B',has_entries:true}]};
beforeEach(()=>{mock.founder=false;mock.rpc.mockReset();});afterEach(cleanup);
describe('Supervisor daily attendance UI',()=>{
 it('submits one general daily record and keeps the same retry ID after an ambiguous failure',async()=>{
  mock.rpc.mockImplementation(async(name:string,p:Record<string,string>)=>name==='supervisor_day_list'?{data:{total:0,offset:0,items:[]},error:null}:mock.rpc.mock.calls.filter(c=>c[0]==='submit_supervisor_day').length===1?{data:null,error:{message:'Connection lost'}}:{data:{id:p.p_id,status:'pending',replayed:true},error:null});
  render(React.createElement(SupervisorDayPanel));fireEvent.click(screen.getByRole('button',{name:/Supervisor daily attendance/}));expect(screen.getByText(/not used by payroll yet/)).toBeTruthy();expect(screen.queryByRole('button',{name:'Submit daily record'})).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'Load daily records'}));await screen.findByText('No daily records found.');fireEvent.change(screen.getByLabelText('Work date'),{target:{value:'2020-01-01'}});fireEvent.change(screen.getByLabelText('Work status'),{target:{value:'half_day'}});
  fireEvent.click(screen.getByRole('button',{name:'Submit daily record'}));await screen.findByText(/Submission not confirmed/);fireEvent.click(screen.getByRole('button',{name:'Submit daily record'}));await screen.findByText(/Daily record is pending/);
  const calls=mock.rpc.mock.calls.filter(c=>c[0]==='submit_supervisor_day');expect(calls).toHaveLength(2);expect(calls[0][1].p_id).toBe(calls[1][1].p_id);expect(calls[0][1]).toMatchObject({p_date:'2020-01-01',p_work_status:'half_day'});
 });
 it('shows site evidence and warnings but permits Founder approval with a missing Roll Call',async()=>{
  mock.founder=true;mock.rpc.mockResolvedValueOnce({data:{total:1,offset:0,items:[item]},error:null}).mockResolvedValueOnce({data:{id:'request',status:'approved',replayed:false},error:null});
  render(React.createElement(SupervisorDayPanel));fireEvent.click(screen.getByRole('button',{name:/Supervisor daily attendance/}));fireEvent.click(screen.getByRole('button',{name:'Load daily records'}));await screen.findByText(/Site A: no entries found/);
  expect(screen.getByText(/Legacy self-attendance exists/)).toBeTruthy();expect(screen.getByText(/Possible paid payroll overlap. Review/)).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:'Approve'}));const dialog=screen.getByRole('dialog');expect(within(dialog).getByText(/does not change site attendance or payroll/)).toBeTruthy();expect(mock.rpc).toHaveBeenCalledTimes(1);
  fireEvent.click(within(dialog).getByRole('button',{name:'Confirm approval'}));await screen.findByText(/Decision recorded/);expect(mock.rpc).toHaveBeenLastCalledWith('review_supervisor_day',{p_id:'request',p_decision:'approved'});
 });
 it('blocks conflicting approved leave and fails closed on an incomplete response',async()=>{
  mock.founder=true;mock.rpc.mockResolvedValueOnce({data:{total:1,offset:0,items:[{...item,approved_leave:true}]},error:null});
  const view=render(React.createElement(SupervisorDayPanel));fireEvent.click(screen.getByRole('button',{name:/Supervisor daily attendance/}));fireEvent.click(screen.getByRole('button',{name:'Load daily records'}));await screen.findByText(/attendance approval is blocked/);expect((screen.getByRole('button',{name:'Approve'}) as HTMLButtonElement).disabled).toBe(true);
  view.unmount();mock.founder=false;mock.rpc.mockResolvedValueOnce({data:{total:2,offset:0,items:[]},error:null});render(React.createElement(SupervisorDayPanel));fireEvent.click(screen.getByRole('button',{name:/Supervisor daily attendance/}));fireEvent.click(screen.getByRole('button',{name:'Load daily records'}));await screen.findByRole('alert');expect(screen.queryByRole('button',{name:'Submit daily record'})).toBeNull();
  expect(()=>parseSupervisorDayList({total:1,offset:0,items:[item]},false)).toThrow(/review context/);
 });
 it('does not show late responses from a previous account',async()=>{
  let resolve!:(value:unknown)=>void;mock.rpc.mockImplementation(()=>new Promise(r=>{resolve=r;}));const view=render(React.createElement(SupervisorDayPanel));fireEvent.click(screen.getByRole('button',{name:/Supervisor daily attendance/}));fireEvent.click(screen.getByRole('button',{name:'Load daily records'}));mock.founder=true;view.rerender(React.createElement(SupervisorDayPanel));await act(async()=>resolve({data:{total:1,offset:0,items:[{...item,legacy_self_records:null,possible_paid_overlap:null,identity_needs_review:null}]},error:null}));expect(screen.queryByText(/Ada · 2020/)).toBeNull();
 });
});
