'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth/authContext';
import { useDataStore } from '@/lib/data/store';
import {
  Building2,
  LogOut,
  ChevronDown,
  Menu,
  Bell,
  ArrowRight,
  RefreshCw,
} from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { formatPesoCompact } from '@/lib/email/format';

interface NavbarProps {
  onToggleMobileMenu?: () => void;
}

interface ActionNotification {
  id: string;
  title: string;
  description: string;
  actionLabel: string;
  href: string;
  variant: 'warning' | 'danger' | 'info' | 'success';
}

export const Navbar: React.FC<NavbarProps> = ({ onToggleMobileMenu }) => {
  const { user, logout, isFounder, isSupervisor } = useAuth();
  const {
    invoices,
    advances,
    attendance,
    payroll,
    projects,
    getProjectsForSupervisor,
    refresh,
  } = useDataStore();
  const router = useRouter();
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const handleLogout = async () => {
    await logout();
    router.push('/');
  };

  const handleNotificationClick = (href: string) => {
    setShowNotifications(false);
    router.push(href);
  };

  const handleManualSync = async () => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    await refresh({ silent: true });
    setIsRefreshing(false);
  };

  const formatPHP = formatPesoCompact;
  const now = new Date();
  const todayStr = now.toISOString().split('T')[0];

  // Build role-specific, clickable action notifications
  const notifications: ActionNotification[] = [];

  if (isFounder) {
    // 1. Today's Field Attendance Sync (or pending sites)
    const todayLogs = attendance.filter((a) => a.date === todayStr);
    const todayLoggedProjectIds = new Set(todayLogs.map((a) => a.project_id));
    const activeProjects = projects.filter(
      (p) => p.status !== 'completed' && p.status !== 'on_hold'
    );
    const missingSitesToday = activeProjects.filter((p) => !todayLoggedProjectIds.has(p.id));

    if (todayLogs.length > 0) {
      notifications.push({
        id: 'founder-attendance-today',
        title: 'Field Attendance Synced Today',
        description: `${todayLogs.length} worker record(s) across ${todayLoggedProjectIds.size} site(s) are live and ready for Payroll.`,
        actionLabel: 'Review Attendance Roster',
        href: '/attendance',
        variant: 'success',
      });
    }

    if (missingSitesToday.length > 0) {
      notifications.push({
        id: 'founder-attendance-missing',
        title: "Today's Site Attendance Pending",
        description: `${missingSitesToday.length} active project site(s) (${missingSitesToday
          .slice(0, 2)
          .map((p) => p.name)
          .join(', ')}) have no attendance logged for ${todayStr} yet.`,
        actionLabel: 'Open Attendance Terminal',
        href: '/attendance',
        variant: 'warning',
      });
    }

    // 2. Draft Payroll Vouchers awaiting Founder approval
    const draftVouchers = payroll.filter((p) => p.status === 'draft' || p.status === 'reviewed');
    if (draftVouchers.length > 0) {
      const draftTotal = draftVouchers.reduce((sum, p) => sum + Number(p.net_pay || 0), 0);
      notifications.push({
        id: 'founder-draft-payroll',
        title: 'Draft Payroll Vouchers Pending Approval',
        description: `${draftVouchers.length} voucher(s) totaling ${formatPHP(draftTotal)} are waiting for Founder approval.`,
        actionLabel: 'Approve in Payroll Engine',
        href: '/payroll',
        variant: 'info',
      });
    }

    // 3. Overdue Client Progress Invoices
    const overdueInvoices = invoices.filter(
      (i) =>
        i.status !== 'paid' &&
        i.status !== 'cancelled' &&
        (i.status === 'overdue' || new Date(i.due_date) < now)
    );
    overdueInvoices.slice(0, 3).forEach((inv) => {
      notifications.push({
        id: `founder-overdue-${inv.id}`,
        title: `Overdue Billing: ${inv.invoice_number}`,
        description: `${formatPHP(inv.amount - inv.amount_paid)} balance past due (${inv.due_date}).`,
        actionLabel: 'Collect or Send Reminder',
        href: '/invoices',
        variant: 'danger',
      });
    });

    // 4. Active Worker Advances (Bale)
    const activeBales = advances.filter(
      (a) => a.status === 'active' || a.status === 'partially_deducted'
    );
    if (activeBales.length > 0) {
      const baleBalance = activeBales.reduce(
        (sum, a) => sum + Math.max(0, Number(a.amount || 0) - Number(a.amount_deducted || 0)),
        0
      );
      notifications.push({
        id: 'founder-active-bale',
        title: 'Active Worker Advances (Bale)',
        description: `${activeBales.length} active advance(s) (${formatPHP(baleBalance)} outstanding) queued for payroll deduction.`,
        actionLabel: 'Manage Bale Ledger',
        href: '/advances',
        variant: 'warning',
      });
    }
  } else if (isSupervisor && user) {
    // Supervisor-specific field notifications (no financial/invoice noise)
    const assignedSites = getProjectsForSupervisor(user.id);
    const assignedSiteIds = new Set(assignedSites.map((p) => p.id));
    const todaySiteLogs = attendance.filter(
      (a) => a.date === todayStr && assignedSiteIds.has(a.project_id)
    );
    const loggedSiteIdsToday = new Set(todaySiteLogs.map((a) => a.project_id));
    const pendingSitesToday = assignedSites.filter(
      (p) => p.status !== 'completed' && p.status !== 'on_hold' && !loggedSiteIdsToday.has(p.id)
    );

    if (assignedSites.length === 0) {
      notifications.push({
        id: 'sup-no-site',
        title: 'No Project Site Assigned Yet',
        description: 'Your Supervisor profile does not have an assigned construction site yet.',
        actionLabel: 'View Supervisor Profile',
        href: '/settings',
        variant: 'warning',
      });
    } else if (pendingSitesToday.length > 0) {
      notifications.push({
        id: 'sup-pending-attendance',
        title: "Today's Daily Attendance Due",
        description: `Submit daily attendance for ${pendingSitesToday
          .map((p) => p.name)
          .join(', ')} (${todayStr}).`,
        actionLabel: 'Record Site Attendance',
        href: '/attendance',
        variant: 'warning',
      });
    } else if (todaySiteLogs.length > 0) {
      notifications.push({
        id: 'sup-synced-today',
        title: "Today's Attendance Synced to Payroll",
        description: `${todaySiteLogs.length} worker record(s) submitted for ${todayStr} and live in the Payroll Engine.`,
        actionLabel: 'View Attendance Logs',
        href: '/attendance?tab=history',
        variant: 'success',
      });
    }

    // Recent Founder Overrides on the Supervisor's assigned sites
    const overriddenLogs = attendance.filter(
      (a) => assignedSiteIds.has(a.project_id) && a.is_founder_override
    );
    if (overriddenLogs.length > 0) {
      notifications.push({
        id: 'sup-founder-override',
        title: 'Founder Attendance Adjustment',
        description: `${overriddenLogs.length} attendance log(s) on your assigned site(s) include a Founder override note.`,
        actionLabel: 'Inspect History Logs',
        href: '/attendance?tab=history',
        variant: 'info',
      });
    }

    if (assignedSites.length > 0) {
      notifications.push({
        id: 'sup-assigned-sites',
        title: `Assigned Construction Sites (${assignedSites.length})`,
        description: assignedSites.map((p) => p.name).join(' · '),
        actionLabel: 'Open Assigned Projects',
        href: '/projects',
        variant: 'info',
      });
    }
  }

  const actionableCount = notifications.filter(
    (n) => n.variant === 'warning' || n.variant === 'danger' || n.id === 'founder-draft-payroll'
  ).length;

  return (
    <header className="sticky top-0 z-40 w-full bg-white/95 backdrop-blur-md border-b border-surface-border/80 shadow-[0_2px_10px_rgba(11,31,58,0.03)]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
        {/* Left: Brand / Logo */}
        <div className="flex items-center space-x-3">
          <button
            onClick={onToggleMobileMenu}
            className="p-2 -ml-2 rounded-xl text-ink-secondary hover:text-navy hover:bg-surface-inset lg:hidden focus:outline-none"
            aria-label="Toggle navigation menu"
          >
            <Menu className="w-5 h-5" />
          </button>

          <Link href={isFounder ? '/dashboard' : '/attendance'} className="flex items-center space-x-3 group">
            <div className="w-9 h-9 rounded-xl bg-navy text-white flex items-center justify-center font-bold text-base shadow-[0_3px_10px_rgba(11,31,58,0.25)] group-hover:bg-navy-deep transition-all">
              B
            </div>
            <div className="flex flex-col">
              <span className="font-bold tracking-tight text-navy text-base leading-none group-hover:text-navy-light transition-colors">
                BALE
              </span>
              <span className="text-[10px] uppercase font-semibold tracking-wider text-ink-secondary leading-tight mt-0.5">
                Asinta Architects
              </span>
            </div>
          </Link>

          <div className="hidden sm:block h-5 w-px bg-surface-border mx-2" />

          {/* Architectural Badge */}
          <div className="hidden md:flex items-center space-x-1.5 text-xs text-ink-secondary bg-surface-inset/70 px-2.5 py-1 rounded-lg border border-surface-border/50">
            <Building2 className="w-3.5 h-3.5 text-navy" />
            <span>Batangas Studio &amp; Build</span>
          </div>
        </div>

        {/* Right: Account panel and notifications */}
        <div className="flex items-center space-x-2 sm:space-x-3">
          {/* Authenticated account panel */}
          <div className="relative">
            <button
              onClick={() => {
                setShowUserMenu(!showUserMenu);
                setShowNotifications(false);
              }}
              className="flex items-center space-x-2 px-2.5 py-1.5 rounded-xl bg-surface-inset border border-surface-border hover:border-navy/40 text-xs font-medium text-navy transition-all shadow-[inset_1px_1px_2px_rgba(11,31,58,0.04)]"
            >
              <span className="w-2 h-2 rounded-full bg-status-success animate-pulse" />
              <span className="hidden sm:inline font-semibold">{user?.name || 'User'}</span>
              <Badge variant={isFounder ? 'navy' : 'warning'} size="sm">
                {isFounder ? 'Founder' : 'Supervisor'}
              </Badge>
              <ChevronDown className="w-3.5 h-3.5 text-ink-secondary" />
            </button>

            {/* Dropdown Menu */}
            {showUserMenu && (
              <div className="absolute right-0 mt-2 w-72 bg-white rounded-2xl border border-surface-border shadow-xl p-3 z-50 animate-in fade-in zoom-in-95">
                <div className="px-3 py-2 border-b border-surface-border/60">
                  <p className="text-xs font-bold text-navy uppercase tracking-wider">Signed-in Account</p>
                  <p className="text-sm font-semibold text-navy mt-0.5">{user?.name}</p>
                  <p className="text-xs text-ink-secondary">{user?.email}</p>
                  <div className="mt-2">
                    <Badge variant={isFounder ? 'navy' : 'warning'} size="sm">
                      {user?.role === 'founder'
                        ? 'Full Business Access (Founder)'
                        : 'Field Terminal (Supervisor)'}
                    </Badge>
                  </div>
                </div>

                <div className="pt-2 space-y-1">
                  <button
                    onClick={() => {
                      setShowUserMenu(false);
                      router.push('/settings');
                    }}
                    className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium text-navy hover:bg-surface-inset rounded-xl transition-colors"
                  >
                    <span>{isFounder ? 'Firm Settings & Security' : 'Supervisor Profile & Settings'}</span>
                    <ArrowRight className="w-3.5 h-3.5 text-ink-secondary" />
                  </button>

                  <button
                    onClick={handleLogout}
                    className="w-full flex items-center space-x-2 px-3 py-2 text-xs font-medium text-status-danger hover:bg-status-danger-bg rounded-xl transition-colors"
                  >
                    <LogOut className="w-4 h-4" />
                    <span>Sign Out of Supabase Session</span>
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Notifications button */}
          <div className="relative">
            <button
              onClick={() => {
                setShowNotifications(!showNotifications);
                setShowUserMenu(false);
              }}
              className="p-2 rounded-xl text-ink-secondary hover:text-navy hover:bg-surface-inset border border-transparent hover:border-surface-border transition-all relative"
              aria-label="Notifications"
            >
              <Bell className="w-4 h-4" />
              {actionableCount > 0 && (
                <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-status-warning rounded-full ring-2 ring-white" />
              )}
            </button>

            {showNotifications && (
              <div className="absolute right-0 mt-2 w-80 sm:w-96 bg-white rounded-2xl border border-surface-border shadow-xl p-4 z-50 animate-in fade-in zoom-in-95">
                <div className="flex items-center justify-between pb-3 border-b border-surface-border/60">
                  <div className="flex items-center gap-2">
                    <h4 className="text-xs font-bold uppercase tracking-wider text-navy">
                      {isFounder ? 'Founder Action Center' : 'Field Notifications'}
                    </h4>
                    <span
                      className="inline-flex items-center gap-1 text-[10px] font-semibold text-status-success"
                      title="Live Supabase Realtime & background sync active"
                    >
                      <span className="w-1.5 h-1.5 rounded-full bg-status-success animate-pulse" />
                      Live
                    </span>
                  </div>

                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={handleManualSync}
                      className="p-1 rounded-lg text-ink-secondary hover:text-navy hover:bg-surface-inset transition-colors"
                      title="Sync now"
                      aria-label="Sync notifications now"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin text-navy' : ''}`} />
                    </button>
                    <Badge variant={actionableCount > 0 ? 'warning' : 'success'} size="sm">
                      {actionableCount > 0 ? `${actionableCount} Action${actionableCount === 1 ? '' : 's'}` : 'All Clear'}
                    </Badge>
                  </div>
                </div>

                <div className="divide-y divide-surface-border/40 text-xs max-h-96 overflow-y-auto">
                  {notifications.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => handleNotificationClick(item.href)}
                      className="w-full text-left py-3 px-2 -mx-2 rounded-xl hover:bg-surface-inset/70 transition-colors group block"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <span className="font-bold text-navy group-hover:text-navy-deep">
                          {item.title}
                        </span>
                        <Badge variant={item.variant} size="sm">
                          {item.variant === 'danger'
                            ? 'Urgent'
                            : item.variant === 'warning'
                              ? 'Action'
                              : item.variant === 'success'
                                ? 'Synced'
                                : 'Info'}
                        </Badge>
                      </div>
                      <div className="text-ink-secondary mt-1 leading-relaxed">
                        {item.description}
                      </div>
                      <div className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-bold text-navy group-hover:underline">
                        <span>{item.actionLabel}</span>
                        <ArrowRight className="w-3 h-3 transition-transform group-hover:translate-x-0.5" />
                      </div>
                    </button>
                  ))}

                  {notifications.length === 0 && (
                    <div className="py-6 text-center text-ink-secondary">
                      No pending items — everything is up to date.
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </header>
  );
};
