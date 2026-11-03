// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let founder = true;
vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({
  default: ({ children, onClick, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => React.createElement('a', { ...props, onClick: (event: React.MouseEvent<HTMLAnchorElement>) => { event.preventDefault(); onClick?.(event); } }, children),
}));
vi.mock('@/lib/auth/authContext', () => ({ useAuth: () => ({ isFounder: founder }) }));
import { MobileNav } from '@/components/layout/MobileNav';

let desktopChange: (() => void) | undefined;
let desktop: boolean;

beforeEach(() => {
  founder = true;
  desktop = false;
  desktopChange = undefined;
  window.matchMedia = vi.fn().mockImplementation(() => ({
    get matches() { return desktop; },
    addEventListener: (_event: string, handler: () => void) => { desktopChange = handler; },
    removeEventListener: () => { desktopChange = undefined; },
  }));
});
afterEach(() => cleanup());

function swipe(element: Element, from: [number, number], to: [number, number]) {
  const start = { identifier: 1, clientX: from[0], clientY: from[1] };
  const end = { identifier: 1, clientX: to[0], clientY: to[1] };
  fireEvent.touchStart(element, { touches: [start], changedTouches: [start] });
  fireEvent.touchEnd(element, { touches: [], changedTouches: [end] });
}

describe('mobile workspace launcher', () => {
  it('opens a non-modal dialog, keeps the dock usable, and closes on Escape with focus return', async () => {
    render(React.createElement(MobileNav));
    const more = screen.getByRole('button', { name: 'More' });
    expect(more.getAttribute('aria-haspopup')).toBe('dialog');
    expect(more.getAttribute('aria-expanded')).toBe('false');
    more.focus();
    fireEvent.click(more);
    const dialog = screen.getByRole('dialog', { name: 'Workspace Modules' });
    expect(more.getAttribute('aria-expanded')).toBe('true');
    expect(more.getAttribute('aria-controls')).toBe(dialog.id);
    expect(dialog.getAttribute('aria-modal')).not.toBe('true');
    expect(within(dialog).getAllByRole('link')).toHaveLength(15);
    expect(within(dialog).getByRole('link', { name: 'Overview' }).getAttribute('aria-current')).toBe('page');
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(more);
    expect(more.getAttribute('aria-expanded')).toBe('false');
  });

  it('toggles More and lets a dock item close the launcher without stealing focus', async () => {
    render(React.createElement(MobileNav));
    const more = screen.getByRole('button', { name: 'More' });
    fireEvent.click(more);
    await waitFor(() => expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true));
    more.focus();
    fireEvent.click(more);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(more);
    const nav = screen.getByRole('navigation', { name: 'Mobile Bottom Navigation' });
    const projects = within(nav).getByRole('link', { name: 'Projects' });
    projects.focus();
    fireEvent.click(projects);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(projects);
  });

  it('accepts intentional up/down gestures, ignores sideways, small and scrolling gestures', () => {
    render(React.createElement(MobileNav));
    const nav = screen.getByRole('navigation', { name: 'Mobile Bottom Navigation' });
    swipe(nav, [100, 400], [180, 360]);
    swipe(nav, [100, 400], [100, 380]);
    expect(screen.queryByRole('dialog')).toBeNull();
    const projects = within(nav).getByRole('link', { name: 'Projects' });
    swipe(projects, [100, 400], [102, 330]);
    const dialog = screen.getByRole('dialog');
    // Do not activate a nav item if the browser synthesizes a click after a swipe.
    expect(fireEvent.click(projects, { detail: 1 })).toBe(false);
    expect(screen.getByRole('dialog')).toBe(dialog);
    swipe(dialog, [100, 100], [100, 200]); // Content scrolling is not a dismiss gesture.
    expect(screen.getByRole('dialog')).toBe(dialog);
    const handle = dialog.querySelector('[data-swipe-handle]')!;
    swipe(handle, [100, 100], [180, 140]);
    expect(screen.getByRole('dialog')).toBe(dialog);
    swipe(handle, [100, 100], [100, 170]);
    expect(screen.queryByRole('dialog')).toBeNull();
    // A real second touch on the same item must not be mistaken for a ghost click.
    const more = within(nav).getByRole('button', { name: 'More' });
    swipe(more, [280, 400], [280, 330]);
    expect(screen.getByRole('dialog')).toBeTruthy();
    const touch = { identifier: 2, clientX: 280, clientY: 400 };
    fireEvent.touchStart(more, { touches: [touch], changedTouches: [touch] });
    fireEvent.touchEnd(more, { touches: [], changedTouches: [touch] });
    fireEvent.click(more, { detail: 1 });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('does not open a Founder launcher for a Supervisor', () => {
    founder = false;
    render(React.createElement(MobileNav));
    const nav = screen.getByRole('navigation', { name: 'Mobile Bottom Navigation' });
    swipe(nav, [100, 400], [100, 300]);
    expect(screen.queryByRole('button', { name: 'More' })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes the mobile sheet when the viewport becomes desktop width', () => {
    render(React.createElement(MobileNav));
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    desktop = true;
    act(() => desktopChange?.());
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
