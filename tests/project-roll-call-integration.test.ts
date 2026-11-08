// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ noProjects: false, record: vi.fn(async (_rows: unknown) => true), fetch: vi.fn(), rpc: vi.fn(), toast: vi.fn() }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock('next/link', () => ({default: ({children,prefetch:_prefetch,...props}: React.AnchorHTMLAttributes<HTMLAnchorElement>&{prefetch?:boolean}) => React.createElement('a',props,children)}));
vi.mock('@/components/layout/AppShell', () => ({AppShell:({children}:{children:React.ReactNode})=>children}));
vi.mock('@/lib/dates/useManilaToday', () => ({useManilaToday:()=>'2026-10-01'}));
vi.mock('@/lib/auth/authContext', () => ({useAuth:()=>({user:{id:'sup',name:'Supervisor',role:'supervisor'},isFounder:false,isSupervisor:true,assurance:'ready',isLoading:false})}));
vi.mock('@/lib/attendance/usePendingApprovals', () => ({usePendingApprovals:()=>({items:[],total:0,hasMore:false,loading:false,error:null,loadMore:vi.fn(),refresh:vi.fn()})}));
vi.mock('@/components/ui/Toast', () => ({useToast:()=>({showToast:mock.toast})}));
vi.mock('@/lib/supabase/client',()=>({createClient:()=>({rpc:mock.rpc})}));
vi.mock('@/lib/data/store', () => {
  const workers = [
    {id:'sup',name:'Supervisor',position:'Site Supervisor',active:true,pay_rate:1000,pay_rate_type:'daily',contact_number:'—'},
    {id:'amy',name:'Amy',position:'Mason',active:true,pay_rate:800,pay_rate_type:'daily',contact_number:'—'},
    {id:'ben',name:'Ben',position:'Carpenter',active:true,pay_rate:800,pay_rate_type:'daily',contact_number:'—'},
  ];
  const projects=[{id:'site',name:'Test Site',location:'Batangas'}];
  const store={users:[{id:'sup',name:'Supervisor',role:'supervisor'}],workers,projects,projectSupervisors:[{project_id:'site',supervisor_id:'sup'}],attendance:[],isLoaded:true,loadError:null,refresh:vi.fn(),createWorker:vi.fn(),updateWorker:vi.fn(),toggleWorkerStatus:vi.fn(),recordAttendanceBatch:mock.record,updateAttendanceRecord:vi.fn(),getProjectsForSupervisor:()=>mock.noProjects ? [] : projects};
  return {useDataStore:()=>store};
});
import AttendancePage from '@/app/attendance/page';
const saved = {id:'1',worker_id:'ben',project_id:'site',date:'2026-10-01',status:'half_day',hours_worked:4,notes:'prior',recorded_by:'founder',is_founder_override:false,submitted_at:'now',created_at:'now',worker_name:'Ben',worker_position:'Carpenter',project_name:'Test Site',is_supervisor:false};
beforeEach(()=>{
  mock.noProjects=false; localStorage.clear(); window.history.replaceState({},'','/attendance');
  mock.fetch.mockReset().mockResolvedValue({ok:true,json:async()=>({workerIds:['amy']})});
  mock.rpc.mockReset().mockResolvedValue({data:{items:[saved],has_more:false},error:null});
  mock.record.mockReset().mockResolvedValue(true); mock.toast.mockClear(); vi.stubGlobal('fetch',mock.fetch);
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});

describe('project Roll Call data flow',()=>{
  it('loads team and saved attendance, then rechecks before writing only new rows',async()=>{
    render(React.createElement(AttendancePage));
    const amy = await screen.findByRole('group',{name:'Attendance status for Amy'});
    expect(screen.getByRole('group',{name:'Attendance status for Ben'})).toBeTruthy();
    expect(mock.record).not.toHaveBeenCalled();
    fireEvent.click(within(amy).getByRole('button',{name:'Present'}));
    fireEvent.click(screen.getByRole('button',{name:'Save Changes'}));
    await waitFor(()=>expect(mock.record).toHaveBeenCalledOnce());
    const rows=mock.record.mock.calls[0][0] as Array<{worker_id:string}>;
    expect(rows.map(row=>row.worker_id).sort()).toEqual(['amy','sup']);
    expect(mock.fetch.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(mock.rpc.mock.calls.length).toBeGreaterThanOrEqual(2);
    await waitFor(()=>expect(mock.toast).toHaveBeenCalledWith('success',expect.any(String)));
  });  it('does not request a global project when the Supervisor has no assigned sites', () => {
    mock.noProjects=true;
    render(React.createElement(AttendancePage));
    expect(screen.getByText('Choose an available project to see its Roll Call.')).toBeTruthy();
    expect(mock.fetch).not.toHaveBeenCalled();
    expect(mock.record).not.toHaveBeenCalled();
  });
  it('does not submit twice while the freshness check is in flight',async()=>{
    let finish!: (value: unknown) => void;
    mock.fetch.mockImplementationOnce(async()=>({ok:true,json:async()=>({workerIds:['amy']})}))
      .mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
    render(React.createElement(AttendancePage));
    const amy = await screen.findByRole('group',{name:'Attendance status for Amy'});
    fireEvent.click(within(amy).getByRole('button',{name:'Present'}));
    const submit=screen.getByRole('button',{name:'Save Changes'});
    const form=submit.closest('form')!;
    fireEvent.submit(form); fireEvent.submit(form);
    expect(mock.fetch).toHaveBeenCalledTimes(2);
    finish({ok:true,json:async()=>({workerIds:['amy']})});
    await waitFor(()=>expect(mock.record).toHaveBeenCalledOnce());
    await waitFor(()=>expect(mock.toast).toHaveBeenCalledWith('success',expect.any(String)));
  });

});
