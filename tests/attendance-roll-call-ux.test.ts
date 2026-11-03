// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ supervisor: false, record: vi.fn(), toast: vi.fn(), createWorker: vi.fn() }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock('next/link', () => ({ default: ({ children, href, prefetch: _prefetch, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { prefetch?: boolean }) => React.createElement('a', { ...props, href }, children) }));
vi.mock('@/components/layout/AppShell', () => ({ AppShell: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('@/lib/auth/authContext', () => {
  const founder = { id: 'founder', name: 'Founder', role: 'founder' };
  const supervisor = { id: 'sup', name: 'Site Supervisor', role: 'supervisor' };
  return { useAuth: () => ({ user: mock.supervisor ? supervisor : founder, isFounder: !mock.supervisor, isSupervisor: mock.supervisor }) };
});
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ showToast: mock.toast }) }));
vi.mock('@/lib/data/store', () => {
  const worker = (id: string, name: string, position: string) => ({ id, name, position, active: true, pay_rate: 850, pay_rate_type: 'daily', contact_number: '—' });
  const projects = [{ id: 'site-1', name: 'Site One', location: 'Batangas, PH' }, { id: 'site-2', name: 'Site Two', location: 'Lipa, PH' }];
  const workers = [worker('sup', 'Site Supervisor', 'Site Supervisor'), worker('amy', 'Amy', 'Mason'), worker('ben', 'Ben', 'Mason'), worker('cara', 'Cara', 'Mason'), worker('dan', 'Dan', 'Mason'), worker('eva', 'Eva', 'Carpenter')];
  const attendance = [
    { id: 'b', worker_id: 'ben', project_id: 'site-1', date: '2026-11-03', status: 'half_day', notes: '', recorded_by: 'founder' },
    { id: 'c', worker_id: 'cara', project_id: 'site-1', date: '2026-11-03', status: 'absent', notes: '', recorded_by: 'founder' },
    { id: 'd', worker_id: 'dan', project_id: 'site-2', date: '2026-11-03', status: 'present', notes: '', recorded_by: 'founder' },
  ];
  const store = { projects, workers, attendance, users: [{ id: 'sup', name: 'Site Supervisor', role: 'supervisor' }], projectSupervisors: [{ project_id: 'site-1', supervisor_id: 'sup' }], isLoaded: true, createWorker: mock.createWorker, updateWorker: vi.fn(), toggleWorkerStatus: vi.fn(), recordAttendanceBatch: mock.record, updateAttendanceRecord: vi.fn(), getProjectsForSupervisor: () => projects };
  return { useDataStore: () => store };
});
import AttendancePage from '@/app/attendance/page';

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-03T04:00:00Z'));
  mock.supervisor = true; mock.record.mockReset(); mock.toast.mockReset(); mock.createWorker.mockReset();
  window.localStorage.clear(); window.history.replaceState({}, '', '/attendance');
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

function status(worker: string, label: string) {
  return within(screen.getByRole('group', { name: `Attendance status for ${worker}` })).getByRole('button', { name: label });
}

describe('roll call usability and safety', () => {
  it('shows full-roster counts while filters only affect the visible list', () => {
    render(React.createElement(AttendancePage));
    const summary = screen.getByRole('region', { name: 'Attendance summary' });
    expect(within(summary).getByText('3 of 5 marked · 2 remaining')).toBeTruthy();
    expect(within(summary).queryByRole('progressbar')).toBeNull();
    expect(screen.getByText('Auto-logged when you submit crew roll call.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Search roster workers'), { target: { value: 'Amy' } });
    expect(screen.getByText('Amy')).toBeTruthy();
    expect(screen.queryByText('Ben')).toBeNull();
    expect(within(summary).getByText('3 of 5 marked · 2 remaining')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Mark visible unmarked present' }));
    expect(status('Amy', 'Present').getAttribute('aria-pressed')).toBe('true');
    expect(within(summary).getByText('4 of 5 marked · 1 remaining')).toBeTruthy();
    expect(mock.record).not.toHaveBeenCalled();
  });

  it('keeps just-marked workers in the unmarked view until refresh and retains other statuses', () => {
    render(React.createElement(AttendancePage));
    fireEvent.click(screen.getByRole('button', { name: 'Unmarked only' }));
    expect(screen.getByText('Amy')).toBeTruthy();
    expect(screen.getByText('Eva')).toBeTruthy();
    expect(screen.queryByText('Ben')).toBeNull();
    expect(screen.queryByText('Dan')).toBeNull();
    expect(screen.queryByText('Site Supervisor')).toBeNull();
    const amyAbsent = status('Amy', 'Absent');
    amyAbsent.focus();
    fireEvent.click(amyAbsent);
    expect(document.activeElement).toBe(amyAbsent);
    expect(screen.getByText('Amy')).toBeTruthy();
    expect(status('Amy', 'Absent').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh unmarked list' }));
    expect(screen.queryByText('Amy')).toBeNull();
    expect(screen.getByText('Eva')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Unmarked only' }));
    expect(status('Amy', 'Absent').getAttribute('aria-pressed')).toBe('true');
    expect(status('Ben', 'Half Day').getAttribute('aria-pressed')).toBe('true');
    expect(status('Cara', 'Absent').getAttribute('aria-pressed')).toBe('true');
    expect(status('Dan', 'Absent').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText(/Already at Site Two/)).toBeTruthy();
  });

  it('resets the unmarked view on site changes and restores the correct local draft', () => {
    render(React.createElement(AttendancePage));
    fireEvent.click(status('Amy', 'Leave'));
    fireEvent.click(screen.getByRole('button', { name: 'Unmarked only' }));
    fireEvent.change(screen.getByLabelText('Project Site'), { target: { value: 'site-2' } });
    expect(screen.getByRole('button', { name: 'Unmarked only' }).getAttribute('aria-pressed')).toBe('false');
    expect(status('Amy', 'Leave').getAttribute('aria-pressed')).toBe('false');
    fireEvent.change(screen.getByLabelText('Project Site'), { target: { value: 'site-1' } });
    expect(status('Amy', 'Leave').getAttribute('aria-pressed')).toBe('true');
    cleanup();
    render(React.createElement(AttendancePage));
    expect(status('Amy', 'Leave').getAttribute('aria-pressed')).toBe('true');
    expect(mock.record).not.toHaveBeenCalled();
  });

  it('collapses with inert inaccessible content and keeps the draft on reopening', () => {
    render(React.createElement(AttendancePage));
    fireEvent.click(status('Amy', 'Leave'));
    const header = screen.getByRole('button', { name: /Masonry & Concrete/ });
    const panel = document.getElementById(header.getAttribute('aria-controls')!)!;
    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(panel.hasAttribute('inert')).toBe(true);
    expect(panel.getAttribute('aria-hidden')).toBe('true');
    expect(screen.queryByRole('group', { name: 'Attendance status for Amy' })).toBeNull();
    fireEvent.click(header);
    expect(panel.hasAttribute('inert')).toBe(false);
    expect(status('Amy', 'Leave').getAttribute('aria-pressed')).toBe('true');
  });

  it('bulk marks only unmarked crew and locks edits until submission finishes', async () => {
    let finish!: (value: boolean) => void;
    mock.record.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    render(React.createElement(AttendancePage));
    const masonry = screen.getByRole('button', { name: /Masonry & Concrete/ }).closest('.rounded-xl')!;
    fireEvent.click(within(masonry as HTMLElement).getByRole('button', { name: 'Mark remaining present' }));
    fireEvent.click(status('Eva', 'Present'));
    expect(status('Ben', 'Half Day').getAttribute('aria-pressed')).toBe('true');
    expect(status('Cara', 'Absent').getAttribute('aria-pressed')).toBe('true');
    expect(status('Dan', 'Absent').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    expect(mock.record).toHaveBeenCalledTimes(1);
    const sent = mock.record.mock.calls[0][0] as Array<{worker_id: string; status: string}>;
    expect(sent).toEqual(expect.arrayContaining([
      expect.objectContaining({ worker_id: 'amy', status: 'present' }),
      expect.objectContaining({ worker_id: 'ben', status: 'half_day' }),
      expect.objectContaining({ worker_id: 'cara', status: 'absent' }),
      expect.objectContaining({ worker_id: 'dan', status: 'absent' }),
      expect.objectContaining({ worker_id: 'eva', status: 'present' }),
      expect.objectContaining({ worker_id: 'sup', status: 'present' }),
    ]));
    expect((status('Amy', 'Absent') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Unmarked only' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { finish(false); });
    expect((status('Amy', 'Absent') as HTMLButtonElement).disabled).toBe(false);
    expect(status('Amy', 'Present').getAttribute('aria-pressed')).toBe('true');
  });
});
