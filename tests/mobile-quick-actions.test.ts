// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startQuickAction, useQuickAction, type QuickAction } from '@/lib/mobile/quickActions';

const receive = vi.fn();
function Destination({ ready = true }: { ready?: boolean }) {
  useQuickAction('/expenses', ['expense-manual', 'expense-scan', 'expense-describe'], ready, receive);
  return null;
}
beforeEach(() => { sessionStorage.clear(); receive.mockReset(); });
afterEach(cleanup);

describe('mobile action handoff', () => {
  it('waits for the destination to load, consumes only once, and does not create a record', () => {
    const navigate = vi.fn();
    expect(startQuickAction('expense-manual', '/expenses', '/dashboard', navigate)).toBe(true);
    expect(navigate).toHaveBeenCalledWith('/expenses');
    const page = render(React.createElement(Destination, { ready: false }));
    expect(receive).not.toHaveBeenCalled();
    page.rerender(React.createElement(Destination, { ready: true }));
    expect(receive).toHaveBeenCalledOnce();
    expect(receive).toHaveBeenCalledWith('expense-manual');
    expect(sessionStorage.getItem('asinta:mobile-quick-action')).toBeNull();
    page.unmount(); render(React.createElement(Destination));
    expect(receive).toHaveBeenCalledOnce();
  });
  it('handles repeated actions on the current page and respects a cancelled leave', () => {
    render(React.createElement(Destination));
    act(() => { startQuickAction('expense-describe', '/expenses', '/expenses', vi.fn()); });
    act(() => { startQuickAction('expense-scan', '/expenses', '/expenses', vi.fn()); });
    expect(receive.mock.calls.map(call => call[0] as QuickAction)).toEqual(['expense-describe', 'expense-scan']);
    const prevent = (event: Event) => event.preventDefault();
    window.addEventListener('asinta:quick-leave', prevent);
    const navigate = vi.fn();
    expect(startQuickAction('invoice', '/invoices', '/expenses', navigate)).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('asinta:mobile-quick-action')).toBeNull();
    window.removeEventListener('asinta:quick-leave', prevent);
  });
  it('ignores stale requests', () => {
    sessionStorage.setItem('asinta:mobile-quick-action', JSON.stringify({ action: 'expense-scan', destination: '/expenses', at: Date.now() - 121000 }));
    render(React.createElement(Destination));
    expect(receive).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('asinta:mobile-quick-action')).toBeNull();
  });
});
