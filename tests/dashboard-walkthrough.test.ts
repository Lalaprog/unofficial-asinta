// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DASHBOARD_GUIDE_EVENT, DashboardWalkthrough } from '@/components/dashboard/DashboardWalkthrough';

let mobile = true;
beforeEach(() => {
  mobile = true;
  window.matchMedia = vi.fn((query: string) => ({ matches: query.includes('max-width') ? mobile : query.includes('min-width') ? !mobile : true, addEventListener: vi.fn(), removeEventListener: vi.fn() })) as unknown as typeof window.matchMedia;
  window.scrollTo = vi.fn();
  for (const name of ['balances', 'workforce', 'costs', 'scope', 'attention', 'register']) {
    const el = document.createElement('section');
    el.dataset.dashboardGuide = name;
    el.getBoundingClientRect = () => ({ top: 100, bottom: 300, left: 10, right: 300, width: 290, height: 200, x: 10, y: 100, toJSON() {} });
    document.body.appendChild(el);
  }
});
afterEach(() => { cleanup(); document.querySelectorAll('[data-dashboard-guide]').forEach(el => el.remove()); });

describe('dashboard walkthrough', () => {
  it('only starts on request, moves through the guide and returns focus', () => {
    const trigger = document.createElement('button'); document.body.appendChild(trigger); trigger.focus();
    render(React.createElement(DashboardWalkthrough));
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => window.dispatchEvent(new Event(DASHBOARD_GUIDE_EVENT)));
    let dialog = screen.getByRole('dialog', { name: 'Client balances' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(within(dialog).getByText(/Draft and cancelled invoices are excluded/)).toBeTruthy();
    expect(window.scrollTo).toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Next' }));
    dialog = screen.getByRole('dialog', { name: 'Workforce & pay' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('dialog', { name: 'Client balances' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    act(() => window.dispatchEvent(new Event(DASHBOARD_GUIDE_EVENT)));
    for (let i = 0; i < 5; i++) fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('dialog', { name: 'Project register' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    trigger.remove();
  });
  it('opens on desktop and closes with Escape', () => {
    render(React.createElement(DashboardWalkthrough));
    mobile = false;
    act(() => window.dispatchEvent(new Event(DASHBOARD_GUIDE_EVENT)));
    expect(screen.getByRole('dialog', { name: 'Client balances' })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
