'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useAuth } from '@/lib/auth/authContext';
import {
  LayoutDashboard,
  FolderKanban,
  Receipt,
  CreditCard,
  UserCheck,
  History,
  UserPlus,
  HandCoins,
  Banknote,
  Users,
  Wrench,
  MessageSquareShare,
  CalendarClock,
  Settings,
  ShieldCheck,
  X,
  LayoutGrid,
} from 'lucide-react';

interface MobileNavProps {
  isOpen?: boolean;
  onClose?: () => void;
}

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
        className="fixed bottom-0 inset-x-0 z-40 lg:hidden bg-white/95 backdrop-blur-md border-t border-surface-border/90 shadow-[0_-4px_20px_rgba(11,31,58,0.07)] px-2 py-1.5"
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
                className={`flex flex-col items-center justify-center py-1.5 px-1 rounded-2xl transition-all duration-150 active:scale-95 ${
                  active
                    ? 'bg-navy text-white shadow-[0_4px_12px_rgba(11,31,58,0.22)]'
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
              onClick={() => setIsSheetOpen(!isSheetOpen)}
              className={`flex flex-col items-center justify-center py-1.5 px-1 rounded-2xl transition-all duration-150 active:scale-95 ${
                isSheetOpen
                  ? 'bg-navy text-white shadow-[0_4px_12px_rgba(11,31,58,0.22)]'
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

      {/* Founder Slide-Up Bottom Sheet App Grid */}
      {isFounder && isSheetOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex flex-col justify-end">
          <div
            className="fixed inset-0 bg-navy/35 backdrop-blur-xs transition-opacity animate-in fade-in duration-150"
            onClick={() => setIsSheetOpen(false)}
          />

          <div className="relative z-10 w-full max-w-lg mx-auto bg-surface rounded-t-3xl border-t border-surface-border shadow-[0_-12px_36px_rgba(11,31,58,0.18)] p-4 pb-6 space-y-3.5 animate-sheet-up">
            <div className="flex items-center justify-between px-1">
              <div>
                <h3 className="text-sm font-extrabold text-navy tracking-tight">
                  Workspace Modules
                </h3>
                <p className="text-[11px] text-ink-secondary">
                  Tap any module to switch views
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsSheetOpen(false)}
                className="w-8 h-8 rounded-xl bg-white border border-surface-border text-ink-secondary hover:text-navy flex items-center justify-center active:scale-95 transition-all"
                aria-label="Close workspace launcher"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3">
              {FOUNDER_APP_GRID_SECTIONS.map((section) => (
                <div
                  key={section.label}
                  className="bg-white rounded-2xl p-2.5 border border-surface-border/80 shadow-xs"
                >
                  <div className="text-[10px] font-extrabold uppercase tracking-wider text-ink-muted px-1.5 mb-1.5">
                    {section.label}
                  </div>
                  <div className="grid grid-cols-3 gap-1.5">
                    {section.items.map((item) => {
                      const Icon = item.icon;
                      const active = isHrefActive(item.href);

                      return (
                        <Link
                          key={item.href}
                          href={item.href}
                          onClick={(e) => handleNavClick(e, item.href)}
                          className={`flex flex-col items-center justify-center py-2 px-1.5 rounded-xl text-center transition-all active:scale-95 ${
                            active
                              ? 'bg-navy text-white shadow-xs'
                              : 'bg-surface/60 text-navy hover:bg-surface-inset'
                          }`}
                        >
                          <Icon
                            className={`w-4 h-4 mb-1 ${
                              active ? 'text-white' : 'text-navy'
                            }`}
                          />
                          <span className="text-[11px] font-bold truncate max-w-full">
                            {item.label}
                          </span>
                        </Link>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
};
