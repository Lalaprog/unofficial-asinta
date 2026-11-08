// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getWorkspaceGuide, WORKSPACE_GUIDE_EVENT } from '@/lib/guides/workspace';
import { WorkspaceWalkthrough } from '@/components/dashboard/WorkspaceWalkthrough';

let path = '/projects';
let tab = 'terminal';
vi.mock('next/navigation', () => ({ usePathname: () => path, useSearchParams: () => new URLSearchParams(tab === 'terminal' ? '' : `tab=${tab}`) }));
beforeEach(() => {
  path = '/projects'; tab = 'terminal';
  window.matchMedia = vi.fn(() => ({ matches: false })) as unknown as typeof window.matchMedia;
  window.scrollTo = vi.fn();
  for (const name of ['intro', 'action', 'filters', 'list', 'tabs', 'details']) {
    const target = document.createElement('section'); target.dataset.pageGuide = name;
    target.getBoundingClientRect = () => ({ top: 100, bottom: 250, left: 10, right: 300, width: 290, height: 150, x: 10, y: 100, toJSON() {} });
    document.body.appendChild(target);
  }
});
afterEach(() => { cleanup(); document.querySelectorAll('[data-page-guide]').forEach(el => el.remove()); });

describe('workspace guide selection', () => {
  it('covers founder workspaces and project details, but not unknown or special-tour routes', () => {
    for (const route of ['/projects','/projects/123','/attendance','/payroll','/advances','/invoices','/expenses','/clients','/tools','/users','/reminders','/sms','/settings']) {
      expect(getWorkspaceGuide(route, true, route === '/attendance' ? 'history' : 'terminal'), route).not.toBeNull();
    }
    expect(getWorkspaceGuide('/dashboard', true)).toBeNull();
    expect(getWorkspaceGuide('/attendance', true, 'terminal')).toBeNull();
    expect(getWorkspaceGuide('/unknown', true)).toBeNull();
  });
  it('only offers supervisor routes and gives role-specific directions', () => {
    for (const route of ['/projects','/projects/123','/advances','/settings']) expect(getWorkspaceGuide(route, false)).not.toBeNull();
    for (const route of ['/payroll','/invoices','/expenses','/clients','/tools','/users','/reminders','/sms']) expect(getWorkspaceGuide(route, false)).toBeNull();
    expect(JSON.stringify(getWorkspaceGuide('/projects/123', false))).not.toMatch(/invoices|expenses/i);
    expect(JSON.stringify(getWorkspaceGuide('/advances', false))).toMatch(/Founder reviews/);
    expect(JSON.stringify(getWorkspaceGuide('/advances', true, 'issued'))).toMatch(/Review outstanding advances/);
    expect(JSON.stringify(getWorkspaceGuide('/advances', true, 'requests'))).toMatch(/Approve or reject/);
    expect(JSON.stringify(getWorkspaceGuide('/attendance', true, 'workforce'))).toMatch(/unprocessed dates/);
    expect(JSON.stringify(getWorkspaceGuide('/attendance', false, 'workforce'))).not.toMatch(/restore returns/i);
  });
  it('opens on desktop only when requested, supports keyboard and restores focus', () => {
    const trigger = document.createElement('button'); document.body.appendChild(trigger); trigger.focus();
    render(React.createElement(WorkspaceWalkthrough, { isFounder: true }));
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => window.dispatchEvent(new Event(WORKSPACE_GUIDE_EVENT)));
    const dialog = screen.getByRole('dialog', { name: 'Project sites' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(window.scrollTo).toHaveBeenCalled();
    const last = within(dialog).getByRole('button', { name: 'Next' }); last.focus();
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: /Close/ }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull(); expect(document.activeElement).toBe(trigger); trigger.remove();
  });
  it('follows immediate attendance tab events and closes on route changes', () => {
    path = '/attendance'; tab = 'history';
    const { rerender } = render(React.createElement(WorkspaceWalkthrough, { isFounder: true }));
    act(() => window.dispatchEvent(new Event(WORKSPACE_GUIDE_EVENT)));
    expect(screen.getByRole('dialog', { name: 'Attendance history' })).toBeTruthy();
    act(() => window.dispatchEvent(new CustomEvent('bale:attendance-tab', { detail: 'workforce' })));
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => window.dispatchEvent(new Event(WORKSPACE_GUIDE_EVENT)));
    expect(screen.getByRole('dialog', { name: 'Workforce roster' })).toBeTruthy();
    path = '/expenses'; rerender(React.createElement(WorkspaceWalkthrough, { isFounder: true }));
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => window.dispatchEvent(new Event(WORKSPACE_GUIDE_EVENT)));
    expect(screen.getByRole('dialog', { name: 'Site expenses' })).toBeTruthy();
  });
  it('explains when a target is missing instead of highlighting the wrong section', () => {
    document.querySelector('[data-page-guide="intro"]')?.remove();
    render(React.createElement(WorkspaceWalkthrough, { isFounder: true }));
    act(() => window.dispatchEvent(new Event(WORKSPACE_GUIDE_EVENT)));
    expect(screen.getByText(/section is not currently visible/)).toBeTruthy();
    expect(window.scrollTo).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('dialog', { name: 'Create a project' })).toBeTruthy();
  });
});
