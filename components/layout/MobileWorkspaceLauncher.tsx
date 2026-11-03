'use client';

import React, { useEffect, useLayoutEffect, useRef } from 'react';
import Link from 'next/link';
import { X } from 'lucide-react';
import {
  LayoutDashboard, FolderKanban, Receipt, CreditCard, UserCheck, History,
  UserPlus, HandCoins, Banknote, Users, Wrench, MessageSquareShare,
  CalendarClock, Settings, ShieldCheck,
} from 'lucide-react';

const FOUNDER_APP_GRID_SECTIONS = [
  {
    label: 'Studio & Workforce',
    items: [
      { label: 'Overview', href: '/dashboard', icon: LayoutDashboard },
      { label: 'Projects', href: '/projects', icon: FolderKanban },
      { label: 'Roll Call', href: '/attendance', icon: UserCheck },
      { label: 'History', href: '/attendance?tab=history', icon: History },
      { label: 'Workforce', href: '/attendance?tab=workforce', icon: UserPlus },
      { label: 'Payroll', href: '/payroll', icon: Banknote },
    ],
  },
  {
    label: 'Receivables & Ledger',
    items: [
      { label: 'Invoices', href: '/invoices', icon: Receipt },
      { label: 'Clients', href: '/clients', icon: Users },
      { label: 'Expenses', href: '/expenses', icon: CreditCard },
      { label: 'Worker Bale', href: '/advances', icon: HandCoins },
      { label: 'Reminders', href: '/reminders', icon: CalendarClock },
      { label: 'PhilSMS', href: '/sms', icon: MessageSquareShare },
    ],
  },
  {
    label: 'Equipment & Administration',
    items: [
      { label: 'Tools', href: '/tools', icon: Wrench },
      { label: 'Team', href: '/users', icon: ShieldCheck },
      { label: 'Settings', href: '/settings', icon: Settings },
    ],
  },
];

interface MobileWorkspaceLauncherProps {
  isOpen: boolean;
  onClose: () => void;
  navHeight: number | null;
  returnFocusRef: React.RefObject<HTMLButtonElement>;
  isHrefActive: (href: string) => boolean;
  onNavigate: (event: React.MouseEvent<HTMLAnchorElement>, href: string) => void;
}

/** Non-modal so the dock remains usable while the launcher is open. */
export const MobileWorkspaceLauncher: React.FC<MobileWorkspaceLauncherProps> = ({
  isOpen, onClose, isHrefActive, onNavigate, navHeight, returnFocusRef,
}) => {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  const swipeStart = useRef<{ x: number; y: number; id: number } | null>(null);
  onCloseRef.current = onClose;

  useLayoutEffect(() => {
    if (!isOpen) return;
    const panel = panelRef.current;
    const returnFocus = returnFocusRef.current;
    let lastFocusWasInside = false;
    const onFocus = (event: FocusEvent) => { lastFocusWasInside = Boolean(panel?.contains(event.target as Node)); };
    document.addEventListener('focusin', onFocus);
    const frame = window.requestAnimationFrame(() => closeRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      // Do not steal focus from a dock item the user selected while open.
      document.removeEventListener('focusin', onFocus);
      if ((panel?.contains(document.activeElement) || (document.activeElement === document.body && lastFocusWasInside)) && !window.matchMedia('(min-width: 1024px)').matches) {
        returnFocus?.focus();
      }
    };
  }, [isOpen, returnFocusRef]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onCloseRef.current(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen]);

  if (!isOpen) return null;
  const bottom = navHeight === null ? 'calc(4.5rem + env(safe-area-inset-bottom))' : `${navHeight}px`;
  const onHandleTouchStart = (event: React.TouchEvent) => {
    if (event.touches.length !== 1) { swipeStart.current = null; return; }
    const touch = event.touches[0];
    swipeStart.current = { x: touch.clientX, y: touch.clientY, id: touch.identifier };
  };
  const onHandleTouchEnd = (event: React.TouchEvent) => {
    const start = swipeStart.current;
    swipeStart.current = null;
    if (!start || event.touches.length !== 0) return;
    const touch = Array.from(event.changedTouches).find((item) => item.identifier === start.id);
    if (!touch) return;
    const down = touch.clientY - start.y;
    if (down >= 45 && down >= Math.abs(touch.clientX - start.x) * 1.5) {
      event.preventDefault();
      onClose();
    }
  };

  return <>
    <div aria-hidden="true" onClick={onClose} style={{ bottom }}
      className="fixed inset-x-0 top-0 z-40 bg-navy/40 backdrop-blur-sm animate-backdrop-enter lg:hidden" />
    <div ref={panelRef} id="mobile-workspace-panel" role="dialog"
      aria-labelledby="mobile-workspace-title" aria-describedby="mobile-workspace-description"
      style={{ bottom, maxHeight: `calc(100dvh - ${bottom} - env(safe-area-inset-top) - 1rem)` }}
      className="animate-launcher-up fixed inset-x-0 z-50 mx-auto flex w-full max-w-lg flex-col overflow-hidden rounded-t-2xl border border-surface-border bg-white shadow-2xl lg:hidden">
      <div data-swipe-handle="true" onTouchStart={onHandleTouchStart} onTouchEnd={onHandleTouchEnd}
        onTouchCancel={() => { swipeStart.current = null; }} style={{ touchAction: 'none' }}
        className="flex h-7 shrink-0 items-center justify-center" aria-hidden="true">
        <span className="h-1 w-10 rounded-full bg-slate-300" />
      </div>
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-surface-border/80 px-5 pb-3">
        <div className="min-w-0"><h2 id="mobile-workspace-title" className="text-base font-bold text-navy">Workspace Modules</h2>
          <p id="mobile-workspace-description" className="mt-0.5 text-xs text-ink-secondary">Choose a module to switch views.</p></div>
        <button ref={closeRef} type="button" onClick={onClose} aria-label="Close workspace modules"
          className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-xl text-ink-secondary hover:bg-surface-inset focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"><X className="h-5 w-5" /></button>
      </div>
      <div className="min-h-0 overflow-y-auto overscroll-contain p-4">
          <div className="space-y-3">
            {FOUNDER_APP_GRID_SECTIONS.map((section) => (
              <section key={section.label} aria-label={section.label}
                className="bg-white rounded-2xl p-2.5 border border-surface-border/80 shadow-xs">
                <h4 className="text-[10px] font-extrabold uppercase tracking-wider text-ink-muted px-1.5 mb-1.5">
                  {section.label}
                </h4>
                <div className="grid grid-cols-3 gap-1.5">
                  {section.items.map((item) => {
                    const Icon = item.icon;
                    const active = isHrefActive(item.href);
                    return (
                      <Link key={item.href} href={item.href} aria-current={active ? 'page' : undefined}
                        onClick={(event) => onNavigate(event, item.href)}
                        className={`flex min-h-11 flex-col items-center justify-center py-2 px-1.5 rounded-xl text-center transition-[color,background-color,transform] duration-200 motion-safe:active:scale-[0.95] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 ${
                          active ? 'bg-brand text-white' : 'bg-surface/60 text-navy hover:bg-surface-inset'
                        }`}>
                        <Icon aria-hidden="true" className="w-4 h-4 mb-1" />
                        <span className="text-[11px] font-bold break-words max-w-full">{item.label}</span>
                      </Link>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
      </div>
    </div>
  </>;
};
