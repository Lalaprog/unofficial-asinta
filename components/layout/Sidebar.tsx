'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useAuth } from '@/lib/auth/authContext';
import {
  Banknote,
  BellRing,
  ChevronDown,
  Clock,
  CreditCard,
  FolderKanban,
  HandCoins,
  LayoutDashboard,
  MessageSquareText,
  Receipt,
  Settings,
  UserCheck,
  UserCog,
  Users,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
}

interface NavGroup {
  id: string;
  title: string;
  items: NavItem[];
}

const FOUNDER_NAV_GROUPS: NavGroup[] = [
  {
    id: 'overview-projects',
    title: 'Overview & Projects',
    items: [
      { label: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
      { label: 'Projects & Sites', href: '/projects', icon: FolderKanban },
      { label: 'Tools & Inventory', href: '/tools', icon: Wrench },
    ],
  },
  {
    id: 'clients-billing',
    title: 'Clients & Billing',
    items: [
      { label: 'Clients', href: '/clients', icon: Users },
      { label: 'Invoices', href: '/invoices', icon: Receipt },
      { label: 'Reminder Queue', href: '/reminders', icon: BellRing },
      { label: 'SMS Dispatch', href: '/sms', icon: MessageSquareText },
    ],
  },
  {
    id: 'workforce-pay',
    title: 'Workforce & Pay',
    items: [
      { label: 'Attendance', href: '/attendance', icon: UserCheck },
      { label: 'Payroll', href: '/payroll', icon: Banknote },
      { label: 'Bale Requests & Advances', href: '/advances', icon: HandCoins },
    ],
  },
  {
    id: 'costs-admin',
    title: 'Costs & Admin',
    items: [
      { label: 'Expenses', href: '/expenses', icon: CreditCard },
      { label: 'Team Accounts', href: '/users', icon: UserCog },
      { label: 'Settings', href: '/settings', icon: Settings },
    ],
  },
];

const SUPERVISOR_NAV_GROUPS: NavGroup[] = [
  {
    id: 'field-operations',
    title: 'Field Operations',
    items: [
      { label: 'Site Attendance', href: '/attendance', icon: UserCheck },
      { label: 'Workforce Roster', href: '/attendance?tab=workforce', icon: Users },
      { label: 'Attendance History', href: '/attendance?tab=history', icon: Clock },
      { label: 'Assigned Projects', href: '/projects', icon: FolderKanban },
      { label: 'Bale Requests', href: '/advances?tab=requests', icon: HandCoins },
      { label: 'Supervisor Profile', href: '/settings', icon: UserCog },
    ],
  },
];

function isItemActive(
  href: string,
  pathname: string | null,
  currentTab: string,
  isFounder: boolean
): boolean {
  const [hrefPath, queryString] = href.split('?');
  const targetTab = new URLSearchParams(queryString || '').get('tab');

  if (hrefPath === '/attendance') {
    if (pathname !== '/attendance') return false;
    if (targetTab) return currentTab === targetTab;
    return isFounder || currentTab === 'terminal';
  }

  return (
    pathname === hrefPath ||
    Boolean(pathname?.startsWith(`${hrefPath}/`))
  );
}

export const Sidebar: React.FC = () => {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const currentTab = searchParams?.get('tab') || 'terminal';
  const { isFounder } = useAuth();
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});

  const groups = isFounder ? FOUNDER_NAV_GROUPS : SUPERVISOR_NAV_GROUPS;
  const activeGroupId = groups.find((group) =>
    group.items.some((item) => isItemActive(item.href, pathname, currentTab, isFounder))
  )?.id;

  // Keep the active section visible after route changes; other sections remain
  // independently collapsible to keep the rail compact.
  useEffect(() => {
    if (!activeGroupId) return;
    setExpandedGroups((previous) => ({ ...previous, [activeGroupId]: true }));
  }, [activeGroupId]);

  return (
    <aside className="sticky top-16 hidden h-[calc(100dvh-7rem)] w-60 shrink-0 self-start flex-col border-r border-surface-border/80 bg-white p-3 lg:flex">
      <div className="mb-3 px-2 pt-1">
        <span className="text-[10px] font-bold uppercase tracking-widest text-ink-muted">
          Asinta Workspace
        </span>
      </div>

      <div className="flex-1 space-y-2 overflow-y-auto">
        {groups.map((group) => {
          const isExpanded = expandedGroups[group.id] ?? group.id === activeGroupId;
          const groupHasActiveItem = group.items.some((item) =>
            isItemActive(item.href, pathname, currentTab, isFounder)
          );

          return (
            <section key={group.id} className="overflow-hidden rounded-xl">
              <button
                type="button"
                onClick={() =>
                  setExpandedGroups((previous) => ({
                    ...previous,
                    [group.id]: !isExpanded,
                  }))
                }
                className={`flex min-h-11 w-full items-center justify-between gap-2 rounded-xl px-2.5 text-left text-[11px] font-bold uppercase tracking-wide transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/25 ${
                  groupHasActiveItem
                    ? 'text-navy hover:bg-surface-inset'
                    : 'text-ink-secondary hover:bg-surface-inset hover:text-navy'
                }`}
                aria-expanded={isExpanded}
                aria-controls={`sidebar-group-${group.id}`}
              >
                <span className="truncate">{group.title}</span>
                <ChevronDown
                  className={`h-4 w-4 shrink-0 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                  aria-hidden="true"
                />
              </button>

              {isExpanded && (
                <nav id={`sidebar-group-${group.id}`} aria-label={group.title} className="space-y-0.5 pb-1">
                  {group.items.map((item) => {
                    const Icon = item.icon;
                    const isActive = isItemActive(item.href, pathname, currentTab, isFounder);
                    return (
                      <Link
                        key={item.href}
                        href={item.href}
                        aria-current={isActive ? 'page' : undefined}
                        className={`group ml-1 flex min-h-10 items-center gap-2.5 rounded-lg px-3 text-xs font-medium transition-colors ${
                          isActive
                            ? 'bg-navy text-white'
                            : 'text-ink-secondary hover:bg-surface-inset hover:text-navy'
                        }`}
                      >
                        <Icon
                          className={`h-4 w-4 shrink-0 ${isActive ? 'text-white' : 'text-ink-secondary group-hover:text-navy'}`}
                          aria-hidden="true"
                        />
                        <span className="min-w-0 break-words">{item.label}</span>
                      </Link>
                    );
                  })}
                </nav>
              )}
            </section>
          );
        })}
      </div>
    </aside>
  );
};
