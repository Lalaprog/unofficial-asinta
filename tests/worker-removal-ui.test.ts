// @vitest-environment jsdom
import React from 'react';
import { cleanup,fireEvent,render,screen,waitFor,within } from '@testing-library/react';
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
const ids=['10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000002'];
const mock=vi.hoisted(()=>({founder:true, fetch:vi.fn(),refresh:vi.fn(async()=>{}),toast:vi.fn()}));
vi.mock('next/navigation',()=>({useSearchParams:()=>new URLSearchParams('tab=workforce')}));
vi.mock('next/link',()=>({default:({children,prefetch:_prefetch,...props}:React.AnchorHTMLAttributes<HTMLAnchorElement>&{prefetch?:boolean})=>React.createElement('a',props,children)}));
vi.mock('@/components/layout/AppShell',()=>({AppShell:({children}:{children:React.ReactNode})=>children}));
vi.mock('@/lib/auth/authContext',()=>({useAuth:()=>({user:{id:'founder',name:'Founder'},isFounder:mock.founder,isSupervisor:!mock.founder,assurance:'ready',isLoading:false})}));
vi.mock('@/components/ui/Toast',()=>({useToast:()=>({showToast:mock.toast})}));
vi.mock('@/lib/attendance/usePendingApprovals',()=>({usePendingApprovals:()=>({items:[],total:0,hasMore:false,loading:false,error:null,refresh:vi.fn(),loadMore:vi.fn()})}));
vi.mock('@/lib/attendance/useProjectRollCall',()=>({useProjectRollCall:()=>({status:'loading',snapshot:null,reload:vi.fn()})}));
vi.mock('@/lib/data/store',()=>{
  const workers=[{id:'10000000-0000-0000-0000-000000000001',name:'Amy',position:'Mason',active:true,pay_rate:850,pay_rate_type:'daily',contact_number:'—'},{id:'20000000-0000-0000-0000-000000000002',name:'Ben',position:'Mason',active:false,pay_rate:850,pay_rate_type:'daily',contact_number:'—'}];
  return {useDataStore:()=>({workers,projects:[],users:[],projectSupervisors:[],attendance:[],isLoaded:true,loadError:null,refresh:mock.refresh,createWorker:vi.fn(),updateWorker:vi.fn(),toggleWorkerStatus:vi.fn(),recordAttendanceBatch:vi.fn(),updateAttendanceRecord:vi.fn(),getProjectsForSupervisor:()=>[]})};
});
import AttendancePage from '@/app/attendance/page';
beforeEach(()=>{mock.founder=true;mock.fetch.mockReset();mock.refresh.mockClear();mock.toast.mockClear();vi.stubGlobal('fetch',mock.fetch);window.history.replaceState({},'','/attendance?tab=workforce');localStorage.clear();});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
describe('workforce removal',()=>{
  it('selects active and inactive workers, reviews names and reports protected history',async()=>{
    mock.fetch.mockResolvedValue({ok:true,json:async()=>({ok:true,results:[{id:ids[0],status:'deleted'},{id:ids[1],status:'linked',reasons:['Attendance','Payroll']}]})});
    render(React.createElement(AttendancePage));
    expect(screen.queryByText('Ben')).toBeNull();
    expect((screen.getByLabelText('Filter workforce by status') as HTMLSelectElement).value).toBe('active');
    fireEvent.click(screen.getByRole('checkbox',{name:'Select Amy, Mason, active for deletion'}));
    fireEvent.change(screen.getByLabelText('Filter workforce by status'),{target:{value:'inactive'}});
    fireEvent.click(screen.getByRole('checkbox',{name:'Select Ben, Mason, inactive for deletion'}));
    expect(screen.getByText(/2 selected/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'Delete selected'}));
    const dialog=screen.getByRole('alertdialog');expect(within(dialog).getByText(/Amy · Mason · Active/)).toBeTruthy();expect(within(dialog).getByText(/Ben · Mason · Inactive/)).toBeTruthy();
    expect(mock.fetch).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button',{name:'Delete eligible workers'}));
    await waitFor(()=>expect(screen.getByText(/Kept: Attendance, Payroll/)).toBeTruthy());
    expect(screen.getByText(/Deleted\./)).toBeTruthy();expect(mock.fetch).toHaveBeenCalledOnce();
    expect(JSON.parse(mock.fetch.mock.calls[0][1].body)).toEqual({ids});expect(mock.refresh).toHaveBeenCalledOnce();
  });
  it('does not offer deletion to Supervisors',()=>{
    mock.founder=false;render(React.createElement(AttendancePage));
    expect(screen.queryByRole('button',{name:'Delete selected'})).toBeNull();
    expect(screen.queryByRole('checkbox',{name:/for deletion/})).toBeNull();
  });
  it('reports an unconfirmed response without automatically retrying',async()=>{
    mock.fetch.mockRejectedValue(new Error('lost'));
    render(React.createElement(AttendancePage));fireEvent.click(screen.getByRole('checkbox',{name:'Select Amy, Mason, active for deletion'}));
    fireEvent.click(screen.getByRole('button',{name:'Delete selected'}));fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button',{name:'Delete eligible workers'}));
    await waitFor(()=>expect(mock.toast).toHaveBeenCalledWith('error',expect.stringMatching(/not confirmed/i)));
    expect(mock.fetch).toHaveBeenCalledOnce();expect(mock.refresh).toHaveBeenCalledOnce();
  });
});
