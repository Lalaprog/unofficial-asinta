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
import { BaleLogo } from '@/components/ui/AsintaLogo';
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
  actionable?: boolean;
  priority?: number;
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
        label: 'Tools & Equipment',
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
        label: 'Client Directory',
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
  { label: 'Assigned Projects', href: '/projects', tab: null, icon: FolderKanban },
];

export const Navbar: React.FC<NavbarProps> = () => {
  const { user, logout, isFounder, isSupervisor } = useAuth();
  const {
    invoices,
    attendance,
    payroll,
    projects,
    workers,
    users,
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
  const [localAttendanceTab, setLocalAttendanceTab] = useState<string>(currentTab);
  const [pendingHref, setPendingHref] = useState<string | null>(null);
  const navRef = useRef<HTMLDivElement>(null);
  const notificationButtonRef = useRef<HTMLButtonElement>(null);
  const accountMenuButtonRef = useRef<HTMLButtonElement>(null);

  const storageKey = user?.id ? `bale-dismissed-notifs:${user.id}` : null;

  // Close popovers on route/query change
  useEffect(() => {
    setLocalAttendanceTab(currentTab);
    setPendingHref(null);
    setOpenDropdownId(null);
    setShowUserMenu(false);
    setShowNotifications(false);
  }, [pathname, currentTab]);

  // Listen for 0ms client-side attendance tab changes
  useEffect(() => {
    const onTabEvent = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail;
      if (detail) {
        setLocalAttendanceTab(detail);
        setPendingHref(null);
      }
    };
    window.addEventListener('bale:attendance-tab', onTabEvent);
    return () => window.removeEventListener('bale:attendance-tab', onTabEvent);
  }, []);

  // Close popovers on outside click or Escape.
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (navRef.current && !navRef.current.contains(event.target as Node)) {
        setOpenDropdownId(null);
        setShowUserMenu(false);
        setShowNotifications(false);
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (showNotifications) notificationButtonRef.current?.focus();
      else if (showUserMenu) accountMenuButtonRef.current?.focus();
      setOpenDropdownId(null);
      setShowUserMenu(false);
      setShowNotifications(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [showNotifications, showUserMenu]);

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

  const dismissNotification = (signature: string) => {
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
    const [basePath, query] = item.href.split('?');
    if (basePath === '/attendance' && pathname === '/attendance') {
      const targetTab = new URLSearchParams(query || '').get('tab') || 'terminal';
      setLocalAttendanceTab(targetTab);
      window.history.replaceState(null, '', item.href);
      window.dispatchEvent(new CustomEvent('bale:attendance-tab', { detail: targetTab }));
      return;
    }
    router.push(item.href);
  };

  const handleManualSync = async () => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    try {
      await refresh({ silent: true });
    } finally {
      setIsRefreshing(false);
    }
  };

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
    setOpenDropdownId(null);
    setShowUserMenu(false);
    setShowNotifications(false);
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
    const unverifiedSelfLogs = attendance.filter((a) => {
      if (a.is_founder_override) return false;
      if (a.status !== 'present' && a.status !== 'half_day') return false;
      if (a.worker_id === a.recorded_by) return true;
      const notes = a.notes || '';
      if (notes.includes('Pending Founder Review') || notes.includes('Founder Review:')) {
        return true;
      }
      const w = workers.find((item) => item.id === a.worker_id);
      if (!w) return false;
      return (
        w.position.toLowerCase().includes('supervisor') ||
        users.some(
          (u) =>
            u.role === 'supervisor' &&
            (u.id === w.id || u.name.trim().toLowerCase() === w.name.trim().toLowerCase())
        )
      );
    });
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
        actionable: true,
        priority: 1,
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
        description: `${missingSitesToday.length} active site(s) have no attendance logged for ${todayStr}. Submit these roll calls so the day's workforce and Payroll records are complete.`,
        actionLabel: 'Open Roll Call',
        href: '/attendance',
        variant: 'warning',
        actionable: true,
        priority: 2,
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
        actionable: true,
        priority: 3,
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
        actionable: true,
        priority: 0,
      });
    });

  } else if (isSupervisor && user) {
    const assignedSites = getProjectsForSupervisor(user.id);
    const assignedSiteIds = new Set(assignedSites.map((p) => p.id));
    const loggedSiteIdsToday = new Set(
      attendance
        .filter((record) => record.date === todayStr && assignedSiteIds.has(record.project_id))
        .map((record) => record.project_id)
    );
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
        actionable: true,
        priority: 0,
      });
    } else if (pendingSitesToday.length > 0) {
      const pendingKey = pendingSitesToday.map((p) => p.id).sort().join(',');
      allNotifications.push({
        id: 'sup-pending-attendance',
        signature: `sup-pending-attendance:${todayStr}:${pendingKey}`,
        title: "Today's Daily Attendance Due",
        description: `Submit daily attendance for ${pendingSitesToday
          .map((p) => p.name)
          .join(', ')} (${todayStr}); otherwise, crew records and Payroll will remain incomplete.`,
        actionLabel: 'Open Roll Call',
        href: '/attendance',
        variant: 'warning',
        actionable: true,
        priority: 1,
      });
    }

    const latestOverride = attendance
      .filter((record) => assignedSiteIds.has(record.project_id) && record.is_founder_override)
      .reduce<(typeof attendance)[number] | null>((latest, record) => {
        if (!latest) return record;
        return Date.parse(record.submitted_at) > Date.parse(latest.submitted_at) ? record : latest;
      }, null);
    if (latestOverride) {
      const workerName = workers.find((worker) => worker.id === latestOverride.worker_id)?.name;
      const projectName = projects.find((project) => project.id === latestOverride.project_id)?.name;
      allNotifications.push({
        id: 'sup-founder-override',
        signature: `sup-founder-override:${latestOverride.id}:${latestOverride.submitted_at}:${latestOverride.status}`,
        title: 'Founder updated an attendance record',
        description: `${workerName || 'A worker'} at ${projectName || 'your assigned site'} was verified or adjusted. Review the update for payroll accuracy.`,
        actionLabel: 'Review attendance history',
        href: '/attendance?tab=history',
        variant: 'info',
        actionable: true,
        priority: 2,
        dismissOnClick: true,
      });
    }
  }

  const isActionableNotification = (notification: ActionNotification) =>
    notification.actionable ??
    (notification.variant === 'danger' || notification.variant === 'warning');
  const visibleNotifications = [...allNotifications]
    .sort((a, b) => (a.priority ?? 10) - (b.priority ?? 10))
    .filter((notification) => !dismissedSignatures.includes(notification.signature));
  const actionableNotificationCount = visibleNotifications.filter(isActionableNotification).length;
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
        className="sticky top-0 z-40 w-full bg-white/95 backdrop-blur-md border-b border-surface-border/80 shadow-[0_2px_12px_rgba(11,31,58,0.04)] relative"
      >
        {pendingHref && (
          <div className="absolute top-0 inset-x-0 h-0.5 bg-surface-inset overflow-hidden">
            <div className="h-full w-1/2 bg-[#1B4978] animate-[asintaProgress_0.9s_ease-in-out_infinite]" />
          </div>
        )}
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-4">
          {/* Left: Official BALE System Mark (Asinta Corp. logo lives in the global Trademark Footer) */}
          <Link
            href={isFounder ? '/dashboard' : '/attendance'}
            onClick={(e) => handleNavClick(e, isFounder ? '/dashboard' : '/attendance')}
            className="flex items-center space-x-2.5 group shrink-0"
          >
            <BaleLogo height={24} />
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
                  onClick={(e) => handleNavClick(e, '/dashboard')}
                  className={`flex items-center space-x-1.5 px-3.5 py-2 rounded-xl text-xs font-bold transition-all active:scale-[0.98] ${
                    isHrefActive('/dashboard')
                      ? 'bg-brand text-white'
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
                        <div className="absolute left-0 mt-2 w-72 rounded-2xl bg-white border border-surface-border shadow-lg p-2 z-50 animate-dropdown-enter">
                          <div className="space-y-1">
                            {group.items.map((item) => {
                              const Icon = item.icon;
                              const itemActive = isHrefActive(item.href);

                              return (
                                <Link
                                  key={item.href}
                                  href={item.href}
                                  onClick={(e) => handleNavClick(e, item.href)}
                                  className={`flex items-start space-x-3 p-2.5 rounded-xl transition-all ${
                                    itemActive
                                      ? 'bg-brand text-white'
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
                    onClick={(e) => handleNavClick(e, item.href)}
                    className={`flex items-center space-x-1.5 px-4 py-2 rounded-xl text-xs font-bold transition-all active:scale-[0.98] ${
                      active
                        ? 'bg-brand text-white'
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
                ref={notificationButtonRef}
                className="w-11 h-11 rounded-lg text-ink-secondary hover:text-brand hover:bg-surface-inset border border-surface-border bg-white flex items-center justify-center transition-colors active:scale-95 relative focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/25"
                aria-label={
                  actionableNotificationCount > 0
                    ? `${actionableNotificationCount} actionable notification${actionableNotificationCount === 1 ? '' : 's'}`
                    : 'Notifications'
                }
                aria-expanded={showNotifications}
                aria-controls={showNotifications ? 'navbar-notifications-panel' : undefined}
              >
                <Bell className="w-4 h-4" />
                {actionableNotificationCount > 0 && (
                  <span
                    aria-hidden="true"
                    className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 bg-status-warning text-navy text-[10px] font-bold rounded-full ring-2 ring-white flex items-center justify-center"
                  >
                    {actionableNotificationCount > 99 ? '99+' : actionableNotificationCount}
                  </span>
                )}
              </button>

              {showNotifications && (
                <div
                  id="navbar-notifications-panel"
                  role="region"
                  aria-labelledby="navbar-notifications-title"
                  className="absolute right-0 mt-2 w-[calc(100vw-2rem)] sm:w-96 bg-white rounded-xl border border-surface-border shadow-lg p-2.5 sm:p-3 z-50 animate-dropdown-enter"
                >
                  <div className="flex items-center justify-between gap-2 border-b border-surface-border pb-2.5">
                    <div className="flex min-w-0 items-center gap-2">
                      <h4 id="navbar-notifications-title" className="text-sm font-semibold text-navy truncate">
                        {actionableNotificationCount > 0
                          ? isFounder
                            ? 'Founder tasks'
                            : 'Site tasks'
                          : isFounder
                            ? 'Founder updates'
                            : 'Site updates'}
                      </h4>
                      <span
                        className="inline-flex shrink-0 items-center gap-1 text-[10px] font-medium text-status-success"
                        title="Live Supabase Realtime and background sync are active"
                      >
                        <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full bg-status-success animate-pulse" />
                        Live
                      </span>
                    </div>

                    <div className="flex shrink-0 items-center gap-1">
                      {visibleNotifications.length > 0 && (
                        <button
                          type="button"
                          onClick={handleClearAll}
                          className="inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-[11px] font-medium text-ink-secondary hover:text-navy hover:bg-surface-inset transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/25"
                          title="Clear all notifications"
                        >
                          <CheckCheck className="w-3.5 h-3.5" />
                          <span>Clear all</span>
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={handleManualSync}
                        disabled={isRefreshing}
                        className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg text-ink-secondary hover:text-navy hover:bg-surface-inset transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/25"
                        title="Sync now"
                        aria-label="Sync notifications now"
                        aria-busy={isRefreshing}
                      >
                        <RefreshCw
                          className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin text-brand' : ''}`}
                        />
                      </button>
                    </div>
                  </div>

                  <div className="mt-1 max-h-[70vh] overflow-y-auto divide-y divide-surface-border/70 text-xs">
                    {visibleNotifications.map((item) => (
                      <article key={item.id} className="py-2">
                        <div className="flex items-start gap-2 rounded-lg px-2 py-2 transition-colors hover:bg-surface">
                          <button
                            type="button"
                            onClick={() => handleNotificationClick(item)}
                            className="min-w-0 flex-1 whitespace-normal text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/25 rounded-md"
                          >
                            <span className="block break-words font-semibold leading-snug text-navy">
                              {item.title}
                            </span>
                            <span className="mt-1 block break-words text-[12px] leading-relaxed text-ink-secondary">
                              {item.description}
                            </span>
                            <span className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-semibold text-brand">
                              <span>{item.actionLabel}</span>
                              <ArrowRight className="w-3 h-3" />
                            </span>
                          </button>

                          <div className="flex shrink-0 items-center gap-1">
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
                              onClick={() => dismissNotification(item.signature)}
                              className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-transparent text-ink-muted hover:text-navy hover:bg-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/25"
                              title="Dismiss notification"
                              aria-label={`Dismiss ${item.title}`}
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      </article>
                    ))}

                    {visibleNotifications.length === 0 && (
                      <div className="px-4 py-7 text-center space-y-2">
                        <CheckCheck className="mx-auto h-5 w-5 text-status-success" aria-hidden="true" />
                        <p className="text-xs font-medium text-ink-secondary">
                          All clear — nothing needs attention right now.
                        </p>
                        {dismissedCount > 0 && (
                          <button
                            type="button"
                            onClick={handleRestoreDismissed}
                            className="inline-flex min-h-11 items-center justify-center rounded-lg px-3 text-[11px] font-semibold text-brand hover:bg-surface-inset focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/25"
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
                ref={accountMenuButtonRef}
                title={`${user?.name || 'Account'} (${isFounder ? 'Founder' : 'Supervisor'})`}
                aria-label="Account and Sign Out menu"
                aria-expanded={showUserMenu}
                aria-controls={showUserMenu ? 'navbar-account-menu' : undefined}
                className={`w-11 h-11 rounded-lg border flex items-center justify-center transition-colors active:scale-95 relative focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/25 ${
                  isFounder
                    ? 'bg-[#1B4978] text-white border-[#14395E] hover:bg-navy'
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
                <div id="navbar-account-menu" className="absolute right-0 mt-2 w-72 bg-white rounded-xl border border-surface-border shadow-lg p-3 z-50 animate-dropdown-enter">
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
