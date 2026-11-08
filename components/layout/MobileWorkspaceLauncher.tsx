'use client';

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
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

export type LauncherMotion = {
  kind: 'opening' | 'closing' | 'settle-open' | 'settle-closed';
  distance: number;
};

interface MobileWorkspaceLauncherProps {
  isOpen: boolean;
  onClose: () => void;
  motion: LauncherMotion | null;
  tapEntrance: boolean;
  onDrag: (distance: number) => void;
  onDragEnd: (distance: number, cancelled: boolean) => void;
  navHeight: number | null;
  returnFocusRef: React.RefObject<HTMLButtonElement>;
  isHrefActive: (href: string) => boolean;
  onNavigate: (event: React.MouseEvent<HTMLAnchorElement>, href: string) => void;
}

/** Non-modal so the dock remains usable while the launcher is open. */
export const MobileWorkspaceLauncher: React.FC<MobileWorkspaceLauncherProps> = ({
  isOpen, onClose, isHrefActive, onNavigate, navHeight, returnFocusRef, motion, tapEntrance, onDrag, onDragEnd,
}) => {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [panelHeight, setPanelHeight] = useState(360);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  const shouldRestoreFocus = useRef(false);
  const swipeStart = useRef<{ x: number; y: number; id: number; tracking: boolean; cancelled: boolean; canDrag: boolean } | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const suppressClick = useRef(false);
  onCloseRef.current = onClose;

  useLayoutEffect(() => {
    if (!isOpen) {
      if (shouldRestoreFocus.current && !window.matchMedia('(min-width: 1024px)').matches) returnFocusRef.current?.focus();
      shouldRestoreFocus.current = false;
      return;
    }
    const panel = panelRef.current;
    let lastFocusWasInside = false;
    const onFocus = (event: FocusEvent) => { lastFocusWasInside = Boolean(panel?.contains(event.target as Node)); };
    document.addEventListener('focusin', onFocus);
    const frame = window.requestAnimationFrame(() => closeRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('focusin', onFocus);
      // Restore after the closing commit, so React cannot restore focus to the
      // now-inert visual shell. Do not steal focus from a selected dock item.
      shouldRestoreFocus.current = Boolean(panel?.contains(document.activeElement) || (document.activeElement === document.body && lastFocusWasInside));
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

  const present = isOpen || motion !== null;
  useLayoutEffect(() => {
    if (!present) return;
    const panel = panelRef.current;
    if (!panel) return;
    const measure = () => { const height = panel.offsetHeight; if (height > 0) setPanelHeight(height); };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(panel);
    return () => observer?.disconnect();
  }, [present]);

  // React touchmove listeners can be passive. Prevent the browser's pull-to-refresh
  // only for a downward gesture beginning at the top of this scrollable panel.
  useEffect(() => {
    if (!present) return;
    const panel = panelRef.current;
    if (!panel) return;
    const preventPull = (event: TouchEvent) => {
      const start = swipeStart.current;
      const touch = start && Array.from(event.touches).find(item => item.identifier === start.id);
      if (!start || !touch || !start.canDrag || start.cancelled || event.touches.length !== 1) return;
      const down = touch.clientY - start.y;
      if (down > 0 && down > Math.abs(touch.clientX - start.x) * 1.5 && event.cancelable) event.preventDefault();
    };
    panel.addEventListener('touchmove', preventPull, { passive: false });
    return () => panel.removeEventListener('touchmove', preventPull);
  }, [present]);

  if (!present) return null;
  const bottom = navHeight === null ? 'calc(4.5rem + env(safe-area-inset-bottom))' : `${navHeight}px`;
  const onHandleTouchStart = (event: React.TouchEvent) => {
    if (event.touches.length !== 1) { if (swipeStart.current?.tracking) onDragEnd(0, true); swipeStart.current = null; return; }
    const touch = event.touches[0];
    suppressClick.current = false;
    const insideContent = contentRef.current?.contains(event.target as Node);
    swipeStart.current = { x: touch.clientX, y: touch.clientY, id: touch.identifier, tracking: false, cancelled: false, canDrag: !insideContent || (contentRef.current?.scrollTop ?? 0) <= 0 };
  };
  const onHandleTouchMove = (event: React.TouchEvent) => {
    const start = swipeStart.current;
    if (!start || start.cancelled || !start.canDrag) return;
    if (event.touches.length !== 1) { if (start.tracking) onDragEnd(0, true); swipeStart.current = null; return; }
    const touch = Array.from(event.touches).find((item) => item.identifier === start.id);
    if (!touch) return;
    const down = touch.clientY - start.y;
    const sideways = Math.abs(touch.clientX - start.x);
    if (!start.tracking && down < -8) { start.cancelled = true; return; }
    if (!start.tracking && sideways > 10 && sideways > Math.abs(down)) { start.cancelled = true; return; }
    if (!start.tracking && down > 8 && down > sideways * 1.5) start.tracking = true;
    if (start.tracking) onDrag(Math.max(0, Math.min(panelHeight, down)));
  };
  const onHandleTouchEnd = (event: React.TouchEvent) => {
    const start = swipeStart.current;
    swipeStart.current = null;
    if (!start || start.cancelled || !start.canDrag || event.touches.length !== 0) return;
    const touch = Array.from(event.changedTouches).find((item) => item.identifier === start.id);
    if (!touch) return;
    const down = touch.clientY - start.y;
    const valid = down >= 45 && down >= Math.abs(touch.clientX - start.x) * 1.5;
    if (start.tracking || valid) {
      event.preventDefault();
      suppressClick.current = true;
      onDragEnd(valid ? down : 0, false);
    }
  };
  const onHandleTouchCancel = () => {
    if (swipeStart.current?.tracking) onDragEnd(0, true);
    swipeStart.current = null;
  };
  const dragging = motion?.kind === 'opening' || motion?.kind === 'closing';
  const transform = motion?.kind === 'opening' ? `translateY(max(0px, calc(100% - ${motion.distance}px)))`
    : motion?.kind === 'closing' ? `translateY(${motion.distance}px)`
    : motion?.kind === 'settle-closed' ? 'translateY(100%)' : 'translateY(0)';
  const backdropOpacity = motion?.kind === 'opening' ? Math.min(1, motion.distance / panelHeight)
    : motion?.kind === 'closing' ? Math.max(0, 1 - motion.distance / panelHeight)
    : motion?.kind === 'settle-closed' ? 0 : 1;
  const reducedMotion = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const transition = dragging || reducedMotion ? 'none' : 'transform 220ms cubic-bezier(0.16, 1, 0.3, 1)';

  return <>
    <div aria-hidden="true" onClick={isOpen ? onClose : undefined}
      style={{ bottom, touchAction: 'none', opacity: backdropOpacity, pointerEvents: isOpen ? 'auto' : 'none', transition: dragging || reducedMotion ? 'none' : 'opacity 220ms ease-out' }}
      className="fixed inset-x-0 top-0 z-40 bg-navy/40 backdrop-blur-sm lg:hidden" />
    {/* This viewport clips the panel behind the dock throughout a drag. */}
    <div style={{ bottom }} className="pointer-events-none fixed inset-x-0 top-0 z-50 overflow-hidden lg:hidden">
    <div ref={(node) => { panelRef.current = node; node?.toggleAttribute('inert', !isOpen); }}
      onTouchStart={onHandleTouchStart} onTouchMove={onHandleTouchMove} onTouchEnd={onHandleTouchEnd} onTouchCancel={onHandleTouchCancel}
      onClickCapture={(event) => { if (suppressClick.current && event.detail !== 0) { event.preventDefault(); event.stopPropagation(); suppressClick.current = false; } }}
      id="mobile-workspace-panel" role={isOpen ? 'dialog' : undefined} aria-hidden={isOpen ? undefined : true}
      aria-labelledby={isOpen ? 'mobile-workspace-title' : undefined} aria-describedby={isOpen ? 'mobile-workspace-description' : undefined}
      style={{ maxHeight: `calc(100dvh - ${bottom} - env(safe-area-inset-top) - 1rem)`, transform, transition, pointerEvents: isOpen ? 'auto' : 'none' }}
      className={`${tapEntrance && !motion ? 'motion-safe:animate-launcher-up' : ''} absolute inset-x-0 bottom-0 mx-auto flex w-full max-w-lg flex-col overflow-hidden rounded-t-2xl border-x border-t border-surface-border/90 bg-white shadow-[0_-8px_30px_rgba(11,31,58,0.10)]`}>
      <div data-swipe-handle="true" style={{ touchAction: 'none' }}
        className="flex h-7 shrink-0 items-center justify-center" aria-hidden="true">
        <span className="h-1 w-10 rounded-full bg-slate-300" />
      </div>
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-surface-border/80 px-5 pb-3">
        <div className="min-w-0"><h2 id="mobile-workspace-title" className="text-base font-bold text-navy">Workspace Modules</h2>
          <p id="mobile-workspace-description" className="mt-0.5 text-xs text-ink-secondary">Choose a module to switch views.</p></div>
        <button ref={closeRef} type="button" tabIndex={isOpen ? undefined : -1} onClick={onClose} aria-label="Close workspace modules"
          className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-xl text-ink-secondary hover:bg-surface-inset focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"><X className="h-5 w-5" /></button>
      </div>
      <div ref={contentRef} data-launcher-content="true" className="min-h-0 overflow-y-auto overscroll-contain p-4">
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
                      <Link key={item.href} href={item.href} tabIndex={isOpen ? undefined : -1} aria-current={active ? 'page' : undefined}
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
    </div>
  </>;
};
