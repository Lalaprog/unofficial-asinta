'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useAuth } from '@/lib/auth/authContext';
import { MobileWorkspaceLauncher } from './MobileWorkspaceLauncher';
import {
  LayoutDashboard,
  FolderKanban,
  UserCheck,
  History,
  UserPlus,
  Banknote,
  LayoutGrid,
} from 'lucide-react';

interface MobileNavProps {
  isOpen?: boolean;
  onClose?: () => void;
}

export const MobileNav: React.FC<MobileNavProps> = () => {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const urlTab = searchParams?.get('tab') || 'terminal';
  const { isFounder } = useAuth();
  const [isSheetOpen, setIsSheetOpen] = useState(false);
  const [localAttendanceTab, setLocalAttendanceTab] = useState<string>(urlTab);
  const [pendingHref, setPendingHref] = useState<string | null>(null);

  useEffect(() => {
    setLocalAttendanceTab(urlTab);
    setPendingHref(null);
    setIsSheetOpen(false);
  }, [pathname, urlTab]);

  useEffect(() => {
    // A sheet opened on mobile must not remain over the desktop workspace
    // after a resize or device rotation.
    const desktop = window.matchMedia('(min-width: 1024px)');
    const onChange = () => { if (desktop.matches) setIsSheetOpen(false); };
    onChange();
    desktop.addEventListener('change', onChange);
    return () => desktop.removeEventListener('change', onChange);
  }, []);

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
    setIsSheetOpen(false);
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
    { label: 'Payroll', href: '/payroll', icon: Banknote },
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
        aria-label="Mobile Bottom Navigation"
        className="fixed bottom-0 inset-x-0 z-40 lg:hidden bg-white/95 backdrop-blur-md border-t border-surface-border/90 shadow-[0_-4px_20px_rgba(11,31,58,0.07)] px-2 pt-1.5 pb-[calc(env(safe-area-inset-bottom)+0.375rem)]"
      >
        <div
          className={`grid ${
            isFounder ? 'grid-cols-5' : 'grid-cols-4'
          } gap-1 max-w-md mx-auto`}
        >
          {dockItems.map((item) => {
            const Icon = item.icon;
            const active = isHrefActive(item.href) && !isSheetOpen;

            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={(e) => handleNavClick(e, item.href)}
                aria-current={active ? 'page' : undefined}
                className={`flex min-h-11 flex-col items-center justify-center py-1.5 px-1 rounded-xl transition-colors duration-150 active:scale-95 ${
                  active
                    ? 'bg-brand text-white'
                    : 'text-ink-secondary hover:text-navy hover:bg-surface-inset/50'
                }`}
              >
                <Icon
                  className={`w-4 h-4 transition-transform duration-150 ${
                    active ? '-translate-y-0.5 scale-105 text-white' : 'text-ink-secondary'
                  }`}
                />
                <span className="text-[10px] font-bold mt-1 truncate max-w-full">
                  {item.label}
                </span>
              </Link>
            );
          })}

          {/* Founder "More" Button -> Opens Clean Bottom-Sheet App Grid */}
          {isFounder && (
            <button
              type="button"
              onClick={() => setIsSheetOpen(true)}
              aria-haspopup="dialog"
              aria-expanded={isSheetOpen}
              className={`flex min-h-11 flex-col items-center justify-center py-1.5 px-1 rounded-xl transition-colors duration-150 active:scale-95 ${
                isSheetOpen
                  ? 'bg-brand text-white'
                  : 'text-ink-secondary hover:text-navy hover:bg-surface-inset/50'
              }`}
            >
              <LayoutGrid
                className={`w-4 h-4 transition-transform duration-150 ${
                  isSheetOpen ? 'rotate-90 scale-105 text-white' : 'text-ink-secondary'
                }`}
              />
              <span className="text-[10px] font-bold mt-1">More</span>
            </button>
          )}
        </div>
      </nav>

      {isFounder && (
        <MobileWorkspaceLauncher
          isOpen={isSheetOpen}
          onClose={() => setIsSheetOpen(false)}
          isHrefActive={isHrefActive}
          onNavigate={handleNavClick}
        />
      )}
    </>
  );
};
