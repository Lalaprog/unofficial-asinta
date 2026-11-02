// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';

let tab = 'requests';
const replace = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => new URLSearchParams(`tab=${tab}`),
}));
vi.mock('@/components/layout/AppShell', () => ({ AppShell: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('@/components/advances/AdvanceRequestsPanel', () => ({
  AdvanceRequestsPanel: () => React.createElement('input', { 'aria-label': 'Request draft' }),
}));
vi.mock('@/lib/auth/authContext', () => ({ useAuth: () => ({ isFounder: true }) }));
vi.mock('@/lib/data/store', () => ({ useDataStore: () => ({ advances: [], workers: [], projects: [] }) }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
import AdvancesPage from '@/app/advances/page';

afterEach(() => { cleanup(); tab = 'requests'; replace.mockClear(); });

describe('motion interactions', () => {
  it('keeps shared buttons immediate and disabled buttons inert', () => {
    const click = vi.fn();
    const { rerender } = render(React.createElement(Button, { onClick: click }, 'Save'));
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button.className).toContain('motion-safe:active:scale-[0.98]');
    expect(button.className).toContain('transition-[color,background-color,border-color,box-shadow,transform]');
    fireEvent.click(button);
    expect(click).toHaveBeenCalledTimes(1);
    rerender(React.createElement(Button, { onClick: click, isLoading: true }, 'Save'));
    fireEvent.click(button);
    expect(click).toHaveBeenCalledTimes(1);
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it('closes dialogs and restores focus without waiting for motion', () => {
    function Fixture() {
      const [open, setOpen] = React.useState(false);
      return React.createElement(React.Fragment, null,
        React.createElement('button', { onClick: () => setOpen(true) }, 'Open'),
        React.createElement(Modal, { isOpen: open, onClose: () => setOpen(false), title: 'Example',
          children: React.createElement('input', { 'aria-label': 'Draft' }) }));
    }
    render(React.createElement(Fixture));
    const opener = screen.getByRole('button', { name: 'Open' });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole('dialog');
    expect(dialog.className).toContain('animate-dialog-enter');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close dialog' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(document.body.style.overflow).not.toBe('hidden');
  });

  it('keeps Bale drafts through rerenders and mounts a fresh entrance only on tab changes', () => {
    const { rerender } = render(React.createElement(AdvancesPage));
    const draft = screen.getByRole('textbox', { name: 'Request draft' }) as HTMLInputElement;
    fireEvent.change(draft, { target: { value: 'Draft value' } });
    const firstPanel = draft.closest('.animate-panel-enter');
    rerender(React.createElement(AdvancesPage));
    expect(screen.getByRole('textbox', { name: 'Request draft' })).toBe(draft);
    expect(draft.value).toBe('Draft value');
    expect(draft.closest('.animate-panel-enter')).toBe(firstPanel);
    fireEvent.click(screen.getByRole('button', { name: 'Issued advances' }));
    expect(replace).toHaveBeenCalledWith('/advances?tab=issued', { scroll: false });
    tab = 'issued';
    rerender(React.createElement(AdvancesPage));
    expect(screen.queryByRole('textbox', { name: 'Request draft' })).toBeNull();
    const nextPanel = screen.getByRole('heading', { name: 'Worker Advances (“Bale”)' }).closest('.animate-panel-enter');
    expect(nextPanel).toBeTruthy();
    expect(nextPanel).not.toBe(firstPanel);
    expect(screen.getByRole('button', { name: 'Issued advances' }).getAttribute('aria-pressed')).toBe('true');
  });
});
