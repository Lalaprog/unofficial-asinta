// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serializeAttendanceDraft } from '@/lib/attendance/drafts';

const state = vi.hoisted(() => ({
  supervisor: true, status: 'ready', snapshot: { workerIds: [] as string[], records: [] as any[] }, fresh: null as any,
  reload: vi.fn(async () => {}), record: vi.fn(async (_records: unknown) => true), toast: vi.fn(), create: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock('next/link', () => ({ default: ({children, prefetch: _prefetch, ...props}: React.AnchorHTMLAttributes<HTMLAnchorElement> & {prefetch?: boolean}) => React.createElement('a', props, children) }));
vi.mock('@/components/layout/AppShell', () => ({ AppShell: ({children}: {children: React.ReactNode}) => children }));
vi.mock('@/lib/attendance/usePendingApprovals', () => ({ usePendingApprovals: () => ({items: [], total: 0, hasMore: false, loading: false, error: null, loadMore: vi.fn(), refresh: vi.fn()}) }));
vi.mock('@/lib/auth/authContext', () => ({ useAuth: () => ({user: state.supervisor ? {id:'sup',name:'Supervisor',role:'supervisor'} : {id:'founder',name:'Founder',role:'founder'}, isFounder: !state.supervisor, isSupervisor: state.supervisor, assurance:'ready', isLoading:false}) }));
vi.mock('@/components/ui/Toast', () => ({useToast: () => ({showToast: state.toast})}));
vi.mock('@/lib/attendance/useProjectRollCall', () => ({ useProjectRollCall: () => ({status:state.status,snapshot:state.status === 'ready' ? state.snapshot : null,reload:state.reload}) }));
vi.mock('@/lib/attendance/project-roll-call', () => ({ loadProjectRollCall: async () => state.fresh || state.snapshot, projectRollCallFingerprint: (s:unknown) => JSON.stringify(s) }));
vi.mock('@/lib/data/store', () => {
  const workers = [
    {id:'sup',name:'Supervisor',position:'Site Supervisor',active:true,pay_rate:1000,pay_rate_type:'daily',contact_number:'—'},
    {id:'amy',name:'Amy',position:'Mason',active:true,pay_rate:800,pay_rate_type:'daily',contact_number:'—'},
    {id:'ben',name:'Ben',position:'Carpenter',active:true,pay_rate:800,pay_rate_type:'daily',contact_number:'—'},
    {id:'archive',name:'Archived',position:'Mason',active:false,pay_rate:800,pay_rate_type:'daily',contact_number:'—'},
  ];
  const projects = [{id:'site',name:'Test Site',location:'Batangas'}];
  const store = {workers,projects,users:[{id:'sup',name:'Supervisor',role:'supervisor'}], projectSupervisors:[{project_id:'site',supervisor_id:'sup'}], attendance:[],isLoaded:true,loadError:null,refresh:vi.fn(),createWorker:state.create,updateWorker:vi.fn(),toggleWorkerStatus:vi.fn(),recordAttendanceBatch:state.record,updateAttendanceRecord:vi.fn(),getProjectsForSupervisor:()=>projects};
  return {useDataStore:()=>store};
});
import AttendancePage from '@/app/attendance/page';
const saved = (worker: string, id: string, name: string | null) => ({id,worker_id:worker,project_id:'site',date:'2026-11-03',status:'half_day',hours_worked:4,notes:'historical',recorded_by:'founder',is_founder_override:false,submitted_at:'now',worker_name:name,worker_position:null,project_name:'Test Site',is_supervisor:false});
const draftKey = 'asinta-attendance-draft:v1:sup:site:2026-11-03';
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-03T04:00:00Z'));
  state.supervisor=true; state.status='ready'; state.snapshot={workerIds:[],records:[]}; state.fresh=null;
  state.record.mockReset().mockResolvedValue(true); state.reload.mockClear(); state.toast.mockClear(); state.create.mockClear();
  window.localStorage.clear(); window.history.replaceState({},'', '/attendance');
});
afterEach(() => {cleanup(); vi.unstubAllEnvs(); vi.useRealTimers();});

describe('project-specific Roll Call', () => {
  it('shows guidance, no shared workforce and no auto-log for an empty team', () => {
    render(React.createElement(AttendancePage));
    expect(screen.getByText(/No workers are assigned to this project yet/)).toBeTruthy();
    expect(screen.getByRole('link',{name:'Manage project workers'}).getAttribute('href')).toBe('/projects/site');
    expect(screen.queryByRole('group',{name:'Attendance status for Amy'})).toBeNull();
    expect(screen.queryByText('Auto-logged when you submit crew roll call.')).toBeNull();
    expect((screen.getByRole('button',{name:'Submit Roll Call'}) as HTMLButtonElement).disabled).toBe(true);
    expect(state.record).not.toHaveBeenCalled(); expect(state.create).not.toHaveBeenCalled();
  });
  it('includes assigned crew and saved active crew, with unavailable history shown read-only', () => {
    state.snapshot={workerIds:['amy'],records:[saved('ben','r1','Ben'),saved('archive','r2',null)]};
    render(React.createElement(AttendancePage));
    expect(screen.getByRole('group',{name:'Attendance status for Amy'})).toBeTruthy();
    expect(screen.getByRole('group',{name:'Attendance status for Ben'})).toBeTruthy();
    expect(within(screen.getByRole('group',{name:'Attendance status for Ben'})).getByRole('button',{name:'Half Day'}).getAttribute('aria-pressed')).toBe('true');
    const archive=screen.getByRole('region',{name:'Saved attendance for unavailable workers'});
    expect(within(archive).getByText(/Worker \(details unavailable\)/)).toBeTruthy();
    expect(within(archive).queryByRole('button')).toBeNull();
    expect(screen.getByText('Auto-logged when you submit crew roll call.')).toBeTruthy();
    expect(state.record).not.toHaveBeenCalled();
  });
  it('retains saved attendance even when the project team is now empty', () => {
    state.snapshot={workerIds:[],records:[saved('ben','r1','Ben'),saved('archive','r2',null)]};
    render(React.createElement(AttendancePage));
    expect(screen.getByText(/No workers are assigned/)).toBeTruthy();
    expect(screen.getByRole('group',{name:'Attendance status for Ben'})).toBeTruthy();
    expect(screen.getByRole('region',{name:'Saved attendance for unavailable workers'})).toBeTruthy();
    expect(screen.queryByRole('group',{name:'Attendance status for Amy'})).toBeNull();
    expect(screen.queryByText('Auto-logged when you submit crew roll call.')).toBeNull();
  });
  it('shows the actual saved Supervisor status instead of claiming Present', () => {
    state.snapshot={workerIds:['amy'],records:[saved('sup','r2','Supervisor')]};
    render(React.createElement(AttendancePage));
    expect(screen.getByText('Submitted: Half Day · Pending Founder Approval')).toBeTruthy();
    expect(screen.queryByText('Submitted as Present · Pending Founder Approval')).toBeNull();
  });
  it('writes only changed or new crew rows and preserves an existing supervisor record', async () => {
    state.snapshot={workerIds:['amy','ben'],records:[saved('ben','r1','Ben'),saved('sup','r2','Supervisor')]};
    render(React.createElement(AttendancePage));
    fireEvent.click(within(screen.getByRole('group',{name:'Attendance status for Amy'})).getByRole('button',{name:'Present'}));
    fireEvent.click(screen.getByRole('button',{name:'Save Changes'}));
    await act(async()=>{});
    expect(state.record).toHaveBeenCalledOnce();
    const rows=state.record.mock.calls[0][0] as unknown as Array<{worker_id:string}>;
    expect(rows.map(r=>r.worker_id)).toEqual(['amy']);
  });
  it('in cutover mode saves crew without creating legacy Supervisor self-attendance', async () => {
    vi.stubEnv('NEXT_PUBLIC_WEEKLY_WORKER_CUTOVER_PREVIEW','true');
    state.snapshot={workerIds:['amy'],records:[]};render(React.createElement(AttendancePage));
    expect(screen.getByText(/Supervisor attendance is recorded separately in General Daily Attendance/)).toBeTruthy();
    expect(screen.queryByText('Auto-logged when you submit crew roll call.')).toBeNull();
    fireEvent.click(within(screen.getByRole('group',{name:'Attendance status for Amy'})).getByRole('button',{name:'Present'}));
    fireEvent.click(screen.getByRole('button',{name:'Submit Roll Call'}));await act(async()=>{});
    expect(state.record).toHaveBeenCalledOnce();expect((state.record.mock.calls[0][0] as unknown as Array<{worker_id:string}>).map(r=>r.worker_id)).toEqual(['amy']);
  });
  it('locks linked Supervisor rows for the Founder and preserves a pre-cutover draft', () => {
    vi.stubEnv('NEXT_PUBLIC_WEEKLY_WORKER_CUTOVER_PREVIEW','true');state.supervisor=false;
    state.snapshot={workerIds:['amy'],records:[saved('sup','r2','Supervisor')]};
    const key='asinta-attendance-draft:v1:founder:site:2026-11-03';localStorage.setItem(key,serializeAttendanceDraft({sup:{status:'absent',notes:'old draft'}}));
    render(React.createElement(AttendancePage));expect(screen.queryByRole('group',{name:'Attendance status for Supervisor'})).toBeNull();
    expect(screen.getByText(/Historical site record: Half Day/)).toBeTruthy();expect(screen.getByText(/saved draft includes 1 worker/)).toBeTruthy();
    expect(localStorage.getItem(key)).toContain('old draft');expect(state.record).not.toHaveBeenCalled();
  });
  it('never silently drops malformed entries from a partially readable draft', () => {
    state.snapshot={workerIds:['amy'],records:[]};
    const raw=JSON.stringify({version:1,entries:{amy:{status:'present',notes:'ok'},bad:{status:'bad',notes:'keep'}}});
    localStorage.setItem(draftKey,raw);
    render(React.createElement(AttendancePage));
    expect(screen.getByRole('alert').textContent).toContain('Could not read the draft storage');
    expect(localStorage.getItem(draftKey)).toBe(raw);
    expect(state.record).not.toHaveBeenCalled();
  });
  it('blocks if an assigned worker is not available instead of silently hiding them', () => {
    state.snapshot={workerIds:['amy','missing'],records:[]};
    render(React.createElement(AttendancePage));
    expect(screen.getByRole('alert').textContent).toContain('Some assigned workers are inactive');
    fireEvent.click(within(screen.getByRole('group',{name:'Attendance status for Amy'})).getByRole('button',{name:'Present'}));
    expect((screen.getByRole('button',{name:'Submit Roll Call'}) as HTMLButtonElement).disabled).toBe(true);
    expect(state.record).not.toHaveBeenCalled();
  });
  it('preserves hidden draft selections until explicitly discarded', () => {
    state.snapshot={workerIds:['amy'],records:[]};
    const savedDraft=serializeAttendanceDraft({ben:{status:'present',notes:'keep me'}});
    localStorage.setItem(draftKey,savedDraft);
    render(React.createElement(AttendancePage));
    expect(screen.getByRole('alert').textContent).toContain('saved draft includes 1 worker');
    expect(localStorage.getItem(draftKey)).toContain('keep me');
    fireEvent.click(screen.getByRole('button',{name:'Review hidden draft selections'}));
    fireEvent.click(screen.getByRole('button',{name:'Cancel'}));
    expect(localStorage.getItem(draftKey)).toContain('keep me');
    fireEvent.click(screen.getByRole('button',{name:'Review hidden draft selections'}));
    fireEvent.click(screen.getByRole('button',{name:'Discard hidden selections'}));
    expect(localStorage.getItem(draftKey)).toBeNull();
    expect(state.record).not.toHaveBeenCalled();
  });
  it('does not delete an unreadable draft or treat a failed roster as empty', () => {
    localStorage.setItem(draftKey,'{broken'); state.status='error';
    const view=render(React.createElement(AttendancePage));
    expect(screen.getByRole('alert').textContent).toContain('Could not load');
    expect(localStorage.getItem(draftKey)).toBe('{broken');
    state.status='ready'; view.rerender(React.createElement(AttendancePage));
    expect(screen.getByRole('alert').textContent).toContain('Could not read the draft storage');
    expect(localStorage.getItem(draftKey)).toBe('{broken');
    expect(state.record).not.toHaveBeenCalled();
  });
  it('rechecks for a changed team before submitting and preserves the draft', async () => {
    state.snapshot={workerIds:['amy'],records:[]};
    state.fresh={workerIds:['amy','ben'],records:[]};
    render(React.createElement(AttendancePage));
    fireEvent.click(within(screen.getByRole('group',{name:'Attendance status for Amy'})).getByRole('button',{name:'Present'}));
    fireEvent.click(screen.getByRole('button',{name:'Submit Roll Call'}));
    await act(async()=>{});
    expect(state.record).not.toHaveBeenCalled();
    expect(state.reload).toHaveBeenCalledOnce();
    expect(localStorage.getItem(draftKey)).toContain('present');
    expect(state.toast).toHaveBeenCalledWith('error',expect.stringContaining('changed'));
  });
});
