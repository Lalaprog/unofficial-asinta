'use client';

import React, { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { MobileQuickActions } from './MobileQuickActions';
import { startQuickAction, type QuickAction } from '@/lib/mobile/quickActions';
import { useAuth } from '@/lib/auth/authContext';
import { MobileWorkspaceLauncher, type LauncherMotion } from './MobileWorkspaceLauncher';
import {
  LayoutDashboard,
  FolderKanban,
  UserCheck,
  History,
  UserPlus,
  Plus,
  LayoutGrid,
} from 'lucide-react';

interface MobileNavProps {
  isOpen?: boolean;
  onClose?: () => void;
}

export const MobileNav: React.FC<MobileNavProps> = () => {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const urlTab = searchParams?.get('tab') || 'terminal';
  const { isFounder } = useAuth();
  const [isSheetOpen, setIsSheetOpen] = useState(false);
  const [isQuickOpen, setIsQuickOpen] = useState(false);
  const [quickMounted, setQuickMounted] = useState(false);
  useEffect(() => {
    if (isQuickOpen) { setQuickMounted(true); return; }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { setQuickMounted(false); return; }
    const timer = window.setTimeout(() => setQuickMounted(false), 280);
    return () => window.clearTimeout(timer);
  }, [isQuickOpen]);
  const quickRef = useRef<HTMLButtonElement>(null);
  const closeQuick = useCallback(() => { setIsQuickOpen(false); quickRef.current?.focus(); }, []);
  const navRef = useRef<HTMLElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const swipeStart = useRef<{ x: number; y: number; id: number; tracking: boolean; cancelled: boolean } | null>(null);
  const [motion, setMotion] = useState<LauncherMotion | null>(null);
  const [tapEntrance, setTapEntrance] = useState(false);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const motionRef = useRef<LauncherMotion | null>(null);
  motionRef.current = motion;
  const updateMotion = useCallback((next: LauncherMotion | null) => { motionRef.current = next; setMotion(next); }, []);
  const clearSettle = useCallback(() => { if (settleTimer.current) clearTimeout(settleTimer.current); settleTimer.current = null; }, []);
  const dismiss = useCallback(() => { clearSettle(); updateMotion(null); setTapEntrance(false); setIsSheetOpen(false); }, [clearSettle, updateMotion]);
  const settle = (open: boolean) => {
    clearSettle();
    setTapEntrance(false);
    updateMotion({ kind: open ? 'settle-open' : 'settle-closed', distance: 0 });
    setIsSheetOpen(open);
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) updateMotion(null);
    else settleTimer.current = setTimeout(() => { updateMotion(null); settleTimer.current = null; }, 240);
  };
  useEffect(() => () => { if (settleTimer.current) clearTimeout(settleTimer.current); }, []);
  const suppressedClick = useRef<{ target: EventTarget; until: number } | null>(null);
  const [navHeight, setNavHeight] = useState<number | null>(null);

  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const measure = () => { const height = nav.getBoundingClientRect().height; if (height > 0) setNavHeight(height); };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(nav);
    window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); };
  }, []);

  const onDockTouchStart = (event: React.TouchEvent) => {
    suppressedClick.current = null;
    if (!isFounder || isSheetOpen || isQuickOpen || event.touches.length !== 1) { if (swipeStart.current?.tracking) settle(false); swipeStart.current = null; return; }
    const touch = event.touches[0];
    swipeStart.current = { x: touch.clientX, y: touch.clientY, id: touch.identifier, tracking: false, cancelled: false };
  };
  const onDockTouchMove = (event: React.TouchEvent) => {
    const start = swipeStart.current;
    if (!start || start.cancelled) return;
    if (event.touches.length !== 1) { if (start.tracking) settle(false); swipeStart.current = null; return; }
    const touch = Array.from(event.touches).find((item) => item.identifier === start.id);
    if (!touch) return;
    const up = start.y - touch.clientY;
    const sideways = Math.abs(touch.clientX - start.x);
    if (!start.tracking && sideways > 10 && sideways > Math.abs(up)) { start.cancelled = true; return; }
    if (!start.tracking && up > 8 && up > sideways * 1.5) {
      start.tracking = true;
      clearSettle();
      setTapEntrance(false);
    }
    if (start.tracking) updateMotion({ kind: 'opening', distance: Math.max(0, up) });
  };
  const onDockTouchEnd = (event: React.TouchEvent) => {
    const start = swipeStart.current;
    swipeStart.current = null;
    if (!start || start.cancelled || event.touches.length !== 0) return;
    const touch = Array.from(event.changedTouches).find((item) => item.identifier === start.id);
    if (!touch) return;
    const up = start.y - touch.clientY;
    const sideways = Math.abs(touch.clientX - start.x);
    if (!start.tracking && (up < 45 || up < sideways * 1.5)) return;
    event.preventDefault();
    suppressedClick.current = { target: event.target, until: Date.now() + 450 };
    if (up >= 45 && up >= sideways * 1.5) {
      moreRef.current?.focus();
      settle(true);
    } else if (start.tracking) settle(false);
  };
  const onDockTouchCancel = () => {
    const tracking = swipeStart.current?.tracking;
    swipeStart.current = null;
    if (tracking) settle(false);
  };
  const onPanelDrag = (distance: number) => {
    clearSettle();
    setTapEntrance(false);
    updateMotion({ kind: 'closing', distance });
  };
  const onPanelDragEnd = (distance: number, cancelled: boolean) => {
    if (distance >= 45 && !cancelled) settle(false);
    else if (motionRef.current?.kind === 'closing') settle(true);
  };
  const [localAttendanceTab, setLocalAttendanceTab] = useState<string>(urlTab);
  const [pendingHref, setPendingHref] = useState<string | null>(null);

  useEffect(() => {
    setLocalAttendanceTab(urlTab);
    setPendingHref(null);
    dismiss();
    setIsQuickOpen(false);
  }, [pathname, urlTab, dismiss]);

  useEffect(() => {
    // A sheet opened on mobile must not remain over the desktop workspace
    // after a resize or device rotation.
    const desktop = window.matchMedia('(min-width: 1024px)');
    const onChange = () => { if (desktop.matches) { dismiss(); setIsQuickOpen(false); } };
    onChange();
    desktop.addEventListener('change', onChange);
    return () => desktop.removeEventListener('change', onChange);
  }, [dismiss]);

  useEffect(() => {
    const onTabEvent = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail;
      if (detail) {
        setLocalAttendanceTab(detail);
        setPendingHref(null);
      }
    };
    window.addEventListener('bale:attendance-tab', onTabEvent);
    return () => {
      window.removeEventListener('bale:attendance-tab', onTabEvent);
    };
  }, []);

  const isHrefActive = (href: string) => {
    if (pendingHref) {
      return pendingHref === href;
    }
    const [basePath, query] = href.split('?');
    if (basePath === '/attendance') {
      if (pathname !== '/attendance') return false;
      const targetTab = new URLSearchParams(query || '').get('tab') || 'terminal';
      return localAttendanceTab === targetTab;
    }
    return pathname === basePath || Boolean(pathname?.startsWith(`${basePath}/`));
  };

  const handleNavClick = (e: React.MouseEvent<HTMLAnchorElement>, href: string) => {
    dismiss();
    setIsQuickOpen(false);
    const [basePath, query] = href.split('?');

    // 0ms client-side tab switch when already on `/attendance`
    if (basePath === '/attendance' && pathname === '/attendance') {
      e.preventDefault();
      const targetTab = new URLSearchParams(query || '').get('tab') || 'terminal';
      setLocalAttendanceTab(targetTab);
      window.history.replaceState(null, '', href);
      window.dispatchEvent(new CustomEvent('bale:attendance-tab', { detail: targetTab }));
      return;
    }

    if (pathname !== basePath) {
      setPendingHref(href);
    }
  };

  // Bottom dock items
  const founderDockItems = [
    { label: 'Overview', href: '/dashboard', icon: LayoutDashboard },
    { label: 'Projects', href: '/projects', icon: FolderKanban },
    { label: 'Roll Call', href: '/attendance', icon: UserCheck },
  ];

  const supervisorDockItems = [
    { label: 'Roll Call', href: '/attendance', icon: UserCheck },
    { label: 'History', href: '/attendance?tab=history', icon: History },
    { label: 'Projects', href: '/projects', icon: FolderKanban },
    { label: 'Workforce', href: '/attendance?tab=workforce', icon: UserPlus },
  ];

  const dockItems = isFounder ? founderDockItems : supervisorDockItems;

  return (
    <>
      {/* Sleek 2px Top Route Progress Line on Mobile */}
      {pendingHref && (
        <div className="fixed top-0 inset-x-0 z-50 h-0.5 bg-surface-inset overflow-hidden lg:hidden">
          <div className="h-full w-1/2 bg-[#1B4978] animate-[asintaProgress_0.9s_ease-in-out_infinite]" />
        </div>
      )}

      {/* Fixed Mobile Bottom Navigation Bar */}
      <nav
        ref={navRef}
        aria-label="Mobile Bottom Navigation"
        onTouchStart={onDockTouchStart}
        onTouchMove={onDockTouchMove}
        onTouchEnd={onDockTouchEnd}
        onTouchCancel={onDockTouchCancel}
        onClickCapture={(event) => {
          const suppressed = suppressedClick.current;
          suppressedClick.current = null;
          if (event.detail !== 0 && suppressed && event.target === suppressed.target && Date.now() < suppressed.until) {
            event.preventDefault(); event.stopPropagation();
          }
        }}
        style={isFounder ? { touchAction: 'pan-x' } : undefined}
        className={`fixed bottom-0 inset-x-0 z-50 lg:hidden px-2 pb-[calc(env(safe-area-inset-bottom)+0.375rem)] ${
          isFounder ? 'bg-white pt-3' : 'bg-white/95 backdrop-blur-md pt-1.5'
        } ${isSheetOpen || motion ? 'border-t border-transparent' : 'border-t border-surface-border/90 shadow-[0_-4px_20px_rgba(11,31,58,0.07)]'}`}
      >
        {isFounder && !isSheetOpen && !motion && (
          <span aria-hidden="true" data-dock-handle="true" className="pointer-events-none absolute left-1/2 top-[4px] h-1 w-9 -translate-x-1/2 rounded-full bg-slate-300" />
        )}
        <div
          className={`grid ${
            isFounder ? 'grid-cols-5' : 'grid-cols-4'
          } gap-1 max-w-md mx-auto`}
        >
          {dockItems.map((item, index) => {
            const Icon = item.icon;
            const active = isHrefActive(item.href) && !isSheetOpen && !isQuickOpen;

            return (
              <React.Fragment key={item.href}>
              {isFounder && index === 2 && <button type="button" ref={quickRef} aria-label="Quick actions" aria-haspopup="dialog" aria-expanded={isQuickOpen} aria-controls={isQuickOpen ? 'mobile-quick-actions' : undefined}
                onClick={() => { dismiss(); setIsQuickOpen(value => !value); }}
                className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-brand text-white shadow-[0_5px_15px_rgba(27,73,120,0.28)] transition-transform focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 motion-safe:active:scale-95">
                <Plus aria-hidden="true" className={`h-6 w-6 transition-transform duration-200 motion-reduce:transition-none ${isQuickOpen ? 'rotate-45' : ''}`} />
              </button>}
              <Link
                key={item.href}
                href={item.href}
                onClick={(e) => handleNavClick(e, item.href)}
                aria-current={active ? 'page' : undefined}
                className={`flex min-h-11 flex-col items-center justify-center py-1.5 px-1 rounded-xl transition-[color,background-color,border-color,transform] duration-200 motion-safe:active:scale-[0.95] ${
                  active
                    ? 'bg-brand text-white'
                    : 'text-ink-secondary hover:text-navy hover:bg-surface-inset/50'
                }`}
              >
                <Icon
                  className={`w-4 h-4 transition-transform duration-200 ${
                    active ? '-translate-y-0.5 scale-105 text-white' : 'text-ink-secondary'
                  }`}
                />
                <span className="text-[10px] font-bold mt-1 truncate max-w-full">
                  {item.label}
                </span>
              </Link>
              </React.Fragment>
            );
          })}

          {/* Founder "More" Button -> Opens Clean Bottom-Sheet App Grid */}
          {isFounder && (
            <button
              type="button"
              ref={moreRef}
              onClick={() => { setIsQuickOpen(false); if (isSheetOpen) dismiss(); else { clearSettle(); updateMotion(null); setTapEntrance(true); setIsSheetOpen(true); } }}
              aria-haspopup="dialog"
              aria-expanded={isSheetOpen}
              aria-controls={isSheetOpen ? "mobile-workspace-panel" : undefined}
              className={`flex min-h-11 flex-col items-center justify-center py-1.5 px-1 rounded-xl transition-[color,background-color,border-color,transform] duration-200 motion-safe:active:scale-[0.95] ${
                isSheetOpen
                  ? 'bg-brand text-white'
                  : 'text-ink-secondary hover:text-navy hover:bg-surface-inset/50'
              }`}
            >
              <LayoutGrid
                className={`w-4 h-4 transition-transform duration-200 ${
                  isSheetOpen ? 'rotate-90 scale-105 text-white' : 'text-ink-secondary'
                }`}
              />
              <span className="text-[10px] font-bold mt-1">More</span>
            </button>
          )}
        </div>
      </nav>

      {isFounder && (isQuickOpen || quickMounted) && <MobileQuickActions open={isQuickOpen} bottom={navHeight} onClose={closeQuick} onSelect={(action: QuickAction, href: string) => {
        if (startQuickAction(action, href, pathname || '', router.push)) setIsQuickOpen(false);
      }} />}
      {isFounder && (
        <MobileWorkspaceLauncher
          isOpen={isSheetOpen}
          navHeight={navHeight}
          returnFocusRef={moreRef}
          onClose={dismiss}
          motion={motion}
          tapEntrance={tapEntrance}
          onDrag={onPanelDrag}
          onDragEnd={onPanelDragEnd}
          isHrefActive={isHrefActive}
          onNavigate={handleNavClick}
        />
      )}
    </>
  );
};
