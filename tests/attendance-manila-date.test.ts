// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { manilaDateISO, shiftCalendarDate } from '@/lib/dates/manila';
import { useManilaToday } from '@/lib/dates/useManilaToday';

const mock = vi.hoisted(() => ({
  tab: '',
  founder: true,
  createWorker: vi.fn(),
  recordAttendanceBatch: vi.fn(),
  showToast: vi.fn(),
}));
vi.mock('@/lib/attendance/usePendingApprovals', () => ({ usePendingApprovals: () => ({items: [], total: 0, hasMore: false, loading: false, error: null, loadMore: vi.fn(), refresh: vi.fn()}) }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(mock.tab) }));
vi.mock('next/link', () => ({
  default: ({ children, href, prefetch: _prefetch, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { prefetch?: boolean }) =>
    React.createElement('a', { ...props, href }, children),
}));
vi.mock('@/components/layout/AppShell', () => ({ AppShell: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('@/lib/auth/authContext', () => {
  const founderUser = { id: 'user-1', name: 'Test User', role: 'founder' };
  const supervisorUser = { id: 'user-1', name: 'Test User', role: 'supervisor' };
  return { useAuth: () => ({ user: mock.founder ? founderUser : supervisorUser, isFounder: mock.founder, isSupervisor: !mock.founder }) };
});
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ showToast: mock.showToast }) }));
vi.mock('@/lib/data/store', () => {
  const projects = [{ id: 'site-1', name: 'Test Site', location: 'Batangas, PH' }];
  const workers = [{ id: 'worker-1', name: 'Test Worker', position: 'Mason', active: true, pay_rate: 850, pay_rate_type: 'daily', contact_number: '—' }];
  const store = {
    users: [], workers, projects, projectSupervisors: [], attendance: [], isLoaded: true,
    createWorker: mock.createWorker, updateWorker: vi.fn(), toggleWorkerStatus: vi.fn(),
    recordAttendanceBatch: mock.recordAttendanceBatch, updateAttendanceRecord: vi.fn(),
    getProjectsForSupervisor: () => projects,
  };
  return { useDataStore: () => store };
});
import AttendancePage from '@/app/attendance/page';

beforeEach(() => {
  mock.tab = '';
  mock.founder = true;
  mock.createWorker.mockReset();
  mock.recordAttendanceBatch.mockReset();
  mock.showToast.mockReset();
  window.localStorage.clear();
  window.history.replaceState({}, '', '/attendance');
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('Philippine site calendar', () => {
  it('uses Manila rather than the UTC or device calendar, including midnight and year boundaries', () => {
    expect(manilaDateISO(new Date('2026-11-02T15:59:59Z'))).toBe('2026-11-02');
    expect(manilaDateISO(new Date('2026-11-02T16:00:00Z'))).toBe('2026-11-03');
    expect(manilaDateISO(new Date('2026-12-31T16:00:00Z'))).toBe('2027-01-01');
    expect(shiftCalendarDate('2027-01-01', -1)).toBe('2026-12-31');
    expect(shiftCalendarDate('2024-03-01', -1)).toBe('2024-02-29');
  });

  it('defaults to Manila today and keeps the chosen date and draft at midnight', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-02T15:59:50Z'));
    render(React.createElement(AttendancePage));
    const date = screen.getByLabelText('Roll call date') as HTMLInputElement;
    expect(date.value).toBe('2026-11-02');
    expect(date.max).toBe('2026-11-02');
    fireEvent.click(screen.getByRole('button', { name: 'Mark remaining present' }));
    act(() => { vi.advanceTimersByTime(30_000); });
    expect(screen.getByRole('button', { name: 'Today (11-03)' })).toBeTruthy();
    expect(date.value).toBe('2026-11-02');
    expect(date.max).toBe('2026-11-03');
    expect(screen.getByRole('button', { name: 'Submit Roll Call' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Today (11-03)' }));
    expect(date.value).toBe('2026-11-03');
    fireEvent.click(screen.getByRole('button', { name: 'Yesterday (11-02)' }));
    expect(date.value).toBe('2026-11-02');
  });

  it('checks the real Manila date at submission even if a future date is entered', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-02T16:01:00Z'));
    render(React.createElement(AttendancePage));
    const date = screen.getByLabelText('Roll call date') as HTMLInputElement;
    expect(date.value).toBe('2026-11-03');
    fireEvent.change(date, { target: { value: '2026-11-04' } });
    fireEvent.click(screen.getByRole('button', { name: 'Mark remaining present' }));
    fireEvent.submit(screen.getByRole('button', { name: 'Submit Roll Call' }).closest('form')!);
    expect(mock.recordAttendanceBatch).not.toHaveBeenCalled();
    expect(mock.showToast).toHaveBeenCalledWith('error', 'Attendance cannot be recorded for a future date.');
  });

  it('refreshes a sleeping tab on focus without waiting for the timer', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-02T15:59:59Z'));
    function Clock() { return React.createElement('span', null, useManilaToday()); }
    render(React.createElement(Clock));
    expect(screen.getByText('2026-11-02')).toBeTruthy();
    vi.setSystemTime(new Date('2026-11-02T16:00:01Z'));
    fireEvent.focus(window);
    expect(screen.getByText('2026-11-03')).toBeTruthy();
  });

  it('allows a real backdated roll-call submission', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-02T16:01:00Z'));
    mock.recordAttendanceBatch.mockResolvedValue(true);
    render(React.createElement(AttendancePage));
    fireEvent.click(screen.getByRole('button', { name: 'Yesterday (11-02)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Mark remaining present' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Submit Roll Call' })); });
    expect(mock.recordAttendanceBatch).toHaveBeenCalledWith([
      expect.objectContaining({ worker_id: 'worker-1', project_id: 'site-1', date: '2026-11-02', status: 'present' }),
    ]);
  });

  it('lets a founder find the roster and submit the worker form', async () => {
    render(React.createElement(AttendancePage));
    expect(screen.getByRole('link', { name: 'Workforce & Add Worker' }).getAttribute('href')).toBe('/attendance?tab=workforce');
    cleanup();
    mock.tab = 'tab=workforce';
    mock.createWorker.mockResolvedValue({ name: 'New Worker', position: 'Mason' });
    render(React.createElement(AttendancePage));
    fireEvent.click(screen.getByRole('button', { name: 'Add Worker' }));
    fireEvent.change(screen.getByLabelText('Worker Full Name'), { target: { value: 'New Worker' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add Worker to Roster' }));
    await waitFor(() => expect(mock.createWorker).toHaveBeenCalledWith(expect.objectContaining({ name: 'New Worker', position: 'Mason', active: true })));
    expect(mock.showToast).toHaveBeenCalledWith('success', expect.stringContaining('Added New Worker'));
  });
});
