'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/lib/auth/authContext';
import {
  LayoutDashboard,
  FolderKanban,
  Receipt,
  CreditCard,
  UserCheck,
  Banknote,
  HandCoins,
  Users,
  Wrench,
  MessageSquareText,
  BellRing,
  UserCog,
  Settings,
  Clock,
  PanelLeftClose,
  PanelLeftOpen,
  LucideIcon,
} from 'lucide-react';

export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  badge?: string;
}

export interface NavGroup {
  id: string;
  title: string;
  items: NavItem[];
}

export const FOUNDER_NAV_GROUPS: NavGroup[] = [
  {
    id: 'studio',
    title: '01 · Studio & Sites',
    items: [
      { label: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
      { label: 'Projects & Sites', href: '/projects', icon: FolderKanban },
      { label: 'Tools & Inventory', href: '/tools', icon: Wrench },
    ],
  },
  {
    id: 'receivables',
    title: '02 · Client Receivables',
    items: [
      { label: 'Clients', href: '/clients', icon: Users },
      { label: 'Invoices & Billing', href: '/invoices', icon: Receipt },
      { label: 'Reminder Queue', href: '/reminders', icon: BellRing },
      { label: 'SMS Dispatch', href: '/sms', icon: MessageSquareText },
    ],
  },
  {
    id: 'workforce',
    title: '03 · Workforce & Pay',
    items: [
      { label: 'Site Attendance', href: '/attendance', icon: UserCheck },
      { label: 'Bale Advances', href: '/advances', icon: HandCoins },
      { label: 'Payroll Engine', href: '/payroll', icon: Banknote },
    ],
  },
  {
    id: 'ledger',
    title: '04 · Ledger & Admin',
    items: [
      { label: 'Expenses & AI', href: '/expenses', icon: CreditCard, badge: 'AI' },
      { label: 'Team Accounts', href: '/users', icon: UserCog },
      { label: 'Settings', href: '/settings', icon: Settings },
    ],
  },
];

export const SUPERVISOR_NAV_GROUPS: NavGroup[] = [
  {
    id: 'field',
    title: 'Field Operations',
    items: [
      { label: 'Site Attendance', href: '/attendance', icon: UserCheck },
      { label: 'Assigned Projects', href: '/projects', icon: FolderKanban },
      { label: 'Attendance History', href: '/attendance?tab=history', icon: Clock },
      { label: 'Supervisor Profile', href: '/settings', icon: UserCog },
    ],
  },
];

export const Sidebar: React.FC = () => {
  const pathname = usePathname();
  const { isFounder } = useAuth();
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const saved = window.localStorage.getItem('bale-sidebar-collapsed');
      if (saved === '1') setCollapsed(true);
    } catch {
      // Ignore storage error
    }
  }, []);

  const toggleCollapsed = () => {
    const next = !collapsed;
    setCollapsed(next);
    try {
      window.localStorage.setItem('bale-sidebar-collapsed', next ? '1' : '0');
    } catch {
      // Ignore storage error
    }
  };

  const groups = isFounder ? FOUNDER_NAV_GROUPS : SUPERVISOR_NAV_GROUPS;

  return (
    <aside
      className={`hidden lg:flex flex-col ${
        collapsed ? 'w-[68px]' : 'w-60'
      } min-h-[calc(100vh-4rem)] bg-white border-r border-surface-border/80 p-3 select-none shrink-0 transition-all duration-200`}
    >
      {/* Collapse / Expand Rail Header */}
      <div
        className={`flex items-center ${
          collapsed ? 'justify-center' : 'justify-between px-2'
        } pb-2 mb-2 border-b border-surface-border/60`}
      >
        {!collapsed && (
          <span className="text-[10px] font-extrabold uppercase tracking-widest text-ink-muted truncate">
            {isFounder ? 'Studio Navigation' : 'Field Terminal'}
          </span>
        )}
        <button
          type="button"
          onClick={toggleCollapsed}
          className="p-1.5 rounded-lg text-ink-secondary hover:text-navy hover:bg-surface-inset transition-colors"
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? (
            <PanelLeftOpen className="w-4 h-4" />
          ) : (
            <PanelLeftClose className="w-4 h-4" />
          )}
        </button>
      </div>

      {/* Grouped Navigation Sections */}
      <div className="space-y-4 flex-1 overflow-y-auto">
        {groups.map((group) => (
          <div key={group.id} className="space-y-1">
            {!collapsed && (
              <div className="px-2.5 pb-1 text-[10px] font-bold text-ink-muted uppercase tracking-wider truncate">
                {group.title}
              </div>
            )}
            <nav className="space-y-0.5">
              {group.items.map((item) => {
                const Icon = item.icon;
                const isActive =
                  pathname === item.href ||
                  (item.href !== '/dashboard' &&
                    item.href !== '/attendance' &&
                    !item.href.includes('?') &&
                    pathname.startsWith(item.href));

                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={isActive ? 'page' : undefined}
                    title={collapsed ? item.label : undefined}
                    className={`group flex items-center ${
                      collapsed ? 'justify-center px-2 py-2.5' : 'justify-between px-3 py-2'
                    } rounded-xl text-xs font-semibold transition-all duration-150 ${
                      isActive
                        ? 'bg-navy text-white shadow-[0_3px_10px_rgba(11,31,58,0.20)]'
                        : 'text-ink-secondary hover:text-navy hover:bg-surface-inset'
                    }`}
                  >
                    <div className="flex items-center space-x-2.5 min-w-0">
                      <Icon
                        className={`w-4 h-4 shrink-0 transition-colors ${
                          isActive ? 'text-white' : 'text-ink-secondary group-hover:text-navy'
                        }`}
                      />
                      {!collapsed && <span className="truncate">{item.label}</span>}
                    </div>
                    {!collapsed && item.badge && (
                      <span
                        className={`px-1.5 py-0.5 rounded text-[9px] font-extrabold shrink-0 ${
                          isActive ? 'bg-white/20 text-white' : 'bg-navy/10 text-navy'
                        }`}
                      >
                        {item.badge}
                      </span>
                    )}
                  </Link>
                );
              })}
            </nav>
          </div>
        ))}
      </div>
    </aside>
  );
};
