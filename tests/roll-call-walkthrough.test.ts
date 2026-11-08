// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ROLL_CALL_GUIDE_EVENT } from '@/components/dashboard/DashboardWalkthrough';
import { RollCallWalkthrough } from '@/components/dashboard/RollCallWalkthrough';

beforeEach(() => {
  window.matchMedia = vi.fn((query: string) => ({ matches: query.includes('max-width'), addEventListener: vi.fn(), removeEventListener: vi.fn() })) as unknown as typeof window.matchMedia;
  window.scrollTo = vi.fn();
  for (const name of ['site', 'summary', 'filters', 'crew', 'submit']) {
    const target = document.createElement('section');
    target.dataset.rollCallGuide = name;
    target.getBoundingClientRect = () => ({ top: 100, bottom: 250, left: 10, right: 300, width: 290, height: 150, x: 10, y: 100, toJSON() {} });
    document.body.appendChild(target);
  }
});
afterEach(() => { cleanup(); document.querySelectorAll('[data-roll-call-guide]').forEach(el => el.remove()); });

describe('Roll Call mobile guide', () => {
  it.each([true, false])('starts only on request and gives role-appropriate submit guidance for supervisor=%s', (supervisor) => {
    const trigger = document.createElement('button'); document.body.appendChild(trigger); trigger.focus();
    render(React.createElement(RollCallWalkthrough, { isSupervisor: supervisor }));
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => window.dispatchEvent(new Event(ROLL_CALL_GUIDE_EVENT)));
    expect(screen.getByRole('dialog', { name: 'Project and date' })).toBeTruthy();
    for (let i = 0; i < 4; i++) fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    const dialog = screen.getByRole('dialog', { name: supervisor ? 'Submit Roll Call' : 'Save Roll Call' });
    expect(within(dialog).getByText(supervisor ? /linked Supervisor attendance/ : /Supervisor attendance may need Founder review/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });
});
