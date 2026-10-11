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
  const currentTab = searchParams?.get('tab') || 'terminal';
  const { isFounder } = useAuth();
  const [isSheetOpen, setIsSheetOpen] = useState(false);

  // Close sheet on route change
  useEffect(() => {
    setIsSheetOpen(false);
  }, [pathname, currentTab]);

  const isHrefActive = (href: string) => {
    const [basePath, query] = href.split('?');
    if (basePath === '/attendance') {
      if (pathname !== '/attendance') return false;
      const targetTab = new URLSearchParams(query || '').get('tab') || 'terminal';
      return currentTab === targetTab;
    }
    return pathname === basePath || Boolean(pathname?.startsWith(`${basePath}/`));
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
    { label: 'Workforce', href: '/attendance?tab=workforce', icon: UserPlus },
    { label: 'Projects', href: '/projects', icon: FolderKanban },
  ];

  const dockItems = isFounder ? founderDockItems : supervisorDockItems;

  return (
    <>
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
                prefetch={false}
                onClick={() => setIsSheetOpen(false)}
                className={`flex flex-col items-center justify-center py-1.5 px-1 rounded-2xl transition-all duration-200 active:scale-95 ${
                  active
                    ? 'bg-navy text-white shadow-[0_4px_12px_rgba(11,31,58,0.22)]'
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
            );
          })}

          {/* Founder "More" Button -> Opens Clean Bottom-Sheet App Grid */}
          {isFounder && (
            <button
              type="button"
              onClick={() => setIsSheetOpen(!isSheetOpen)}
              className={`flex flex-col items-center justify-center py-1.5 px-1 rounded-2xl transition-all duration-200 active:scale-95 ${
                isSheetOpen
                  ? 'bg-navy text-white shadow-[0_4px_12px_rgba(11,31,58,0.22)]'
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

      {/* Founder Slide-Up Bottom Sheet App Grid (No numbering, no sidebar, zero scrolling required) */}
      {isFounder && isSheetOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex flex-col justify-end">
          {/* Backdrop */}
          <div
            className="fixed inset-0 bg-navy/35 backdrop-blur-xs transition-opacity animate-in fade-in duration-150"
            onClick={() => setIsSheetOpen(false)}
          />

          {/* Bottom Sheet Card */}
          <div className="relative z-10 w-full max-w-lg mx-auto bg-surface rounded-t-3xl border-t border-surface-border shadow-[0_-12px_36px_rgba(11,31,58,0.18)] p-4 pb-6 space-y-3.5 animate-sheet-up">
            {/* Sheet Grab Handle & Header */}
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

            {/* Grouped 3-Column Icon Grid */}
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
                          prefetch={false}
                          onClick={() => setIsSheetOpen(false)}
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
