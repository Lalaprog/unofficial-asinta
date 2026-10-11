'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth/authContext';
import { useDataStore } from '@/lib/data/store';
import {
  LogOut,
  ChevronDown,
  Menu,
  Bell,
  ArrowRight,
  RefreshCw,
  X,
  CheckCheck,
} from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { AsintaEmblem, AsintaWordmark } from '@/components/ui/AsintaLogo';
import { formatPesoCompact } from '@/lib/email/format';

interface NavbarProps {
  onToggleMobileMenu?: () => void;
}

interface ActionNotification {
  id: string;
  /** Changes automatically when the underlying records change, so new events resurface */
  signature: string;
  title: string;
  description: string;
  actionLabel: string;
  href: string;
  variant: 'warning' | 'danger' | 'info' | 'success';
  /** Informational notifications auto-dismiss when clicked */
  dismissOnClick?: boolean;
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
  const [dismissedSignatures, setDismissedSignatures] = useState<string[]>([]);

  const storageKey = user?.id ? `bale-dismissed-notifs:${user.id}` : null;

  useEffect(() => {
    if (!storageKey || typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          setDismissedSignatures(parsed.filter((x): x is string => typeof x === 'string'));
        }
      }
    } catch {
      // Ignore storage read errors
    }
  }, [storageKey]);

  const persistDismissed = (next: string[]) => {
    setDismissedSignatures(next);
    if (!storageKey || typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(next.slice(-100)));
    } catch {
      // Ignore storage write errors
    }
  };

  const dismissNotification = (signature: string, e?: React.MouseEvent) => {
    if (e) {
      e.stopPropagation();
    }
    if (!dismissedSignatures.includes(signature)) {
      persistDismissed([...dismissedSignatures, signature]);
    }
  };

  const handleLogout = async () => {
    await logout();
    router.push('/');
  };

  const handleNotificationClick = (item: ActionNotification) => {
    if (item.dismissOnClick) {
      dismissNotification(item.signature);
    }
    setShowNotifications(false);
    router.push(item.href);
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

  // Build role-specific, clickable action notifications.
  // Action notifications automatically disappear once the user completes the
  // underlying action (e.g. submitting attendance, verifying a supervisor's
  // self-check-in, approving draft payroll, or marking an invoice paid).
  const allNotifications: ActionNotification[] = [];

  if (isFounder) {
    // 1. Unverified Supervisor Self-Attendance (Anti-Fraud Gate)
    const unverifiedSelfLogs = attendance.filter(
      (a) =>
        a.worker_id === a.recorded_by &&
        !a.is_founder_override &&
        (a.status === 'present' || a.status === 'half_day')
    );
    if (unverifiedSelfLogs.length > 0) {
      const sigIds = unverifiedSelfLogs.map((a) => `${a.id}:${a.status}`).sort().join('|');
      allNotifications.push({
        id: 'founder-unverified-sup-self',
        signature: `founder-unverified-sup-self:${sigIds}`,
        title: 'Verify Supervisor Self-Attendance',
        description: `${unverifiedSelfLogs.length} Supervisor self-logged attendance record(s) require Founder verification before Payroll disbursement.`,
        actionLabel: 'Verify or Reject on Attendance Page',
        href: '/attendance?tab=history',
        variant: 'warning',
      });
    }

    // 2. Today's Field Attendance Sync (or pending sites)
    const todayLogs = attendance.filter((a) => a.date === todayStr);
    const todayLoggedProjectIds = new Set(todayLogs.map((a) => a.project_id));
    const activeProjects = projects.filter(
      (p) => p.status !== 'completed' && p.status !== 'on_hold'
    );
    const missingSitesToday = activeProjects.filter((p) => !todayLoggedProjectIds.has(p.id));

    if (missingSitesToday.length > 0) {
      const missingKey = missingSitesToday.map((p) => p.id).sort().join(',');
      allNotifications.push({
        id: 'founder-attendance-missing',
        signature: `founder-attendance-missing:${todayStr}:${missingKey}`,
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

    if (todayLogs.length > 0) {
      allNotifications.push({
        id: 'founder-attendance-today',
        signature: `founder-attendance-today:${todayStr}:${todayLogs.length}`,
        title: 'Field Attendance Synced Today',
        description: `${todayLogs.length} worker record(s) across ${todayLoggedProjectIds.size} site(s) are live and ready for Payroll.`,
        actionLabel: 'Review Attendance Roster',
        href: '/attendance',
        variant: 'success',
        dismissOnClick: true,
      });
    }

    // 3. Draft Payroll Vouchers awaiting Founder approval
    const draftVouchers = payroll.filter((p) => p.status === 'draft' || p.status === 'reviewed');
    if (draftVouchers.length > 0) {
      const draftTotal = draftVouchers.reduce((sum, p) => sum + Number(p.net_pay || 0), 0);
      const draftKey = draftVouchers.map((p) => `${p.id}:${p.net_pay}`).sort().join('|');
      allNotifications.push({
        id: 'founder-draft-payroll',
        signature: `founder-draft-payroll:${draftKey}`,
        title: 'Draft Payroll Vouchers Pending Approval',
        description: `${draftVouchers.length} voucher(s) totaling ${formatPHP(draftTotal)} are waiting for Founder approval.`,
        actionLabel: 'Approve in Payroll Engine',
        href: '/payroll',
        variant: 'info',
      });
    }

    // 4. Overdue Client Progress Invoices
    const overdueInvoices = invoices.filter(
      (i) =>
        i.status !== 'paid' &&
        i.status !== 'cancelled' &&
        (i.status === 'overdue' || new Date(i.due_date) < now)
    );
    overdueInvoices.slice(0, 3).forEach((inv) => {
      const balance = inv.amount - inv.amount_paid;
      allNotifications.push({
        id: `founder-overdue-${inv.id}`,
        signature: `founder-overdue:${inv.id}:${balance}`,
        title: `Overdue Billing: ${inv.invoice_number}`,
        description: `${formatPHP(balance)} balance past due (${inv.due_date}).`,
        actionLabel: 'Collect or Send Reminder',
        href: '/invoices',
        variant: 'danger',
      });
    });

    // 5. Active Worker Advances (Bale)
    const activeBales = advances.filter(
      (a) => a.status === 'active' || a.status === 'partially_deducted'
    );
    if (activeBales.length > 0) {
      const baleBalance = activeBales.reduce(
        (sum, a) => sum + Math.max(0, Number(a.amount || 0) - Number(a.amount_deducted || 0)),
        0
      );
      allNotifications.push({
        id: 'founder-active-bale',
        signature: `founder-active-bale:${activeBales.length}:${baleBalance}`,
        title: 'Active Worker Advances (Bale)',
        description: `${activeBales.length} active advance(s) (${formatPHP(baleBalance)} outstanding) queued for payroll deduction.`,
        actionLabel: 'Manage Bale Ledger',
        href: '/advances',
        variant: 'info',
        dismissOnClick: true,
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
      allNotifications.push({
        id: 'sup-no-site',
        signature: 'sup-no-site:0',
        title: 'No Project Site Assigned Yet',
        description: 'Your Supervisor profile does not have an assigned construction site yet.',
        actionLabel: 'View Supervisor Profile',
        href: '/settings',
        variant: 'warning',
      });
    } else if (pendingSitesToday.length > 0) {
      const pendingKey = pendingSitesToday.map((p) => p.id).sort().join(',');
      allNotifications.push({
        id: 'sup-pending-attendance',
        signature: `sup-pending-attendance:${todayStr}:${pendingKey}`,
        title: "Today's Daily Attendance Due",
        description: `Submit daily attendance for ${pendingSitesToday
          .map((p) => p.name)
          .join(', ')} (${todayStr}).`,
        actionLabel: 'Record Site Attendance',
        href: '/attendance',
        variant: 'warning',
      });
    } else if (todaySiteLogs.length > 0) {
      allNotifications.push({
        id: 'sup-synced-today',
        signature: `sup-synced-today:${todayStr}:${todaySiteLogs.length}`,
        title: "Today's Attendance Synced to Payroll",
        description: `${todaySiteLogs.length} worker record(s) submitted for ${todayStr} and live in the Payroll Engine.`,
        actionLabel: 'View Attendance Logs',
        href: '/attendance?tab=history',
        variant: 'success',
        dismissOnClick: true,
      });
    }

    // Recent Founder Overrides / Verifications on the Supervisor's assigned sites
    const overriddenLogs = attendance.filter(
      (a) => assignedSiteIds.has(a.project_id) && a.is_founder_override
    );
    if (overriddenLogs.length > 0) {
      const latestOverrideId = overriddenLogs[0]?.id || String(overriddenLogs.length);
      allNotifications.push({
        id: 'sup-founder-override',
        signature: `sup-founder-override:${overriddenLogs.length}:${latestOverrideId}`,
        title: 'Founder Attendance Verification / Update',
        description: `${overriddenLogs.length} attendance log(s) on your assigned site(s) were verified or adjusted by a Founder.`,
        actionLabel: 'Inspect History Logs',
        href: '/attendance?tab=history',
        variant: 'info',
        dismissOnClick: true,
      });
    }
  }

  const visibleNotifications = allNotifications.filter(
    (n) => !dismissedSignatures.includes(n.signature)
  );
  const dismissedCount = allNotifications.length - visibleNotifications.length;

  const handleClearAll = () => {
    const merged = Array.from(
      new Set([...dismissedSignatures, ...allNotifications.map((n) => n.signature)])
    );
    persistDismissed(merged);
  };

  const handleRestoreDismissed = () => {
    persistDismissed([]);
  };

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

          <Link
            href={isFounder ? '/dashboard' : '/attendance'}
            className="flex items-center space-x-2.5 group"
          >
            <div className="w-9 h-9 rounded-xl bg-white border border-surface-border flex items-center justify-center shadow-neu-raised-sm group-hover:border-navy/30 transition-all">
              <AsintaEmblem size={24} />
            </div>
            <div className="flex items-center gap-2">
              <AsintaWordmark height={18} />
              <span className="px-1.5 py-0.5 rounded-md bg-navy text-white text-[9px] font-extrabold uppercase tracking-widest">
                BALE
              </span>
            </div>
          </Link>
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
              {visibleNotifications.length > 0 && (
                <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 bg-status-warning text-navy text-[10px] font-extrabold rounded-full ring-2 ring-white flex items-center justify-center">
                  {visibleNotifications.length}
                </span>
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
                    {visibleNotifications.length > 0 && (
                      <button
                        type="button"
                        onClick={handleClearAll}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-semibold text-ink-secondary hover:text-navy hover:bg-surface-inset transition-colors"
                        title="Clear all notifications"
                      >
                        <CheckCheck className="w-3.5 h-3.5" />
                        <span>Clear All</span>
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={handleManualSync}
                      className="p-1 rounded-lg text-ink-secondary hover:text-navy hover:bg-surface-inset transition-colors"
                      title="Sync now"
                      aria-label="Sync notifications now"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin text-navy' : ''}`} />
                    </button>
                  </div>
                </div>

                <div className="divide-y divide-surface-border/40 text-xs max-h-96 overflow-y-auto">
                  {visibleNotifications.map((item) => (
                    <div
                      key={item.id}
                      onClick={() => handleNotificationClick(item)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          handleNotificationClick(item);
                        }
                      }}
                      className="w-full text-left py-3 px-2 -mx-2 rounded-xl hover:bg-surface-inset/70 transition-colors group cursor-pointer relative"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <span className="font-bold text-navy group-hover:text-navy-deep pr-1">
                          {item.title}
                        </span>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <Badge variant={item.variant} size="sm">
                            {item.variant === 'danger'
                              ? 'Urgent'
                              : item.variant === 'warning'
                                ? 'Action'
                                : item.variant === 'success'
                                  ? 'Synced'
                                  : 'Info'}
                          </Badge>
                          <button
                            type="button"
                            onClick={(e) => dismissNotification(item.signature, e)}
                            className="p-1 rounded-md text-ink-muted hover:text-navy hover:bg-white transition-colors"
                            title="Dismiss notification"
                            aria-label={`Dismiss ${item.title}`}
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                      <div className="text-ink-secondary mt-1 leading-relaxed">
                        {item.description}
                      </div>
                      <div className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-bold text-navy group-hover:underline">
                        <span>{item.actionLabel}</span>
                        <ArrowRight className="w-3 h-3 transition-transform group-hover:translate-x-0.5" />
                      </div>
                    </div>
                  ))}

                  {visibleNotifications.length === 0 && (
                    <div className="py-6 text-center space-y-2">
                      <div className="text-ink-secondary">
                        All clear — no pending notifications.
                      </div>
                      {dismissedCount > 0 && (
                        <button
                          type="button"
                          onClick={handleRestoreDismissed}
                          className="text-[11px] font-semibold text-navy hover:underline"
                        >
                          Show {dismissedCount} cleared notification{dismissedCount === 1 ? '' : 's'}
                        </button>
                      )}
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
