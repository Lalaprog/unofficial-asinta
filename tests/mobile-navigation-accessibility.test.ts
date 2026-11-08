// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let founder = true;
const push = vi.fn();
vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
  useRouter: () => ({ push }),
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
  sessionStorage.clear();
  push.mockReset();
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
    const content = dialog.querySelector('[data-launcher-content]') as HTMLElement;
    content.scrollTop = 100;
    swipe(content, [100, 100], [100, 200]); // A scrolled list continues scrolling.
    expect(screen.getByRole('dialog')).toBe(dialog);
    content.scrollTop = 0;
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


  it('tracks the finger during opening and closing, with a non-interactive preview', async () => {
    render(React.createElement(MobileNav));
    const nav = screen.getByRole('navigation', { name: 'Mobile Bottom Navigation' });
    const more = within(nav).getByRole('button', { name: 'More' });
    expect(nav.querySelector('[data-dock-handle]')).toBeTruthy();
    const touch = (y: number) => ({ identifier: 1, clientX: 120, clientY: y });
    fireEvent.touchStart(nav, { touches: [touch(400)] });
    fireEvent.touchMove(nav, { touches: [touch(380)] });
    let panel = document.querySelector('#mobile-workspace-panel') as HTMLElement;
    expect(panel.style.transform).toContain('20px');
    expect(panel.style.transition).toBe('none');
    expect(panel.hasAttribute('inert')).toBe(true);
    expect(panel.getAttribute('aria-hidden')).toBe('true');
    expect(Array.from(panel.querySelectorAll('a, button')).every((element) => element.getAttribute('tabindex') === '-1')).toBe(true);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(nav.querySelector('[data-dock-handle]')).toBeNull();
    fireEvent.touchMove(nav, { touches: [touch(330)] });
    expect(panel.style.transform).toContain('70px');
    fireEvent.touchEnd(nav, { touches: [], changedTouches: [touch(330)] });
    const dialog = screen.getByRole('dialog', { name: 'Workspace Modules' });
    expect(dialog).toBe(panel);
    expect(panel.hasAttribute('inert')).toBe(false);
    expect(panel.style.transform).toBe('translateY(0)');
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    const handle = dialog.querySelector('[data-swipe-handle]')!;
    fireEvent.touchStart(handle, { touches: [touch(100)] });
    fireEvent.touchMove(handle, { touches: [touch(130)] });
    expect(panel.style.transform).toBe('translateY(30px)');
    fireEvent.touchEnd(handle, { touches: [], changedTouches: [touch(130)] });
    expect(screen.getByRole('dialog')).toBe(dialog);
    expect(panel.style.transform).toBe('translateY(0)');
    fireEvent.touchStart(handle, { touches: [touch(100)] });
    fireEvent.touchMove(handle, { touches: [touch(170)] });
    expect(panel.style.transform).toBe('translateY(70px)');
    fireEvent.touchEnd(handle, { touches: [], changedTouches: [touch(170)] });
    expect(screen.queryByRole('dialog')).toBeNull();
    panel = document.querySelector('#mobile-workspace-panel') as HTMLElement;
    expect(panel.style.transform).toBe('translateY(100%)');
    expect(panel.hasAttribute('inert')).toBe(true);
    expect(document.activeElement).toBe(more);
  });

  it('retracts short and cancelled drags without opening or trapping focus', () => {
    render(React.createElement(MobileNav));
    const nav = screen.getByRole('navigation', { name: 'Mobile Bottom Navigation' });
    const touch = (y: number) => ({ identifier: 1, clientX: 120, clientY: y });
    fireEvent.touchStart(nav, { touches: [touch(400)] });
    fireEvent.touchMove(nav, { touches: [touch(375)] });
    fireEvent.touchEnd(nav, { touches: [], changedTouches: [touch(375)] });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect((document.querySelector('#mobile-workspace-panel') as HTMLElement).style.transform).toBe('translateY(100%)');
    fireEvent.touchStart(nav, { touches: [touch(400)] });
    fireEvent.touchMove(nav, { touches: [touch(350)] });
    fireEvent.touchCancel(nav);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect((document.querySelector('#mobile-workspace-panel') as HTMLElement).style.transform).toBe('translateY(100%)');
  });


  it('settles without lingering visual shells when reduced motion is requested', () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('prefers-reduced-motion'), addEventListener: vi.fn(), removeEventListener: vi.fn(),
    }));
    render(React.createElement(MobileNav));
    const nav = screen.getByRole('navigation', { name: 'Mobile Bottom Navigation' });
    const touch = (y: number) => ({ identifier: 1, clientX: 120, clientY: y });
    fireEvent.touchStart(nav, { touches: [touch(400)] });
    fireEvent.touchMove(nav, { touches: [touch(375)] });
    fireEvent.touchEnd(nav, { touches: [], changedTouches: [touch(375)] });
    expect(document.querySelector('#mobile-workspace-panel')).toBeNull();
    expect(nav.querySelector('[data-dock-handle]')).toBeTruthy();
  });

  it('does not open a Founder launcher for a Supervisor', () => {
    founder = false;
    render(React.createElement(MobileNav));
    const nav = screen.getByRole('navigation', { name: 'Mobile Bottom Navigation' });
    swipe(nav, [100, 400], [100, 300]);
    expect(screen.queryByRole('button', { name: 'More' })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });


  it('shows the highlighted action button and groups the three expense starts without removing More', () => {
    render(React.createElement(MobileNav));
    const nav = screen.getByRole('navigation', { name: 'Mobile Bottom Navigation' });
    const quick = within(nav).getByRole('button', { name: 'Quick actions' });
    expect(quick.textContent).toBe('');
    expect(within(nav).getByRole('button', { name: 'More' })).toBeTruthy();
    expect(within(nav).queryByRole('link', { name: 'Payroll' })).toBeNull();
    fireEvent.click(quick);
    let dialog = screen.getByRole('dialog', { name: 'Quick actions' });
    expect(within(dialog).getByRole('button', { name: 'New invoice' })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Expense' }));
    dialog = screen.getByRole('dialog', { name: 'Start an expense' });
    for (const name of ['Scan receipt', 'Describe', 'Manual entry']) expect(within(dialog).getByRole('button', { name })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Describe' }));
    expect(push).toHaveBeenCalledWith('/expenses');
    expect(JSON.parse(sessionStorage.getItem('asinta:mobile-quick-action')!).action).toBe('expense-describe');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('drags from panel content at the top, without selecting a link', () => {
    render(React.createElement(MobileNav));
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    const panel = screen.getByRole('dialog');
    const content = panel.querySelector('[data-launcher-content]')!;
    const link = within(content as HTMLElement).getByRole('link', { name: 'Expenses' });
    const touch = (y: number) => ({ identifier: 1, clientX: 100, clientY: y });
    fireEvent.touchStart(link, { touches: [touch(100)] });
    const move = new Event('touchmove', { bubbles: true, cancelable: true });
    Object.defineProperty(move, 'touches', { value: [touch(170)] });
    fireEvent(link, move);
    expect(move.defaultPrevented).toBe(true);
    expect((panel as HTMLElement).style.transform).toBe('translateY(70px)');
    fireEvent.touchEnd(link, { touches: [], changedTouches: [touch(170)] });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(fireEvent.click(link, { detail: 1 })).toBe(false);
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
