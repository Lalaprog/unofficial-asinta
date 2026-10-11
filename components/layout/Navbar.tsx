'use client';

import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/lib/auth/authContext';
import { useDataStore } from '@/lib/data/store';
import {
  LogOut,
  ChevronDown,
  Bell,
  ArrowRight,
  RefreshCw,
  X,
  CheckCheck,
  Compass,
  HardHat,
  LayoutDashboard,
  FolderKanban,
  Wrench,
  Users,
  Receipt,
  CalendarClock,
  MessageSquareShare,
  UserCheck,
  History,
  UserPlus,
  HandCoins,
  Banknote,
  CreditCard,
  ShieldCheck,
  Settings,
} from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { AsintaLoader } from '@/components/ui/AsintaLoader';
import { formatPesoCompact } from '@/lib/email/format';

interface NavbarProps {
  onToggleMobileMenu?: () => void;
}

interface ActionNotification {
  id: string;
  signature: string;
  title: string;
  description: string;
  actionLabel: string;
  href: string;
  variant: 'warning' | 'danger' | 'info' | 'success';
  dismissOnClick?: boolean;
}

interface NavDropdownItem {
  label: string;
  description: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
}

interface NavDropdownGroup {
  id: string;
  label: string;
  items: NavDropdownItem[];
}

const FOUNDER_DROPDOWN_GROUPS: NavDropdownGroup[] = [
  {
    id: 'sites',
    label: 'Studio & Sites',
    items: [
      {
        label: 'Project Sites',
        description: 'Active builds, budgets & milestones',
        href: '/projects',
        icon: FolderKanban,
      },
      {
        label: 'Tools & Plant',
        description: 'Site equipment & condition tracking',
        href: '/tools',
        icon: Wrench,
      },
    ],
  },
  {
    id: 'receivables',
    label: 'Receivables',
    items: [
      {
        label: 'Clients',
        description: 'Client directory & project accounts',
        href: '/clients',
        icon: Users,
      },
      {
        label: 'Invoices & Billing',
        description: 'Progress billing & payment receipts',
        href: '/invoices',
        icon: Receipt,
      },
      {
        label: 'Reminder Queue',
        description: 'Automated billing follow-ups',
        href: '/reminders',
        icon: CalendarClock,
      },
      {
        label: 'PhilSMS Log',
        description: 'SMS gateway dispatch history',
        href: '/sms',
        icon: MessageSquareShare,
      },
    ],
  },
  {
    id: 'workforce',
    label: 'Workforce & Pay',
    items: [
      {
        label: 'Daily Roll Call',
        description: 'Mark daily site crew attendance',
        href: '/attendance',
        icon: UserCheck,
      },
      {
        label: 'Attendance History',
        description: 'Submitted logs & supervisor approvals',
        href: '/attendance?tab=history',
        icon: History,
      },
      {
        label: 'Workforce Roster',
        description: 'Craftsmen profiles & daily pay rates',
        href: '/attendance?tab=workforce',
        icon: UserPlus,
      },
      {
        label: 'Worker Bale',
        description: 'Cash advances & deduction balances',
        href: '/advances',
        icon: HandCoins,
      },
      {
        label: 'Payroll Engine',
        description: 'Period computation & payslips',
        href: '/payroll',
        icon: Banknote,
      },
    ],
  },
  {
    id: 'admin',
    label: 'Ledger & Admin',
    items: [
      {
        label: 'Site Expenses & AI',
        description: 'Receipts, AI categorization & costs',
        href: '/expenses',
        icon: CreditCard,
      },
      {
        label: 'Team Accounts',
        description: 'Founder & Supervisor provisioning',
        href: '/users',
        icon: ShieldCheck,
      },
      {
        label: 'Firm Settings',
        description: '2FA security, templates & status',
        href: '/settings',
        icon: Settings,
      },
    ],
  },
];

const SUPERVISOR_TOP_LINKS = [
  { label: 'Roll Call', href: '/attendance', tab: 'terminal', icon: UserCheck },
  { label: 'History', href: '/attendance?tab=history', tab: 'history', icon: History },
  { label: 'Workforce', href: '/attendance?tab=workforce', tab: 'workforce', icon: UserPlus },
  { label: 'Projects', href: '/projects', tab: null, icon: FolderKanban },
];

export const Navbar: React.FC<NavbarProps> = () => {
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
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const currentTab = searchParams?.get('tab') || 'terminal';

  const [showUserMenu, setShowUserMenu] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  const [openDropdownId, setOpenDropdownId] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [dismissedSignatures, setDismissedSignatures] = useState<string[]>([]);
  const navRef = useRef<HTMLDivElement>(null);

  const storageKey = user?.id ? `bale-dismissed-notifs:${user.id}` : null;

  // Close popovers on route/query change
  useEffect(() => {
    setOpenDropdownId(null);
    setShowUserMenu(false);
    setShowNotifications(false);
  }, [pathname, currentTab]);

  // Close popovers on outside click
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (navRef.current && !navRef.current.contains(event.target as Node)) {
        setOpenDropdownId(null);
        setShowUserMenu(false);
        setShowNotifications(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

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
    setShowUserMenu(false);
    setIsSigningOut(true);
    try {
      await logout();
      router.replace('/');
    } catch {
      setIsSigningOut(false);
    }
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

  const isHrefActive = (href: string) => {
    const [basePath, query] = href.split('?');
    if (basePath === '/attendance') {
      if (pathname !== '/attendance') return false;
      const targetTab = new URLSearchParams(query || '').get('tab') || 'terminal';
      return currentTab === targetTab;
    }
    return pathname === basePath || Boolean(pathname?.startsWith(`${basePath}/`));
  };

  const isGroupActive = (group: NavDropdownGroup) =>
    group.items.some((item) => {
      const [basePath] = item.href.split('?');
      return pathname === basePath || Boolean(pathname?.startsWith(`${basePath}/`));
    });

  const formatPHP = formatPesoCompact;
  const now = new Date();
  const todayStr = now.toISOString().split('T')[0];

  const allNotifications: ActionNotification[] = [];

  if (isFounder) {
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
        actionLabel: 'Verify in Attendance History',
        href: '/attendance?tab=history',
        variant: 'warning',
      });
    }

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
        actionLabel: 'Open Roll Call',
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
        actionLabel: 'Review Roll Call',
        href: '/attendance',
        variant: 'success',
        dismissOnClick: true,
      });
    }

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
        actionLabel: 'Open Roll Call',
        href: '/attendance',
        variant: 'warning',
      });
    } else if (todaySiteLogs.length > 0) {
      allNotifications.push({
        id: 'sup-synced-today',
        signature: `sup-synced-today:${todayStr}:${todaySiteLogs.length}`,
        title: "Today's Attendance Synced to Payroll",
        description: `${todaySiteLogs.length} worker record(s) submitted for ${todayStr} and live in the Payroll Engine.`,
        actionLabel: 'View Attendance History',
        href: '/attendance?tab=history',
        variant: 'success',
        dismissOnClick: true,
      });
    }

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
        actionLabel: 'Inspect Attendance History',
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
    <>
      {isSigningOut && (
        <AsintaLoader
          variant="fullscreen"
          title="Securing session & signing out…"
          subtitle="Closing your BALE workspace safely"
        />
      )}

      <header
        ref={navRef}
        className="sticky top-0 z-40 w-full bg-white/95 backdrop-blur-md border-b border-surface-border/80 shadow-[0_2px_12px_rgba(11,31,58,0.04)]"
      >
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-4">
          {/* Left: Minimalist BALE System Mark (Asinta Corp. logo lives in the global Trademark Footer) */}
          <Link
            href={isFounder ? '/dashboard' : '/attendance'}
            prefetch={false}
            className="flex items-center space-x-2.5 group shrink-0"
          >
            <div className="px-2.5 py-1 rounded-xl bg-navy text-white font-black text-xs tracking-[0.18em] shadow-sm group-hover:bg-navy-light transition-all">
              BALE
            </div>
            <span className="hidden sm:inline text-xs font-semibold text-ink-secondary tracking-tight">
              {isFounder ? 'Studio & Ledger' : 'Field Operations'}
            </span>
          </Link>

          {/* Center: Desktop Top Navigation (Dropdown Groups for Founder, Direct Tabs for Supervisor) */}
          <nav className="hidden lg:flex items-center space-x-1.5" aria-label="Primary Navigation">
            {isFounder ? (
              <>
                <Link
                  href="/dashboard"
                  prefetch={false}
                  className={`flex items-center space-x-1.5 px-3.5 py-2 rounded-xl text-xs font-bold transition-all active:scale-[0.98] ${
                    pathname === '/dashboard'
                      ? 'bg-navy text-white shadow-[0_4px_12px_rgba(11,31,58,0.18)]'
                      : 'text-ink-secondary hover:text-navy hover:bg-surface-inset/70'
                  }`}
                >
                  <LayoutDashboard className="w-3.5 h-3.5" />
                  <span>Overview</span>
                </Link>

                {FOUNDER_DROPDOWN_GROUPS.map((group) => {
                  const active = isGroupActive(group);
                  const isOpen = openDropdownId === group.id;

                  return (
                    <div key={group.id} className="relative">
                      <button
                        type="button"
                        onClick={() => {
                          setOpenDropdownId(isOpen ? null : group.id);
                          setShowUserMenu(false);
                          setShowNotifications(false);
                        }}
                        className={`flex items-center space-x-1.5 px-3.5 py-2 rounded-xl text-xs font-bold transition-all active:scale-[0.98] ${
                          active
                            ? 'bg-navy/10 text-navy border border-navy/15'
                            : isOpen
                              ? 'bg-surface-inset text-navy'
                              : 'text-ink-secondary hover:text-navy hover:bg-surface-inset/70'
                        }`}
                      >
                        <span>{group.label}</span>
                        <ChevronDown
                          className={`w-3.5 h-3.5 transition-transform duration-200 ${
                            isOpen ? 'rotate-180 text-navy' : 'text-ink-muted'
                          }`}
                        />
                      </button>

                      {isOpen && (
                        <div className="absolute left-0 mt-2 w-72 rounded-2xl bg-white border border-surface-border shadow-[10px_14px_32px_rgba(11,31,58,0.12)] p-2 z-50 animate-dropdown-enter">
                          <div className="space-y-1">
                            {group.items.map((item) => {
                              const Icon = item.icon;
                              const itemActive = isHrefActive(item.href);

                              return (
                                <Link
                                  key={item.href}
                                  href={item.href}
                                  prefetch={false}
                                  onClick={() => setOpenDropdownId(null)}
                                  className={`flex items-start space-x-3 p-2.5 rounded-xl transition-all ${
                                    itemActive
                                      ? 'bg-navy text-white shadow-sm'
                                      : 'hover:bg-surface-inset/70 text-navy'
                                  }`}
                                >
                                  <div
                                    className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5 ${
                                      itemActive
                                        ? 'bg-white/15 text-white'
                                        : 'bg-surface-inset text-navy border border-surface-border/70'
                                    }`}
                                  >
                                    <Icon className="w-4 h-4" />
                                  </div>
                                  <div className="min-w-0 flex-1">
                                    <div
                                      className={`text-xs font-bold truncate ${
                                        itemActive ? 'text-white' : 'text-navy'
                                      }`}
                                    >
                                      {item.label}
                                    </div>
                                    <div
                                      className={`text-[11px] truncate ${
                                        itemActive ? 'text-white/75' : 'text-ink-secondary'
                                      }`}
                                    >
                                      {item.description}
                                    </div>
                                  </div>
                                </Link>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </>
            ) : (
              SUPERVISOR_TOP_LINKS.map((item) => {
                const Icon = item.icon;
                const active = isHrefActive(item.href);

                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    prefetch={false}
                    className={`flex items-center space-x-1.5 px-4 py-2 rounded-xl text-xs font-bold transition-all active:scale-[0.98] ${
                      active
                        ? 'bg-navy text-white shadow-[0_4px_12px_rgba(11,31,58,0.18)]'
                        : 'text-ink-secondary hover:text-navy hover:bg-surface-inset/70'
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    <span>{item.label}</span>
                  </Link>
                );
              })
            )}
          </nav>

          {/* Right: Notification Bell & Role Icon Account Menu */}
          <div className="flex items-center space-x-2 shrink-0">
            {/* Notifications button */}
            <div className="relative">
              <button
                type="button"
                onClick={() => {
                  setShowNotifications(!showNotifications);
                  setShowUserMenu(false);
                  setOpenDropdownId(null);
                }}
                className="w-10 h-10 rounded-xl text-ink-secondary hover:text-navy hover:bg-surface-inset border border-surface-border/70 bg-white flex items-center justify-center transition-all active:scale-95 relative shadow-[2px_2px_6px_rgba(11,31,58,0.04)]"
                aria-label="Notifications"
              >
                <Bell className="w-4 h-4" />
                {visibleNotifications.length > 0 && (
                  <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 bg-status-warning text-navy text-[10px] font-extrabold rounded-full ring-2 ring-white flex items-center justify-center">
                    {visibleNotifications.length}
                  </span>
                )}
              </button>

              {showNotifications && (
                <div className="absolute right-0 mt-2 w-80 sm:w-96 bg-white rounded-2xl border border-surface-border shadow-xl p-4 z-50 animate-dropdown-enter">
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
                        <RefreshCw
                          className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin text-navy' : ''}`}
                        />
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

            {/* Role Icon Account Menu (Single unified place for Profile & Sign Out) */}
            <div className="relative">
              <button
                type="button"
                onClick={() => {
                  setShowUserMenu(!showUserMenu);
                  setShowNotifications(false);
                  setOpenDropdownId(null);
                }}
                title={`${user?.name || 'Account'} (${isFounder ? 'Founder' : 'Supervisor'})`}
                aria-label="Account and Sign Out menu"
                className={`w-10 h-10 rounded-xl border flex items-center justify-center transition-all active:scale-95 relative shadow-[2px_2px_6px_rgba(11,31,58,0.06)] ${
                  isFounder
                    ? 'bg-navy text-white border-navy-deep hover:bg-navy-light'
                    : 'bg-status-warning-bg text-status-warning border-status-warning/30 hover:bg-status-warning/20'
                }`}
              >
                {isFounder ? (
                  <Compass className="w-4 h-4" />
                ) : (
                  <HardHat className="w-4 h-4" />
                )}
                <span className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-status-success ring-2 ring-white" />
              </button>

              {showUserMenu && (
                <div className="absolute right-0 mt-2 w-72 bg-white rounded-2xl border border-surface-border shadow-xl p-3 z-50 animate-dropdown-enter">
                  <div className="px-3 py-2.5 border-b border-surface-border/60 flex items-start space-x-3">
                    <div
                      className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 mt-0.5 ${
                        isFounder
                          ? 'bg-navy text-white'
                          : 'bg-status-warning-bg text-status-warning border border-status-warning/25'
                      }`}
                    >
                      {isFounder ? (
                        <Compass className="w-5 h-5" />
                      ) : (
                        <HardHat className="w-5 h-5" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-bold text-navy truncate">{user?.name}</p>
                      <p className="text-xs text-ink-secondary truncate">{user?.email}</p>
                      <div className="mt-1.5">
                        <Badge variant={isFounder ? 'navy' : 'warning'} size="sm">
                          {isFounder ? 'Founder & Principal' : 'Site Supervisor'}
                        </Badge>
                      </div>
                    </div>
                  </div>

                  <div className="pt-2 space-y-1">
                    <button
                      type="button"
                      onClick={() => {
                        setShowUserMenu(false);
                        router.push('/settings');
                      }}
                      className="w-full flex items-center justify-between px-3 py-2.5 text-xs font-semibold text-navy hover:bg-surface-inset rounded-xl transition-colors"
                    >
                      <span>{isFounder ? 'Firm Settings & Security' : 'My Supervisor Profile'}</span>
                      <ArrowRight className="w-3.5 h-3.5 text-ink-secondary" />
                    </button>

                    <button
                      type="button"
                      onClick={handleLogout}
                      className="w-full flex items-center space-x-2 px-3 py-2.5 text-xs font-bold text-status-danger hover:bg-status-danger-bg rounded-xl transition-colors"
                    >
                      <LogOut className="w-4 h-4" />
                      <span>Sign Out</span>
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </header>
    </>
  );
};
