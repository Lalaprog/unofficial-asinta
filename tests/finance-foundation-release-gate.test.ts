// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ mounts: vi.fn(), records: [] as object[] }));
vi.mock('@/components/payroll/WorkerAllowanceQueue', () => ({ WorkerAllowanceQueue: () => { mock.mounts('allowance'); return React.createElement('div', null, 'Allowance queue'); } }));
vi.mock('@/components/payroll/WeeklyWorkerPreview', () => ({ WeeklyWorkerPreview: () => { mock.mounts('weekly'); return React.createElement('div', null, 'Weekly preview'); } }));
vi.mock('@/components/payroll/PaidHistoryReview', () => ({ PaidHistoryReview: () => { mock.mounts('review'); return React.createElement('div', null, 'Paid review'); } }));
vi.mock('@/components/payroll/SupervisorPayrollPreview', () => ({ SupervisorPayrollPreview: () => { mock.mounts('supervisor-payroll'); return React.createElement('div', null, 'Supervisor payroll preview'); } }));
vi.mock('@/components/attendance/SupervisorDayPanel', () => ({ SupervisorDayPanel: () => { mock.mounts('day'); return React.createElement('div', null, 'Supervisor day'); } }));
vi.mock('@/components/attendance/SupervisorLeavePanel', () => ({ SupervisorLeavePanel: () => { mock.mounts('leave'); return React.createElement('div', null, 'Supervisor leave'); } }));
vi.mock('@/components/attendance/TimeDetailDialog', () => ({ TimeDetailDialog: () => React.createElement('div', null, 'Time dialog') }));
vi.mock('@/components/attendance/AllowanceDialog', () => ({ AllowanceDialog: () => React.createElement('div', null, 'Allowance dialog') }));
vi.mock('@/lib/attendance/useAttendanceHistory', () => ({ useAttendanceHistory: () => ({ items: mock.records, loading: false, error: null, hasMore: false }) }));
import { financeFoundationEnabled } from '@/lib/finance/featureAvailability';
import { PayrollFoundationPanels } from '@/components/payroll/PayrollFoundationPanels';
import { SupervisorFoundationPanels } from '@/components/attendance/SupervisorFoundationPanels';
import { HistorySheetRecords } from '@/components/attendance/HistorySheetRecords';
import type { HistorySheet } from '@/lib/attendance/history';

const worker = { id:'w', worker_id:'w', worker_name:'Worker', worker_position:'Mason', project_id:'p', date:'2026-10-15', status:'present', hours_worked:8, is_supervisor:false, is_founder_override:false };
const supervisor = { ...worker, id:'s', worker_name:'Supervisor', is_supervisor:true };
const sheet: HistorySheet = {date:'2026-10-15',project_id:'p',project_name:'Site',record_count:2,present_count:2,half_day_count:0,absent_count:0,leave_count:0,pending_count:1};
const filters = {projectId:'',status:'',date:'',search:''};
afterEach(() => { cleanup(); vi.unstubAllEnvs(); mock.mounts.mockReset(); mock.records = []; });

describe('unfinished finance foundation UI release gate', () => {
  it.each([undefined, '', 'false', 'TRUE', '1'])('stays off for %s', (value) => {
    vi.stubEnv('NEXT_PUBLIC_FINANCE_FOUNDATION_PREVIEW', value);
    expect(financeFoundationEnabled()).toBe(false);
    render(React.createElement(React.Fragment, null, React.createElement(PayrollFoundationPanels), React.createElement(SupervisorFoundationPanels)));
    expect(mock.mounts).not.toHaveBeenCalled();
  });
  it('mounts the panels only for an explicit true build value', () => {
    vi.stubEnv('NEXT_PUBLIC_FINANCE_FOUNDATION_PREVIEW','true');
    render(React.createElement(React.Fragment, null, React.createElement(PayrollFoundationPanels), React.createElement(SupervisorFoundationPanels)));
    expect(mock.mounts.mock.calls.map(([name]) => name)).toEqual(['allowance','weekly','review','day','leave']);
  });
  it('requires both switches for the Supervisor payroll preview', () => {
    vi.stubEnv('NEXT_PUBLIC_FINANCE_FOUNDATION_PREVIEW','true');vi.stubEnv('NEXT_PUBLIC_SUPERVISOR_PAYROLL_PREVIEW','false');
    const view=render(React.createElement(PayrollFoundationPanels));expect(screen.queryByText('Supervisor payroll preview')).toBeNull();
    vi.stubEnv('NEXT_PUBLIC_SUPERVISOR_PAYROLL_PREVIEW','true');view.rerender(React.createElement(PayrollFoundationPanels));expect(screen.getByText('Supervisor payroll preview')).toBeTruthy();
    vi.stubEnv('NEXT_PUBLIC_FINANCE_FOUNDATION_PREVIEW','false');view.rerender(React.createElement(PayrollFoundationPanels));expect(screen.queryByText('Supervisor payroll preview')).toBeNull();
  });
  it('hides missing-schema controls but preserves Founder edit and approval actions', () => {
    vi.stubEnv('NEXT_PUBLIC_FINANCE_FOUNDATION_PREVIEW','false'); mock.records = [worker, supervisor];
    const onEdit = vi.fn(), onReview = vi.fn();
    render(React.createElement(HistorySheetRecords,{sheet,filters,userId:'f',revision:0,isFounder:true,reviewing:false,onEdit,onReview}));
    expect(screen.queryByRole('button',{name:'Regular / OT'})).toBeNull();
    expect(screen.queryByRole('button',{name:'Allowances'})).toBeNull();
    fireEvent.click(screen.getAllByRole('button',{name:'Edit'})[0]);
    fireEvent.click(screen.getByRole('button',{name:'Full Day'}));
    expect(onEdit).toHaveBeenCalledWith(worker); expect(onReview).toHaveBeenCalledWith(supervisor,'present');
  });
  it('offers the preview controls for eligible workers only, and opens the requested dialog', () => {
    vi.stubEnv('NEXT_PUBLIC_FINANCE_FOUNDATION_PREVIEW','true'); mock.records = [worker, supervisor, {...worker,id:'absent',status:'absent'}];
    render(React.createElement(HistorySheetRecords,{sheet,filters,userId:'f',revision:0,isFounder:true,reviewing:false,onEdit:vi.fn(),onReview:vi.fn()}));
    expect(screen.getAllByRole('button',{name:'Regular / OT'})).toHaveLength(1);
    expect(screen.getAllByRole('button',{name:'Allowances'})).toHaveLength(1);
    fireEvent.click(screen.getByRole('button',{name:'Regular / OT'}));
    expect(screen.getByText('Time dialog')).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'Allowances'}));
    expect(screen.getByText('Allowance dialog')).toBeTruthy();
  });
});
