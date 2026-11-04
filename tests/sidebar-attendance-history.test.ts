// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const route = vi.hoisted(() => ({ pathname: '/dashboard', search: '', founder: true }));
vi.mock('next/navigation', () => ({
  usePathname: () => route.pathname,
  useSearchParams: () => new URLSearchParams(route.search),
}));
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) =>
    React.createElement('a', { ...props, href }, children),
}));
vi.mock('@/lib/auth/authContext', () => ({ useAuth: () => ({ isFounder: route.founder }) }));

import { Sidebar } from '@/components/layout/Sidebar';

beforeEach(() => {
  route.pathname = '/dashboard';
  route.search = '';
  route.founder = true;
});
afterEach(cleanup);

function nav(label: string) {
  return screen.getByRole('navigation', { name: label });
}
function currentLinks(container: HTMLElement) {
  return within(container).getAllByRole('link').filter((link) => link.getAttribute('aria-current') === 'page');
}

describe('attendance history in desktop navigation', () => {
  it('exposes a direct Founder history link without removing existing items', () => {
    render(React.createElement(Sidebar));
    fireEvent.click(screen.getByRole('button', { name: 'Workforce & Pay' }));
    const workforce = nav('Workforce & Pay');
    expect(within(workforce).getByRole('link', { name: 'Attendance History' }).getAttribute('href')).toBe('/attendance?tab=history');
    expect(within(workforce).getByRole('link', { name: 'Attendance' }).getAttribute('href')).toBe('/attendance');
    expect(within(workforce).getByRole('link', { name: 'Payroll' }).getAttribute('href')).toBe('/payroll');
    expect(within(workforce).getByRole('link', { name: 'Bale Requests & Advances' }).getAttribute('href')).toBe('/advances');
  });

  it('highlights only the correct Founder item when the URL changes', () => {
    route.pathname = '/attendance';
    const view = render(React.createElement(Sidebar));
    let workforce = nav('Workforce & Pay');
    expect(currentLinks(workforce).map((link) => link.textContent)).toEqual(['Attendance']);
    route.search = 'tab=history';
    view.rerender(React.createElement(Sidebar));
    workforce = nav('Workforce & Pay');
    expect(currentLinks(workforce).map((link) => link.textContent)).toEqual(['Attendance History']);
    route.search = 'tab=workforce';
    view.rerender(React.createElement(Sidebar));
    expect(currentLinks(workforce).map((link) => link.textContent)).toEqual(['Attendance']);
    route.search = '';
    view.rerender(React.createElement(Sidebar));
    expect(currentLinks(workforce).map((link) => link.textContent)).toEqual(['Attendance']);
  });

  it('tracks instant attendance-tab events so resizing from mobile keeps the right link active', () => {
    route.pathname = '/attendance';
    render(React.createElement(Sidebar));
    const workforce = nav('Workforce & Pay');
    act(() => window.dispatchEvent(new CustomEvent('bale:attendance-tab', { detail: 'history' })));
    expect(currentLinks(workforce).map((link) => link.textContent)).toEqual(['Attendance History']);
    act(() => window.dispatchEvent(new CustomEvent('bale:attendance-tab', { detail: 'terminal' })));
    expect(currentLinks(workforce).map((link) => link.textContent)).toEqual(['Attendance']);
  });

  it('preserves the Supervisor history, workforce and roll-call links and active states', () => {
    route.founder = false;
    route.pathname = '/attendance';
    route.search = 'tab=history';
    const view = render(React.createElement(Sidebar));
    const field = nav('Field Operations');
    expect(within(field).getByRole('link', { name: 'Attendance History' }).getAttribute('href')).toBe('/attendance?tab=history');
    expect(currentLinks(field).map((link) => link.textContent)).toEqual(['Attendance History']);
    route.search = 'tab=workforce';
    view.rerender(React.createElement(Sidebar));
    expect(currentLinks(field).map((link) => link.textContent)).toEqual(['Workforce Roster']);
    route.search = '';
    view.rerender(React.createElement(Sidebar));
    expect(currentLinks(field).map((link) => link.textContent)).toEqual(['Site Attendance']);
  });
});
