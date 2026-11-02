// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({
  default: ({ children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => React.createElement('a', props, children),
}));
vi.mock('@/lib/auth/authContext', () => ({ useAuth: () => ({ isFounder: true }) }));
import { MobileNav } from '@/components/layout/MobileNav';

let desktopChange: (() => void) | undefined;
let desktop: boolean;
let originalOffsetParent: PropertyDescriptor | undefined;

beforeEach(() => {
  desktop = false;
  desktopChange = undefined;
  // JSDOM does not perform layout; let the modal's visibility check identify
  // the rendered focusable elements, as a real browser does.
  originalOffsetParent = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent');
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', { configurable: true, get: () => document.body });
  window.matchMedia = vi.fn().mockImplementation(() => ({
    get matches() { return desktop; },
    addEventListener: (_event: string, handler: () => void) => { desktopChange = handler; },
    removeEventListener: () => { desktopChange = undefined; },
  }));
});
afterEach(() => {
  cleanup();
  if (originalOffsetParent) Object.defineProperty(HTMLElement.prototype, 'offsetParent', originalOffsetParent);
  else delete (HTMLElement.prototype as { offsetParent?: unknown }).offsetParent;
});

describe('mobile workspace launcher', () => {
  it('opens an accessible dialog, traps keyboard focus, closes on Escape and restores focus', async () => {
    render(React.createElement(MobileNav));
    const more = screen.getByRole('button', { name: 'More' });
    expect(more.getAttribute('aria-haspopup')).toBe('dialog');
    expect(more.getAttribute('aria-expanded')).toBe('false');
    more.focus();
    fireEvent.click(more);
    const dialog = screen.getByRole('dialog', { name: 'Workspace Modules' });
    expect(more.getAttribute('aria-expanded')).toBe('true');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(within(dialog).getAllByRole('link')).toHaveLength(15);
    expect(within(dialog).getByRole('link', { name: 'Overview' }).getAttribute('aria-current')).toBe('page');
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    const close = within(dialog).getByRole('button', { name: 'Close dialog' });
    const lastLink = within(dialog).getByRole('link', { name: 'Settings' });
    lastLink.focus();
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(lastLink);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(more);
    expect(more.getAttribute('aria-expanded')).toBe('false');
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
