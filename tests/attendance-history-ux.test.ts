// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ founder: true, update: vi.fn(), showToast: vi.fn(), failHistory:false, rpc:vi.fn() }));
vi.mock('@/lib/attendance/useProjectRollCall', () => ({ useProjectRollCall: () => ({ status: 'loading', snapshot: null, reload: vi.fn() }) }));
vi.mock('@/lib/attendance/usePendingApprovals', async () => {
  const React = await import('react');
  const rows = Array.from({length:4},(_,i)=>({id:`pending-${i+1}`,worker_id:`sup-${i+1}`,worker_name:`Supervisor ${i+1}`,project_id:'site-1',project_name:'Alpha Site',date:'2026-10-15',status:'present',hours_worked:8,notes:'Pending Founder Review',recorded_by:`sup-${i+1}`,is_founder_override:false}));
  return {usePendingApprovals:(enabled:boolean)=>{const [count,setCount]=React.useState(3);return {items:enabled?rows.slice(0,count):[],total:enabled?4:null,hasMore:enabled&&count<4,loading:false,error:null,loadMore:()=>setCount(4),refresh:vi.fn()}}};
});
vi.mock('next/navigation',()=>({useSearchParams:()=>new URLSearchParams('tab=history')}));
vi.mock('next/link',()=>({default:({children,href,prefetch:_prefetch,...props}:React.AnchorHTMLAttributes<HTMLAnchorElement>&{prefetch?:boolean})=>React.createElement('a',{href,...props},children)}));
vi.mock('@/components/layout/AppShell',()=>({AppShell:({children}:{children:React.ReactNode})=>React.createElement('main',null,children)}));
vi.mock('@/components/ui/Toast',()=>({useToast:()=>({showToast:mock.showToast})}));
vi.mock('@/lib/auth/authContext',()=>{const f={id:'founder',name:'Founder',role:'founder'},s={id:'sup-1',name:'Supervisor 1',role:'supervisor'};return {useAuth:()=>({user:mock.founder?f:s,isFounder:mock.founder,isSupervisor:!mock.founder})}});
vi.mock('@/lib/data/store',()=>{
  const projects=[{id:'site-1',name:'Alpha Site',location:'Batangas, PH'},{id:'site-2',name:'Beta Site',location:'Lipa, PH'}];
  // Deliberately empty attendance: history must not depend on this capped store.
  const assigned=[projects[0]];
  const store={users:[],workers:[],projects,projectSupervisors:[],attendance:[],isLoaded:true,createWorker:vi.fn(),updateWorker:vi.fn(),toggleWorkerStatus:vi.fn(),recordAttendanceBatch:vi.fn(),updateAttendanceRecord:mock.update,getProjectsForSupervisor:()=>assigned};
  return {useDataStore:()=>store};
});
vi.mock('@/lib/supabase/client',()=>({createClient:()=>({rpc:mock.rpc})}));
import AttendancePage from '@/app/attendance/page';

const records = [
  ...Array.from({length:26},(_,i)=>({id:`r-${String(i).padStart(2,'0')}`,worker_id:`worker-${i}`,worker_name:`Worker ${String(i).padStart(2,'0')}`,worker_position:'Mason',project_id:'site-1',project_name:'Alpha Site',date:'2026-10-15',status:i===0?'leave':'present',hours_worked:8,notes:i===25?'A long note about ceiling repairs and construction materials.':'',recorded_by:'founder',is_founder_override:false,is_supervisor:false})),
  ...Array.from({length:4},(_,i)=>({id:`z-pending-${i+1}`,worker_id:`sup-${i+1}`,worker_name:`Supervisor ${i+1}`,worker_position:'Site Supervisor',project_id:'site-1',project_name:'Alpha Site',date:'2026-10-15',status:'present',hours_worked:8,notes:'Pending Founder Review',recorded_by:`sup-${i+1}`,is_founder_override:false,is_supervisor:true})),
  ...Array.from({length:13},(_,i)=>({id:`old-${i}`,worker_id:'worker-0',worker_name:'Worker 00',worker_position:'Mason',project_id:'site-1',project_name:'Alpha Site',date:`2026-10-${String(i+1).padStart(2,'0')}`,status:'half_day',hours_worked:4,notes:'',recorded_by:'founder',is_founder_override:false,is_supervisor:false})),
  {id:'other',worker_id:'worker-0',worker_name:'Worker 00',worker_position:'Mason',project_id:'site-2',project_name:'Beta Site',date:'2026-10-15',status:'absent',hours_worked:0,notes:'',recorded_by:'founder',is_founder_override:false,is_supervisor:false},
];
function historyResponse(_name:string, args:Record<string, string | number | null>) {
  if (mock.failHistory) return Promise.resolve({data:null,error:{message:'missing migration'}});
  const search=String(args.p_search||'').toLowerCase();
  const filtered=records.filter(r=>(mock.founder || r.project_id==='site-1')&&(!args.p_project_id||r.project_id===args.p_project_id)&&(!args.p_status||r.status===args.p_status)&&(!args.p_date||r.date===args.p_date)&&(!search||[r.worker_name,r.worker_position,r.project_name,r.notes].some(v=>v.toLowerCase().includes(search))));
  if(args.p_mode==='records'){
    const matched=filtered.filter(r=>!args.p_cursor_id||r.id>String(args.p_cursor_id)).sort((a,b)=>a.id.localeCompare(b.id));
    return Promise.resolve({data:{items:matched.slice(0,20),has_more:matched.length>20},error:null});
  }
  const groups=new Map<string,typeof records>();
  for(const r of filtered){const key=`${r.date}::${r.project_id}`;groups.set(key,[...(groups.get(key)||[]),r]);}
  const sheets=[...groups.values()].map((rows)=>({date:rows[0].date,project_id:rows[0].project_id,project_name:rows[0].project_name,record_count:rows.length,present_count:rows.filter(x=>x.status==='present').length,half_day_count:rows.filter(x=>x.status==='half_day').length,absent_count:rows.filter(x=>x.status==='absent').length,leave_count:rows.filter(x=>x.status==='leave').length,pending_count:rows.filter(x=>x.is_supervisor&&!x.is_founder_override&&['present','half_day'].includes(x.status)).length}))
    .sort((a,b)=>b.date.localeCompare(a.date)||a.project_id.localeCompare(b.project_id)).filter(x=>!args.p_cursor_date||x.date<String(args.p_cursor_date)||(x.date===args.p_cursor_date&&x.project_id>String(args.p_cursor_project_id)));
  return Promise.resolve({data:{items:sheets.slice(0,10),has_more:sheets.length>10},error:null});
}

beforeEach(()=>{mock.founder=true;mock.failHistory=false;mock.update.mockReset();mock.showToast.mockReset();mock.rpc.mockReset().mockImplementation(historyResponse);window.localStorage.clear();window.history.replaceState({},'','/attendance?tab=history');});
afterEach(()=>cleanup());

describe('server-backed compact attendance history',()=>{
  it('starts collapsed and pages date/site sheets and records, retaining leave and full notes',async()=>{
    render(React.createElement(AttendancePage));
    await screen.findByText('Showing 10 date/site sheets from the server. Counts reflect the current filters.');
    const header=screen.getByRole('button',{name:/^October 15, 2026 · Alpha Site/});
    expect(header.getAttribute('aria-expanded')).toBe('false');expect(screen.queryByText('Worker 00')).toBeNull();
    fireEvent.click(header);const sheet=document.getElementById(header.getAttribute('aria-controls')!)!;
    await within(sheet).findByText('Worker 00');expect(within(sheet).getByText('Approved Leave')).toBeTruthy();expect(within(sheet).queryByText('Worker 25')).toBeNull();
    fireEvent.click(within(sheet).getByRole('button',{name:/Show more records for October 15, 2026 · Alpha Site/}));
    await within(sheet).findByText('Worker 25');expect(within(sheet).getByText(/A long note about ceiling repairs/)).toBeTruthy();expect(within(sheet).getAllByText('Pending Founder Approval (Held from Payroll)')).toHaveLength(4);
    fireEvent.click(screen.getByRole('button',{name:'Show more date/site sheets'}));
    await screen.findByText('Showing 15 date/site sheets from the server. Counts reflect the current filters.');
    expect(screen.getByRole('button',{name:/^October 1, 2026 · Alpha Site/})).toBeTruthy();
  });
  it('debounces server search and keeps the Founder queue independent',async()=>{
    render(React.createElement(AttendancePage));await screen.findByText('Showing 10 date/site sheets from the server. Counts reflect the current filters.');
    fireEvent.click(screen.getByRole('button',{name:'Show more pending approvals'}));expect(screen.getAllByRole('button',{name:'Approve Full Day'})).toHaveLength(4);
    fireEvent.change(screen.getAllByLabelText('Search attendance history')[0],{target:{value:'ceiling repairs'}});
    await screen.findByText('Showing 1 date/site sheet from the server. Counts reflect the current filters.');expect(screen.getByText('Supervisor approvals (4 pending)')).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:/^October 15, 2026 · Alpha Site/}));await screen.findByText('Worker 25');
    fireEvent.change(screen.getAllByLabelText('Search attendance history')[0],{target:{value:'no match'}});await screen.findByText('No attendance records match');
  });
  it('filters site/status/date and resets expanded sheets',async()=>{
    render(React.createElement(AttendancePage));await screen.findByRole('button',{name:'Show more date/site sheets'});
    fireEvent.click(screen.getByRole('button',{name:/^October 15, 2026 · Alpha Site/}));
    fireEvent.change(screen.getByLabelText('Filter by project site'),{target:{value:'site-2'}});await screen.findByRole('button',{name:/^October 15, 2026 · Beta Site/});
    fireEvent.change(screen.getByLabelText('Filter by attendance status'),{target:{value:'present'}});await screen.findByText('No attendance records match');
    fireEvent.change(screen.getByLabelText('Filter by attendance status'),{target:{value:'absent'}});fireEvent.change(screen.getByLabelText('Filter by attendance date'),{target:{value:'2026-10-14'}});await screen.findByText('No attendance records match');
    fireEvent.click(screen.getByRole('button',{name:'Reset'}));const header=await screen.findByRole('button',{name:/^October 15, 2026 · Alpha Site/});expect(header.getAttribute('aria-expanded')).toBe('false');expect(screen.getByText('Supervisor approvals (4 pending)')).toBeTruthy();
  });
  it('keeps Founder override and approval actions for records not present in the shared store',async()=>{
    mock.update.mockResolvedValue(true);render(React.createElement(AttendancePage));
    let header=await screen.findByRole('button',{name:/^October 15, 2026 · Alpha Site/});fireEvent.click(header);let sheet=document.getElementById(header.getAttribute('aria-controls')!)!;
    fireEvent.click(await within(sheet).findByRole('button',{name:/Show more records for October 15/}));let row=(await within(sheet).findByText('Supervisor 1')).closest('.px-4') as HTMLElement;
    fireEvent.click(within(row).getByRole('button',{name:'Edit'}));expect(screen.getByRole('dialog',{name:'Founder Attendance Override'})).toBeTruthy();expect(screen.getByText('Worker: Supervisor 1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'Cancel'}));
    await act(async()=>{fireEvent.click(within(row).getByRole('button',{name:'Full Day'}));});
    expect(mock.update).toHaveBeenCalledWith('z-pending-1',expect.objectContaining({status:'present',hours_worked:8}),true);
  });
  it('shows only authorized sites and no Founder actions to Supervisors',async()=>{
    mock.founder=false;render(React.createElement(AttendancePage));const header=await screen.findByRole('button',{name:/^October 15, 2026 · Alpha Site/});expect(screen.queryByRole('button',{name:/^October 15, 2026 · Beta Site/})).toBeNull();expect(screen.queryByText(/Supervisor approvals/)).toBeNull();fireEvent.click(header);const sheet=document.getElementById(header.getAttribute('aria-controls')!)!;await within(sheet).findByText('Worker 00');expect(within(sheet).queryByRole('button',{name:'Edit'})).toBeNull();
  });
  it('shows a retry error rather than a false empty result when the query fails',async()=>{
    mock.failHistory=true;render(React.createElement(AttendancePage));await screen.findByText('Unable to load attendance history. Please retry.');expect(screen.queryByText('No attendance records match')).toBeNull();mock.failHistory=false;fireEvent.click(screen.getByRole('button',{name:'Retry history'}));await screen.findByText('Showing 10 date/site sheets from the server. Counts reflect the current filters.');
  });
});
