// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project, UserNotification } from '@/types';
import { manilaDateISO } from '@/lib/dates/manila';

const mocks = vi.hoisted(() => ({
  auth: {} as Record<string, unknown>,
  store: {} as Record<string, unknown>,
  push: vi.fn(),
  replace: vi.fn(),
  compact: true,
}));
vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
  useRouter: () => ({ push: mocks.push, replace: mocks.replace }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({
  default: ({ children, onClick, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) =>
    React.createElement('a', { ...props, onClick: (event: React.MouseEvent<HTMLAnchorElement>) => { event.preventDefault(); onClick?.(event); } }, children),
}));
vi.mock('@/lib/auth/authContext', () => ({ useAuth: () => mocks.auth }));
vi.mock('@/lib/data/store', () => ({ useDataStore: () => mocks.store }));
import { Navbar } from '@/components/layout/Navbar';

const NOW = Date.parse('2026-11-03T12:00:00.000Z');
const age = (milliseconds: number) => new Date(NOW - milliseconds).toISOString();
const project: Project = {
  id: 'site-1', name: 'Malaya House', client_id: 'client-1', location: 'Batangas',
  budget_estimate: 100000, status: 'active', start_date: '2026-01-01',
  target_completion_date: '2026-12-31', created_at: age(86_400_000),
};
function storedEvent(id: string, created_at: string, overrides: Partial<UserNotification> = {}): UserNotification {
  return {
    id, recipient_id: 'founder-1', event_type: 'advance_request_submitted',
    advance_request_id: `request-${id}`, worker_id: 'worker-1', project_id: project.id,
    requested_amount: 500, created_at, read_at: null, ...overrides,
  };
}
function setStore(events: UserNotification[] = [], attendance: Record<string, unknown>[] = []) {
  mocks.store = {
    invoices: [], attendance, payroll: [], projects: [project],
    workers: [{ id: 'worker-1', name: 'Carlos Reyes', position: 'Mason' }], users: [],
    userNotifications: events,
    getProjectsForSupervisor: () => [project],
    markUserNotificationsRead: vi.fn().mockResolvedValue(true),
    refresh: vi.fn().mockResolvedValue(undefined),
  };
}
const bell = () => screen.getByRole('button', { name: /actionable notifications?|Notifications/ });
async function openPanel() {
  fireEvent.click(bell());
  return screen.findByRole('dialog');
}
function itemByTitle(panel: HTMLElement, title: string) {
  const button = within(panel).getAllByRole('button', { name: new RegExp(title) })
    .find((candidate) => !candidate.getAttribute('aria-label')?.startsWith('Dismiss'))!;
  return button.closest('li')!;
}

let originalComputedStyle: typeof window.getComputedStyle;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  window.localStorage.clear();
  mocks.compact = true;
  mocks.auth = {
    user: { id: 'founder-1', name: 'Founder', email: 'founder@example.test' },
    isFounder: true, isSupervisor: false, logout: vi.fn(),
  };
  setStore();
  mocks.push.mockClear();
  mocks.replace.mockClear();
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query.includes('max-width') ? mocks.compact : false,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(),
  }));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  // jsdom does not load Tailwind. Expose the two animation names so Radix's
  // real Presence component retains the exit shell until animationend.
  originalComputedStyle = window.getComputedStyle;
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => {
    const styles = originalComputedStyle(element);
    if (element instanceof HTMLElement && element.classList.contains('notification-popover')) {
      Object.defineProperty(styles, 'animationName', {
        configurable: true,
        get: () => element.dataset.state === 'open' ? 'asintaNotificationOpen' : 'asintaNotificationClose',
      });
    }
    return styles;
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('notification timestamp provenance', () => {
  it('keeps the Founder overdue invoice notice and manual reminder action', async () => {
    mocks.store.invoices = [
      {id:'overdue', invoice_number:'INV-001', due_date:'2026-10-30', status:'pending', amount:1000, amount_paid:200},
      {id:'paid', invoice_number:'INV-PAID', due_date:'2026-10-30', status:'paid', amount:1000, amount_paid:1000},
    ];
    const fetchSpy=vi.fn();vi.stubGlobal('fetch',fetchSpy);
    render(React.createElement(Navbar));
    const panel=await openPanel();
    const notice=itemByTitle(panel,'Overdue Billing: INV-001');
    expect(within(notice).getByText(/balance past due/)).toBeTruthy();
    expect(within(notice).getByText('Collect or Send Reminder')).toBeTruthy();
    expect(within(panel).queryByText(/INV-PAID/)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('labels a site group with its newest stored event, not its first row or render time', async () => {
    setStore([storedEvent('old', age(7_200_000)), storedEvent('new', age(30_000))]);
    render(React.createElement(Navbar));
    const panel = await openPanel();
    const group = itemByTitle(panel, '2 new Bale requests');
    expect(within(group).getByText('Latest: 30 seconds ago')).toBeTruthy();
    expect(within(group).getByText('Latest: 30 seconds ago').getAttribute('datetime')).toBe(age(30_000));
    expect(within(group).queryByText(/Recorded:/)).toBeNull();
  });

  it('omits timestamps from generated attendance reminders', async () => {
    render(React.createElement(Navbar));
    const panel = await openPanel();
    const reminder = itemByTitle(panel, "Today's Site Attendance Pending");
    expect(within(reminder).queryByText(/Latest:|Recorded:|just now/)).toBeNull();
    expect(panel.querySelector('time')).toBeNull();
  });

  it('shows a stored Supervisor event age without repeating a date in its description', async () => {
    mocks.auth = { ...mocks.auth, user: { id: 'supervisor-1' }, isFounder: false, isSupervisor: true };
    setStore([storedEvent('approved', age(7_200_000), {
      recipient_id: 'supervisor-1', event_type: 'advance_request_approved',
    })], [{
      id: 'attendance-1', worker_id: 'worker-1', project_id: project.id,
      date: manilaDateISO(new Date(NOW)), status: 'present', is_founder_override: true,
      submitted_at: age(60_000), recorded_by: 'founder-1',
    }]);
    render(React.createElement(Navbar));
    const panel = await openPanel();
    const event = itemByTitle(panel, 'Bale request approved');
    expect(within(event).getByText('Recorded: 2 hours ago')).toBeTruthy();
    expect(within(event).queryByText(/Nov 3|November 3/)).toBeNull();
    const override = itemByTitle(panel, 'Founder updated an attendance record');
    expect(within(override).queryByText(/Recorded:|Latest:|just now/)).toBeNull();
  });

  it('refreshes ages from the device clock while open and exposes the absolute source time', async () => {
    setStore([storedEvent('new', age(30_000))]);
    render(React.createElement(Navbar));
    const panel = await openPanel();
    expect(within(panel).getByText('Latest: 30 seconds ago').getAttribute('title')).toContain('Philippine time');
    vi.setSystemTime(NOW + 31_000);
    fireEvent(window, new Event('focus'));
    expect(within(panel).getByText('Latest: 1 minute ago')).toBeTruthy();
  });

  it('discloses a future stored timestamp instead of calling it new', async () => {
    setStore([storedEvent('future', age(-60_000))]);
    render(React.createElement(Navbar));
    const panel = await openPanel();
    expect(within(panel).getByText('Latest: time unavailable').getAttribute('title')).toContain('ahead of your device clock');
  });
});

describe('bell-anchored notification controls', () => {
  it('uses one non-modal popover, keeps the bell connected, and returns focus on Escape', async () => {
    mocks.compact = false;
    setStore([storedEvent('one', age(60_000))]);
    render(React.createElement(Navbar));
    const trigger = bell();
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
    const panel = await openPanel();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(trigger.getAttribute('aria-controls')).toBe(panel.id);
    expect(panel.getAttribute('aria-modal')).toBe('false');
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    await waitFor(() => expect(panel.contains(document.activeElement)).toBe(true));
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(document.activeElement).toBe(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('keeps the closing preview inert and removes it after the exit animation', async () => {
    render(React.createElement(Navbar));
    const panel = await openPanel();
    const start = new window.Event('animationstart', { bubbles: true });
    Object.defineProperty(start, 'animationName', { value: 'asintaNotificationOpen' });
    fireEvent(panel, start);
    fireEvent.click(within(panel).getByRole('button', { name: 'Close notifications' }));
    expect(document.activeElement).toBe(bell());
    expect(panel.hasAttribute('inert')).toBe(true);
    expect(panel.getAttribute('aria-hidden')).toBe('true');
    expect(panel.dataset.state).toBe('closed');
    const end = new window.Event('animationend', { bubbles: true });
    Object.defineProperty(end, 'animationName', { value: 'asintaNotificationClose' });
    fireEvent(panel, end);
    await waitFor(() => expect(document.getElementById(panel.id)).toBeNull());
  });

  it('preserves grouped read actions, clear all, sync and navigation', async () => {
    const events = [storedEvent('one', age(60_000)), storedEvent('two', age(30_000))];
    setStore(events);
    render(React.createElement(Navbar));
    let panel = await openPanel();
    fireEvent.click(within(panel).getByRole('button', { name: 'Sync notifications now' }));
    expect(mocks.store.refresh).toHaveBeenCalledWith({ silent: true });
    fireEvent.click(within(panel).getByRole('button', { name: 'Dismiss 2 new Bale requests · Malaya House' }));
    expect(mocks.store.markUserNotificationsRead).toHaveBeenCalledWith(['one', 'two']);
    fireEvent.click(within(panel).getByRole('button', { name: 'Clear all' }));
    expect(mocks.store.markUserNotificationsRead).toHaveBeenCalledWith(['one', 'two']);
    fireEvent.click(within(panel).getByRole('button', { name: /Review site requests/ }));
    expect(mocks.push).toHaveBeenCalledWith('/advances?tab=requests&site=site-1');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    panel = await openPanel();
    expect(itemByTitle(panel, '2 new Bale requests')).toBeTruthy();
  });

  it('can restore a locally cleared generated reminder without writing a stored event', async () => {
    render(React.createElement(Navbar));
    const panel = await openPanel();
    fireEvent.click(within(panel).getByRole('button', { name: "Dismiss Today's Site Attendance Pending" }));
    expect(mocks.store.markUserNotificationsRead).not.toHaveBeenCalled();
    fireEvent.click(within(panel).getByRole('button', { name: 'Show 1 cleared notification' }));
    expect(itemByTitle(panel, "Today's Site Attendance Pending")).toBeTruthy();
  });
});

describe('dashboard help entry', () => {
  it('offers the mobile guide to a Founder without changing notifications', () => {
    render(React.createElement(Navbar));
    const listener = vi.fn();
    window.addEventListener('asinta:dashboard-guide', listener);
    const help = screen.getByRole('button', { name: 'Open dashboard guide' });
    expect(help.className).toContain('lg:hidden');
    fireEvent.click(help);
    expect(listener).toHaveBeenCalledOnce();
    expect(bell()).toBeTruthy();
    window.removeEventListener('asinta:dashboard-guide', listener);
  });
  it('does not offer the Founder dashboard guide to Supervisors', () => {
    mocks.auth = { ...mocks.auth, isFounder: false, isSupervisor: true };
    render(React.createElement(Navbar));
    expect(screen.queryByRole('button', { name: 'Open dashboard guide' })).toBeNull();
  });
});
