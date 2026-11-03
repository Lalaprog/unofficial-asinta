// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ founder: true, update: vi.fn(), showToast: vi.fn() }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams('tab=history') }));
vi.mock('next/link', () => ({ default: ({children, href, prefetch: _prefetch, ...props}: React.AnchorHTMLAttributes<HTMLAnchorElement> & {prefetch?: boolean}) => React.createElement('a', {href, ...props}, children) }));
vi.mock('@/components/layout/AppShell', () => ({ AppShell: ({children}: {children: React.ReactNode}) => React.createElement('main', null, children) }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({showToast: mock.showToast}) }));
vi.mock('@/lib/auth/authContext', () => {
  const founder = {id:'founder',name:'Founder',role:'founder'};
  const supervisor = {id:'sup-1',name:'Supervisor 1',role:'supervisor'};
  return {useAuth: () => ({user:mock.founder?founder:supervisor,isFounder:mock.founder,isSupervisor:!mock.founder})};
});
vi.mock('@/lib/data/store', () => {
  const projects = [{id:'site-1',name:'Alpha Site',location:'Batangas, PH'},{id:'site-2',name:'Beta Site',location:'Lipa, PH'}];
  const crew = Array.from({length:26},(_,i)=>({id:`worker-${i}`,name:`Worker ${String(i).padStart(2,'0')}`,position:'Mason',active:true,pay_rate:850,pay_rate_type:'daily',contact_number:'—'}));
  const supervisors=Array.from({length:4},(_,i)=>({id:`sup-${i+1}`,name:`Supervisor ${i+1}`,position:'Site Supervisor',active:true,pay_rate:1200,pay_rate_type:'daily',contact_number:'—'}));
  const workers=[...crew,...supervisors];
  const users=supervisors.map((s)=>({id:s.id,name:s.name,role:'supervisor'}));
  const attendance=[
    ...Array.from({length:26},(_,i)=>({id:`r-${i}`,worker_id:`worker-${i}`,project_id:'site-1',date:'2026-10-15',status:i===0?'leave':'present',hours_worked:i===0?0:8,notes:i===25?'A long note about ceiling repairs and construction materials.':'',recorded_by:'founder',is_founder_override:false})),
    ...supervisors.map((s,i)=>({id:`pending-${i+1}`,worker_id:s.id,project_id:'site-1',date:'2026-10-15',status:'present',hours_worked:8,notes:'Pending Founder Review',recorded_by:s.id,is_founder_override:false})),
    ...Array.from({length:13},(_,i)=>({id:`old-${i}`,worker_id:'worker-0',project_id:'site-1',date:`2026-10-${String(i+1).padStart(2,'0')}`,status:'half_day',hours_worked:4,notes:'',recorded_by:'founder',is_founder_override:false})),
    {id:'other',worker_id:'worker-0',project_id:'site-2',date:'2026-10-15',status:'absent',hours_worked:0,notes:'',recorded_by:'founder',is_founder_override:false},
  ];
  const store = {users,workers,projects,projectSupervisors:supervisors.map(s=>({project_id:'site-1',supervisor_id:s.id})),attendance,isLoaded:true,createWorker:vi.fn(),updateWorker:vi.fn(),toggleWorkerStatus:vi.fn(),recordAttendanceBatch:vi.fn(),updateAttendanceRecord:mock.update,getProjectsForSupervisor:()=>[projects[0]]};
  return {useDataStore:()=>store};
});
import AttendancePage from '@/app/attendance/page';

beforeEach(() => {
  mock.founder=true; mock.update.mockReset(); mock.showToast.mockReset();
  window.localStorage.clear(); window.history.replaceState({}, '', '/attendance?tab=history');
});
afterEach(() => cleanup());

describe('compact attendance history', () => {
  it('starts collapsed, batches dates and rows, and keeps leave and complete notes visible', () => {
    render(React.createElement(AttendancePage));
    expect(screen.getByText('44 matching records in loaded history. Showing 10 of 15 date/site sheets.')).toBeTruthy();
    const header=screen.getByRole('button',{name:/October 15, 2026 · Alpha Site/});
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Worker 00')).toBeNull();
    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('true');
    const sheet=document.getElementById(header.getAttribute('aria-controls')!)!;
    expect(within(sheet).getByText('Worker 00')).toBeTruthy();
    expect(within(sheet).getByText('Approved Leave')).toBeTruthy();
    expect(within(sheet).queryByText('Worker 25')).toBeNull();
    fireEvent.click(within(sheet).getByRole('button',{name:/Show more records for October 15, 2026 · Alpha Site/}));
    expect(within(sheet).getByText('Worker 25')).toBeTruthy();
    expect(within(sheet).getByText(/A long note about ceiling repairs/)).toBeTruthy();
    expect(within(sheet).getAllByText('Pending Founder Approval (Held from Payroll)')).toHaveLength(4);
    fireEvent.click(screen.getByRole('button',{name:'Show more date/site sheets'}));
    expect(screen.getByText('44 matching records in loaded history. Showing 15 of 15 date/site sheets.')).toBeTruthy();
    expect(screen.getByRole('button',{name:/October 1, 2026 · Alpha Site/})).toBeTruthy();
  });

  it('filters the loaded records before batching and keeps the Founder approval queue independent', () => {
    render(React.createElement(AttendancePage));
    expect(screen.getByText('Supervisor approvals (4 loaded)')).toBeTruthy();
    expect(screen.getAllByRole('button',{name:'Approve Full Day'})).toHaveLength(3);
    fireEvent.click(screen.getByRole('button',{name:'Show more pending approvals (1 remaining)'}));
    expect(screen.getAllByRole('button',{name:'Approve Full Day'})).toHaveLength(4);
    fireEvent.change(screen.getAllByLabelText('Search attendance history')[0],{target:{value:'ceiling repairs'}});
    expect(screen.getByText('1 matching record in loaded history. Showing 1 of 1 date/site sheets.')).toBeTruthy();
    expect(screen.getByText('Supervisor approvals (4 loaded)')).toBeTruthy();
    const header=screen.getByRole('button',{name:/October 15, 2026 · Alpha Site/});
    fireEvent.click(header);
    expect(screen.getByText('Worker 25')).toBeTruthy();
    fireEvent.change(screen.getAllByLabelText('Search attendance history')[0],{target:{value:'no match'}});
    expect(screen.getByText(/No loaded records match/)).toBeTruthy();
  });

  it('filters by site, status and date and resets the expanded history', () => {
    render(React.createElement(AttendancePage));
    fireEvent.click(screen.getByRole('button', {name: 'Show more date/site sheets'}));
    const header = screen.getByRole('button', {name: /October 15, 2026 · Alpha Site/});
    fireEvent.click(header);
    fireEvent.change(screen.getByLabelText('Filter by project site'), {target: {value: 'site-2'}});
    expect(screen.getByText('1 matching record in loaded history. Showing 1 of 1 date/site sheets.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Filter by attendance status'), {target: {value: 'present'}});
    expect(screen.getByText(/No loaded records match/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Filter by attendance status'), {target: {value: 'absent'}});
    fireEvent.change(screen.getByLabelText('Filter by attendance date'), {target: {value: '2026-10-14'}});
    expect(screen.getByText(/No loaded records match/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', {name: 'Reset'}));
    expect(screen.getByText('44 matching records in loaded history. Showing 10 of 15 date/site sheets.')).toBeTruthy();
    expect(screen.getByRole('button', {name: /October 15, 2026 · Alpha Site/}).getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByText('Supervisor approvals (4 loaded)')).toBeTruthy();
  });

  it('preserves the correct Founder approval and override actions within an expanded sheet', async () => {
    mock.update.mockResolvedValue(true);
    render(React.createElement(AttendancePage));
    const header=screen.getByRole('button',{name:/October 15, 2026 · Alpha Site/});
    fireEvent.click(header);
    const sheet=document.getElementById(header.getAttribute('aria-controls')!)!;
    fireEvent.click(within(sheet).getByRole('button',{name:/Show more records for October 15, 2026 · Alpha Site/}));
    const row=within(sheet).getByText('Supervisor 1').closest('.px-4')!;
    await act(async()=>{fireEvent.click(within(row as HTMLElement).getByRole('button',{name:'Full Day'}));});
    expect(mock.update).toHaveBeenCalledWith('pending-1',expect.objectContaining({status:'present',hours_worked:8}),true);
    fireEvent.click(within(row as HTMLElement).getByRole('button',{name:'Edit'}));
    expect(screen.getByRole('dialog',{name:'Founder Attendance Override'})).toBeTruthy();
  });

  it('shows only assigned-site records and no Founder action buttons to a Supervisor', () => {
    mock.founder=false;
    render(React.createElement(AttendancePage));
    expect(screen.getByText('43 matching records in loaded history. Showing 10 of 14 date/site sheets.')).toBeTruthy();
    expect(screen.queryByRole('button',{name:/October 15, 2026 · Beta Site/})).toBeNull();
    expect(screen.queryByText(/Supervisor approvals/)).toBeNull();
    const header=screen.getByRole('button',{name:/October 15, 2026 · Alpha Site/});
    fireEvent.click(header);
    const sheet=document.getElementById(header.getAttribute('aria-controls')!)!;
    expect(within(sheet).queryByRole('button',{name:'Edit'})).toBeNull();
  });
});
