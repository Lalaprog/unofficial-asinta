// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams('tab=workforce') }));
vi.mock('next/link', () => ({ default: ({ children, prefetch: _prefetch, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & {prefetch?:boolean}) => React.createElement('a', props, children) }));
vi.mock('@/components/layout/AppShell', () => ({ AppShell: ({children}:{children:React.ReactNode}) => children }));
vi.mock('@/lib/auth/authContext', () => ({ useAuth: () => ({ user:{id:'sup',name:'Supervisor',role:'supervisor'},isFounder:false,isSupervisor:true,assurance:'ready',isLoading:false }) }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({showToast:vi.fn()}) }));
vi.mock('@/lib/attendance/usePendingApprovals', () => ({ usePendingApprovals: () => ({items:[],total:0,hasMore:false,loading:false,error:null,loadMore:vi.fn(),refresh:vi.fn()}) }));
vi.mock('@/lib/attendance/useProjectRollCall', () => ({ useProjectRollCall: () => ({status:'loading',snapshot:null,reload:vi.fn()}) }));
vi.mock('@/lib/data/store', () => {
  const projects=[{id:'alpha',name:'Alpha',location:'A'},{id:'beta',name:'Beta',location:'B'}];
  const makeWorker=(id:string,name:string)=>({id,name,position:'Mason',active:true,pay_rate:600,pay_rate_type:'daily',contact_number:'—'});
  const workers=[makeWorker('amy','Amy Alpha'),makeWorker('ben','Ben Beta'),makeWorker('free','Unassigned Person'),makeWorker('sup','Supervisor')];
  const store={users:[{id:'sup',name:'Supervisor',role:'supervisor'}],workers,projects,projectSupervisors:[{project_id:'alpha',supervisor_id:'sup'},{project_id:'beta',supervisor_id:'sup'}],attendance:[],isLoaded:true,loadError:null,refresh:vi.fn(),createWorker:vi.fn(),updateWorker:vi.fn(),toggleWorkerStatus:vi.fn(),recordAttendanceBatch:vi.fn(),updateAttendanceRecord:vi.fn(),getProjectsForSupervisor:()=>projects};
  return {useDataStore:()=>store};
});
import AttendancePage from '@/app/attendance/page';

beforeEach(()=>{
  window.localStorage.clear();
  state.fetch.mockReset().mockImplementation(async (url:string) => ({ok:true,json:async()=>({workerIds:String(url).includes('/alpha/')?['amy','sup']:['ben']})}));
  vi.stubGlobal('fetch',state.fetch);
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});

describe('Supervisor project workforce scope',()=>{
  it('shows only workers assigned to the selected site and excludes the Supervisor and unassigned workers',async()=>{
    render(React.createElement(AttendancePage));
    await screen.findByText('Amy Alpha');
    expect(screen.queryByText('Ben Beta')).toBeNull();
    expect(screen.queryByText('Unassigned Person')).toBeNull();
    expect(screen.queryByText('Supervisor')).toBeNull();
    expect(screen.getByText('1 active / 1 in workforce')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Workforce project'),{target:{value:'beta'}});
    await screen.findByText('Ben Beta');
    expect(screen.queryByText('Amy Alpha')).toBeNull();
    expect(screen.queryByText('Unassigned Person')).toBeNull();
    expect(state.fetch.mock.calls.every((call)=>!String(call[0]).includes('view=available'))).toBe(true);
  });
  it('does not display an empty or previous site on failure or late responses',async()=>{
    let finishAlpha!:(value:unknown)=>void;
    state.fetch.mockImplementation((url:string)=>String(url).includes('/alpha/')
      ? new Promise(resolve=>{finishAlpha=resolve;})
      : Promise.resolve({ok:false,json:async()=>({})}));
    render(React.createElement(AttendancePage));
    await waitFor(()=>expect(finishAlpha).toBeDefined());
    fireEvent.change(screen.getByLabelText('Workforce project'),{target:{value:'beta'}});
    await screen.findByText(/Could not load this project's workforce/);
    finishAlpha({ok:true,json:async()=>({workerIds:['amy']})});
    await waitFor(()=>expect(screen.queryByText('Amy Alpha')).toBeNull());
    expect(screen.queryByText('No workers match')).toBeNull();
  });
});
