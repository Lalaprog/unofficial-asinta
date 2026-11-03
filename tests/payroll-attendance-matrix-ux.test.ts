// @vitest-environment jsdom
import React from 'react';
import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const mock=vi.hoisted(()=>({rpc:vi.fn(),user:'founder'}));
vi.mock('@/lib/auth/authContext',()=>({useAuth:()=>({user:{id:mock.user},isFounder:true})}));
vi.mock('@/lib/supabase/client',()=>({createClient:()=>({rpc:mock.rpc})}));
import {AttendanceMatrix} from '@/components/payroll/AttendanceMatrix';
const snapshot={workers:[{id:'w',name:'Ada',position:'Mason',active:true,pay_rate:45678,pay_rate_type:'daily'},{id:'n',name:'Unmarked worker',position:'Helper',active:true,pay_rate:12345,pay_rate_type:'hourly'}],projects:[{id:'site',name:'Alpha'},{id:'b',name:'Beta'}],attendance:[{id:'a',worker_id:'w',project_id:'site',date:'2026-01-01',status:'present'},{id:'b',worker_id:'w',project_id:'b',date:'2026-01-01',status:'absent'},{id:'c',worker_id:'w',project_id:'site',date:'2026-01-02',status:'half_day'}],vouchers:[{id:'v',worker_id:'w',gross_pay:98765,net_pay:87654,status:'draft'}]};
const projects=[{id:'site',name:'Alpha',location:'Batangas'}] as never;
function Fixture(){const [start,setStart]=React.useState('2026-01-01'),[end,setEnd]=React.useState('2026-01-02'),[site,setSite]=React.useState('all');return React.createElement(AttendanceMatrix,{start,end,site,setStart,setEnd,setSite,projects});}
const deferred=()=>{let resolve!:(value:unknown)=>void;const promise=new Promise(r=>resolve=r);return {promise,resolve}};
beforeEach(()=>{mock.rpc.mockReset();mock.user='founder'});afterEach(()=>{cleanup();vi.unstubAllGlobals()});
describe('attendance matrix display',()=>{
  it('loads only on request, shows site marks and saved salary in app, and prints only isolated attendance',async()=>{
    mock.rpc.mockResolvedValue({data:snapshot,error:null});
    const write=vi.fn(),print=vi.fn(),focus=vi.fn();const popup={opener:{},document:{open:vi.fn(),write,close:vi.fn()},focus,print};vi.stubGlobal('open',vi.fn(()=>popup));
    render(React.createElement(Fixture));expect(mock.rpc).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:/Payroll-period attendance matrix/}));
    fireEvent.click(screen.getByRole('button',{name:'Load matrix'}));await screen.findByText('Ada');
    expect(mock.rpc).toHaveBeenCalledWith('payroll_attendance_matrix',{p_period_start:'2026-01-01',p_period_end:'2026-01-02',p_project_id:null});
    const row=screen.getByRole('rowheader',{name:/Ada/}).closest('tr')!;expect(within(row).getByText('Present')).toBeTruthy();expect(within(row).getByText('Absent')).toBeTruthy();expect(within(row).getByText('Half day')).toBeTruthy();expect(within(row).getByText(/87,654/)).toBeTruthy();
    expect(screen.getAllByText('Unmarked').length).toBeGreaterThan(0);expect(screen.getByText(/not payroll eligibility or proof of review/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'Print attendance only'}));expect(print).toHaveBeenCalledTimes(1);const html=write.mock.calls[0][0] as string;
    expect(html).toContain('Ada');expect(html).toContain('Alpha');expect(html).not.toContain('45,678');expect(html).not.toContain('45678');expect(html).not.toContain('98765');expect(html).not.toContain('87654');expect(html).not.toContain('Bale');expect(popup.opener).toBeNull();
  });
  it('clears old results and rejects stale responses when period, site or session changes',async()=>{
    const old=deferred(),fresh=deferred();mock.rpc.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const {rerender}=render(React.createElement(Fixture));fireEvent.click(screen.getByRole('button',{name:/Payroll-period attendance matrix/}));fireEvent.click(screen.getByRole('button',{name:'Load matrix'}));
    fireEvent.change(screen.getByLabelText('Matrix project site'),{target:{value:'site'}});fireEvent.click(screen.getByRole('button',{name:'Load matrix'}));
    await act(async()=>{fresh.resolve({data:{...snapshot,attendance:snapshot.attendance.filter(a=>a.project_id==='site')},error:null})});expect(screen.getByText('Ada')).toBeTruthy();
    await act(async()=>{old.resolve({data:{...snapshot,workers:[{...snapshot.workers[0],name:'Stale'}],attendance:[],vouchers:[]},error:null})});expect(screen.queryByText('Stale')).toBeNull();
    mock.user='another';rerender(React.createElement(Fixture));expect(screen.queryByText('Ada')).toBeNull();expect((screen.getByRole('button',{name:'Print attendance only'}) as HTMLButtonElement).disabled).toBe(true);
  });
  it('surfaces errors rather than false emptiness and handles blocked print windows',async()=>{
    mock.rpc.mockResolvedValueOnce({data:null,error:{message:'Function unavailable'}}).mockResolvedValueOnce({data:snapshot,error:null});vi.stubGlobal('open',vi.fn(()=>null));
    render(React.createElement(Fixture));fireEvent.click(screen.getByRole('button',{name:/Payroll-period attendance matrix/}));fireEvent.click(screen.getByRole('button',{name:'Load matrix'}));await screen.findByRole('alert');expect(screen.getByRole('alert').textContent).toMatch(/Function unavailable/);expect(screen.queryByText(/No workers are available/)).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'Load matrix'}));await screen.findByText('Ada');fireEvent.click(screen.getByRole('button',{name:'Print attendance only'}));expect(screen.getByRole('alert').textContent).toMatch(/blocked/i);
  });
  it('fails safely for invalid or overly long dates without querying',async()=>{
    render(React.createElement(Fixture));fireEvent.click(screen.getByRole('button',{name:/Payroll-period attendance matrix/}));fireEvent.change(screen.getByLabelText('Matrix period end'),{target:{value:'2026-05-01'}});fireEvent.click(screen.getByRole('button',{name:'Load matrix'}));await waitFor(()=>expect(screen.getByRole('alert').textContent).toMatch(/93 days/));expect(mock.rpc).not.toHaveBeenCalled();
  });
});
