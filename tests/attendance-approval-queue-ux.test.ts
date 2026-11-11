// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({rpc:vi.fn(), update:vi.fn(), toast:vi.fn(), founder:true}));
vi.mock('@/lib/attendance/useAttendanceHistory', () => ({useAttendanceHistory: () => ({items:[], hasMore:false, loading:false, error:null, loadMore:vi.fn(), retry:vi.fn()})}));
vi.mock('next/navigation', () => ({useSearchParams: () => new URLSearchParams('tab=history')}));
vi.mock('next/link', () => ({default: ({children,href,prefetch: _prefetch,...props}: React.AnchorHTMLAttributes<HTMLAnchorElement> & {prefetch?: boolean}) => React.createElement('a',{href,...props},children)}));
vi.mock('@/components/layout/AppShell', () => ({AppShell: ({children}: {children:React.ReactNode}) => React.createElement('main',null,children)}));
vi.mock('@/components/ui/Toast', () => ({useToast: () => ({showToast:mock.toast})}));
vi.mock('@/lib/auth/authContext', () => {
  const founder={id:'f',name:'Founder',role:'founder'}, supervisor={id:'s',name:'Supervisor',role:'supervisor'};
  return {useAuth: () => ({user:mock.founder?founder:supervisor,isFounder:mock.founder,isSupervisor:!mock.founder})};
});
vi.mock('@/lib/supabase/client', () => ({createClient: () => ({rpc:(name:string, args:unknown) => name === 'attendance_history_calendar' ? Promise.resolve({data:[],error:null}) : mock.rpc(name,args)})}));
vi.mock('@/lib/data/store', () => {
  const projects=[{id:'site',name:'Alpha',location:'Batangas, PH'}];
  const store={users:[], workers:[], projects, projectSupervisors:[], attendance:[], isLoaded:true, createWorker:vi.fn(), updateWorker:vi.fn(), toggleWorkerStatus:vi.fn(), recordAttendanceBatch:vi.fn(), updateAttendanceRecord:mock.update, getProjectsForSupervisor:()=>projects};
  return {useDataStore:()=>store};
});
vi.mock('@/lib/attendance/useProjectRollCall', () => ({ useProjectRollCall: () => ({ status: 'loading', snapshot: null, reload: vi.fn() }) }));
import AttendancePage from '@/app/attendance/page';
const rec=(id:string)=>({id,worker_id:'s',worker_name:`Supervisor ${id}`,worker_position:'Site Supervisor',project_id:'site',project_name:'Alpha',date:'2024-01-01',status:'present',hours_worked:8,notes:'Pending Founder Review',recorded_by:'s',is_founder_override:false});
const response=(items: ReturnType<typeof rec>[], total:number, has_more:boolean)=>({data:{items,total,has_more},error:null});
beforeEach(()=>{ mock.founder=true; mock.rpc.mockReset(); mock.update.mockReset(); mock.toast.mockReset(); window.localStorage.clear(); window.history.replaceState({},'','/attendance?tab=history'); });
afterEach(()=>cleanup());

describe('Founder server-backed approval banner',()=>{
  it('shows old server rows missing from the shared store, pages independently of history filters, and refreshes after review',async()=>{
    mock.rpc.mockResolvedValueOnce(response([rec('a'),rec('b'),rec('c')],4,true))
      .mockResolvedValueOnce(response([rec('d')],4,false))
      .mockResolvedValueOnce(response([rec('b')],1,false));
    mock.update.mockResolvedValue(true);
    render(React.createElement(AttendancePage));
    await screen.findByText('Supervisor approvals (4 pending)');
    expect(screen.getByText('Supervisor a')).toBeTruthy();
    fireEvent.change(screen.getAllByLabelText('Search attendance history')[0],{target:{value:'nothing here'}});
    expect(screen.getByText('Supervisor approvals (4 pending)')).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'Show more pending approvals'}));
    await screen.findByText('Supervisor d');
    await act(async()=>{fireEvent.click(screen.getAllByRole('button',{name:'Approve Full Day'})[0]);});
    expect(mock.update).toHaveBeenCalledWith('a',expect.objectContaining({status:'present',hours_worked:8}),true);
    await screen.findByText('Supervisor approvals (1 pending)');
    expect(screen.queryByText('Supervisor a')).toBeNull();
  });
  it('blocks duplicate review submissions while the first is in flight',async()=>{
    mock.rpc.mockResolvedValue(response([rec('a')],1,false));
    let resolve!: (ok: boolean) => void;
    mock.update.mockReturnValue(new Promise<boolean>((r) => {resolve = r;}));
    render(React.createElement(AttendancePage));
    const button = await screen.findByRole('button',{name:'Approve Full Day'});
    fireEvent.click(button); fireEvent.click(button);
    expect(mock.update).toHaveBeenCalledTimes(1);
    expect(button.hasAttribute('disabled')).toBe(true);
    await act(async()=>{resolve(true);});
  });
  it('exposes an RPC error and retry instead of claiming the queue is empty',async()=>{
    mock.rpc.mockResolvedValueOnce({data:null,error:{message:'missing function'}}).mockResolvedValueOnce(response([],0,false));
    render(React.createElement(AttendancePage));
    await screen.findByRole('alert');
    expect(screen.queryByText('No pending supervisor approvals at last check.')).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'Retry approvals'}));
    await screen.findByText('No pending supervisor approvals at last check.');
    expect(screen.getByRole('button',{name:'Refresh approvals'})).toBeTruthy();
  });
  it('does not query or display the Founder queue for a Supervisor',async()=>{
    mock.founder=false;
    render(React.createElement(AttendancePage));
    await waitFor(()=>expect(screen.getByText('No attendance records match')).toBeTruthy());
    expect(mock.rpc).not.toHaveBeenCalled();
    expect(screen.queryByText(/Supervisor approvals/)).toBeNull();
  });
});
