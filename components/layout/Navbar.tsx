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
import { Modal } from '@/components/ui/Modal';
import { formatPesoCompact } from '@/lib/email/format';
import { useManilaToday } from '@/lib/dates/useManilaToday';

interface NavbarProps {
  onToggleMobileMenu?: () => void;
  showDesktopNavigation?: boolean;
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
  notificationIds?: string[];
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

interface NotificationCardProps {
  item: ActionNotification;
  compact?: boolean;
  onOpen: (item: ActionNotification) => void;
  onDismiss: (item: ActionNotification) => void;
}

function getNotificationTypeLabel(variant: ActionNotification['variant']): string {
  if (variant === 'danger') return 'Urgent';
  if (variant === 'warning') return 'Action';
  if (variant === 'success') return 'Synced';
  return 'Info';
}

const NotificationCard: React.FC<NotificationCardProps> = ({
  item,
  compact = false,
  onOpen,
  onDismiss,
}) => (
  <article className={compact ? 'py-3' : 'py-2'}>
    {compact ? (
      <div className="rounded-xl px-2 py-1 transition-colors hover:bg-surface/70">
        <div className="flex items-center justify-between gap-2">
          <Badge variant={item.variant} size="sm">
            {getNotificationTypeLabel(item.variant)}
          </Badge>
          <button
            type="button"
            onClick={() => onDismiss(item)}
            className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full text-ink-muted transition-colors hover:bg-surface-inset hover:text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
            title="Dismiss notification"
            aria-label={`Dismiss ${item.title}`}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <button
          type="button"
          onClick={() => onOpen(item)}
          className="mt-1 block min-h-11 w-full rounded-lg py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-inset"
        >
          <span className="block break-words text-sm font-semibold leading-snug text-navy">
            {item.title}
          </span>
          <span className="mt-1 block break-words text-[13px] leading-relaxed text-ink-secondary">
            {item.description}
          </span>
          <span className="mt-3 inline-flex min-h-10 w-full items-center justify-between gap-2 rounded-lg bg-surface-inset/80 px-3 text-xs font-semibold text-brand">
            <span className="break-words text-left">{item.actionLabel}</span>
            <ArrowRight className="h-4 w-4 shrink-0" aria-hidden="true" />
          </span>
        </button>
      </div>
    ) : (
      <div className="flex items-start gap-2 rounded-lg px-2 py-2 transition-colors hover:bg-surface">
        <button
          type="button"
          onClick={() => onOpen(item)}
          className="min-w-0 flex-1 whitespace-normal rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
        >
          <span className="block break-words font-semibold leading-snug text-navy">
            {item.title}
          </span>
          <span className="mt-1 block break-words text-[12px] leading-relaxed text-ink-secondary">
            {item.description}
          </span>
          <span className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-semibold text-brand">
            <span>{item.actionLabel}</span>
            <ArrowRight className="h-3 w-3" aria-hidden="true" />
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-1">
          <Badge variant={item.variant} size="sm">
            {getNotificationTypeLabel(item.variant)}
          </Badge>
          <button
            type="button"
            onClick={() => onDismiss(item)}
            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-transparent text-ink-muted transition-colors hover:bg-white hover:text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
            title="Dismiss notification"
            aria-label={`Dismiss ${item.title}`}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    )}
  </article>
);

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

export const Navbar: React.FC<NavbarProps> = ({ showDesktopNavigation = true }) => {
  const { user, logout, isFounder, isSupervisor } = useAuth();
  const {
    invoices,
    attendance,
    payroll,
    projects,
    workers,
    users,
    userNotifications,
    getProjectsForSupervisor,
    markUserNotificationsRead,
    refresh,
  } = useDataStore();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const currentTab = searchParams?.get('tab') || 'terminal';

  const [showUserMenu, setShowUserMenu] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  const [isCompactViewport, setIsCompactViewport] = useState(false);
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

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const viewport = window.matchMedia('(max-width: 1023px)');
    const updateViewport = () => setIsCompactViewport(viewport.matches);
    updateViewport();

    if (typeof viewport.addEventListener === 'function') {
      viewport.addEventListener('change', updateViewport);
      return () => viewport.removeEventListener('change', updateViewport);
    }

    viewport.addListener(updateViewport);
    return () => viewport.removeListener(updateViewport);
  }, []);

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
      const target = event.target;
      const isInsideDialog = target instanceof Element && Boolean(target.closest('[role="dialog"]'));
      if (
        navRef.current &&
        !navRef.current.contains(target as Node) &&
        !isInsideDialog
      ) {
        setOpenDropdownId(null);
        setShowUserMenu(false);
        setShowNotifications(false);
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // The shared Modal owns Escape handling and focus restoration for the sheet.
      if (showNotifications && isCompactViewport) return;
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
  }, [isCompactViewport, showNotifications, showUserMenu]);

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

  const dismissNotification = (item: ActionNotification) => {
    if (item.notificationIds?.length) {
      void markUserNotificationsRead(item.notificationIds);
      return;
    }
    if (!dismissedSignatures.includes(item.signature)) {
      persistDismissed([...dismissedSignatures, item.signature]);
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
    if (item.notificationIds?.length) {
      void markUserNotificationsRead(item.notificationIds);
    }
    if (item.dismissOnClick) {
      dismissNotification(item);
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
  const todayStr = useManilaToday();

  const allNotifications: ActionNotification[] = [];

  if (isFounder) {
    const pendingRequestsBySite = new Map<string, typeof userNotifications>();
    userNotifications
      .filter(
        (notification) =>
          notification.event_type === 'advance_request_submitted' &&
          !notification.read_at &&
          Boolean(notification.advance_request_id)
      )
      .forEach((notification) => {
        const siteKey = notification.project_id || 'site-unknown';
        const siteNotifications = pendingRequestsBySite.get(siteKey) ?? [];
        siteNotifications.push(notification);
        pendingRequestsBySite.set(siteKey, siteNotifications);
      });

    pendingRequestsBySite.forEach((siteNotifications, siteKey) => {
      const siteId = siteKey === 'site-unknown' ? null : siteKey;
      const siteName = projects.find((project) => project.id === siteId)?.name || 'Site';
      const requestCount = siteNotifications.length;
      const requestedTotal = siteNotifications.reduce(
        (sum, notification) => sum + notification.requested_amount,
        0
      );
      const eventIds = siteNotifications.map((notification) => notification.id).sort();
      allNotifications.push({
        id: `founder-bale-requests-${siteKey}`,
        signature: `founder-bale-requests:${eventIds.join('|')}`,
        title: requestCount === 1 ? `New Bale request · ${siteName}` : `${requestCount} new Bale requests · ${siteName}`,
        description: `${requestCount} request${requestCount === 1 ? '' : 's'} totaling ${formatPHP(requestedTotal)} are awaiting review at this site.`,
        actionLabel: 'Review site requests',
        href: siteId
          ? `/advances?tab=requests&site=${encodeURIComponent(siteId)}`
          : '/advances?tab=requests',
        variant: 'warning',
        actionable: true,
        priority: 1,
        notificationIds: eventIds,
      });
    });

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
    userNotifications
      .filter((notification) => notification.event_type !== 'advance_request_submitted' && !notification.read_at)
      .forEach((notification) => {
        const workerName = workers.find((worker) => worker.id === notification.worker_id)?.name || 'Worker';
        const siteName = projects.find((project) => project.id === notification.project_id)?.name || 'your assigned site';
        const eventCopy = {
          advance_request_approved: {
            title: 'Bale request approved',
            message: 'was approved and is waiting for payment confirmation.',
            actionLabel: 'View approved request',
            variant: 'success' as const,
          },
          advance_request_rejected: {
            title: 'Bale request not approved',
            message: 'was not approved by the Founder.',
            actionLabel: 'View request',
            variant: 'danger' as const,
          },
          advance_request_issued: {
            title: 'Bale payment confirmed',
            message: 'was paid and recorded in Issued Advances.',
            actionLabel: 'View issued request',
            variant: 'info' as const,
          },
          advance_request_submitted: {
            title: 'Bale request update',
            message: 'has an update.',
            actionLabel: 'View request',
            variant: 'info' as const,
          },
        }[notification.event_type];
        const requestQuery = notification.advance_request_id
          ? `&request=${encodeURIComponent(notification.advance_request_id)}`
          : '';
        const createdDate = new Date(notification.created_at).toLocaleDateString('en-PH', {
          month: 'short',
          day: 'numeric',
        });

        allNotifications.push({
          id: `supervisor-bale-${notification.id}`,
          signature: `supervisor-bale:${notification.id}`,
          title: eventCopy.title,
          description: `${workerName}’s request for ${formatPHP(notification.requested_amount)} at ${siteName} ${eventCopy.message} ${createdDate}.`,
          actionLabel: eventCopy.actionLabel,
          href: `/advances?tab=requests${requestQuery}`,
          variant: eventCopy.variant,
          actionable: true,
          priority: 1,
          notificationIds: [notification.id],
        });
      });

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
    const unreadNotificationIds = userNotifications
      .filter((notification) => !notification.read_at)
      .map((notification) => notification.id);
    if (unreadNotificationIds.length > 0) {
      void markUserNotificationsRead(unreadNotificationIds);
    }

    const localSignatures = allNotifications
      .filter((notification) => !notification.notificationIds?.length)
      .map((notification) => notification.signature);
    const merged = Array.from(new Set([...dismissedSignatures, ...localSignatures]));
    persistDismissed(merged);
  };

  const handleRestoreDismissed = () => {
    persistDismissed([]);
  };

  const notificationHeading =
    actionableNotificationCount > 0
      ? isFounder
        ? 'Founder tasks'
        : 'Site tasks'
      : isFounder
        ? 'Founder updates'
        : 'Site updates';

  const renderNotificationControls = () => (
    <div className="flex shrink-0 items-center gap-1">
      {visibleNotifications.length > 0 && (
        <button
          type="button"
          onClick={handleClearAll}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-full px-2.5 text-[11px] font-medium text-ink-secondary transition-colors hover:bg-surface-inset hover:text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
          title="Clear all notifications"
        >
          <CheckCheck className="h-3.5 w-3.5" />
          <span>Clear all</span>
        </button>
      )}
      <button
        type="button"
        onClick={handleManualSync}
        disabled={isRefreshing}
        className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-full text-ink-secondary transition-colors hover:bg-surface-inset hover:text-navy disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
        title="Sync now"
        aria-label="Sync notifications now"
        aria-busy={isRefreshing}
      >
        <RefreshCw className={`h-3.5 w-3.5 ${isRefreshing ? 'animate-spin text-brand' : ''}`} />
      </button>
    </div>
  );

  const renderNotificationList = (compact = false) => (
    <div className="divide-y divide-surface-border/70 text-xs">
      {visibleNotifications.map((item) => (
        <NotificationCard
          key={item.id}
          item={item}
          compact={compact}
          onOpen={handleNotificationClick}
          onDismiss={dismissNotification}
        />
      ))}

      {visibleNotifications.length === 0 && (
        <div className="space-y-2 px-4 py-7 text-center">
          <CheckCheck className="mx-auto h-5 w-5 text-status-success" aria-hidden="true" />
          <p className="text-xs font-medium text-ink-secondary">
            All clear — nothing needs attention right now.
          </p>
          {dismissedCount > 0 && (
            <button
              type="button"
              onClick={handleRestoreDismissed}
              className="inline-flex min-h-11 items-center justify-center rounded-full px-3 text-[11px] font-semibold text-brand transition-colors hover:bg-surface-inset focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
            >
              Show {dismissedCount} cleared notification{dismissedCount === 1 ? '' : 's'}
            </button>
          )}
        </div>
      )}
    </div>
  );

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
        <div className="w-full px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-4">
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
          {showDesktopNavigation && (
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
          )}

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
                className={`relative inline-flex min-h-11 min-w-11 items-center justify-center rounded-full text-ink-secondary transition-colors active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 ${
                  showNotifications
                    ? 'bg-surface-inset text-brand'
                    : 'hover:bg-surface-inset hover:text-brand'
                }`}
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

              {showNotifications && !isCompactViewport && (
                <div
                  id="navbar-notifications-panel"
                  role="region"
                  aria-labelledby="navbar-notifications-title"
                  className="absolute right-0 top-full z-50 mt-2 w-96 max-w-[calc(100vw-2rem)] rounded-xl border border-surface-border bg-white p-2.5 shadow-lg animate-dropdown-enter sm:p-3"
                >
                  <div className="flex items-center justify-between gap-2 border-b border-surface-border pb-2.5">
                    <div className="flex min-w-0 items-center gap-2">
                      <h4 id="navbar-notifications-title" className="truncate text-sm font-semibold text-navy">
                        {notificationHeading}
                      </h4>
                      <span
                        className="inline-flex shrink-0 items-center gap-1 text-[10px] font-medium text-status-success"
                        title="Live Supabase Realtime and background sync are active"
                      >
                        <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-status-success animate-pulse" />
                        Live
                      </span>
                    </div>
                    {renderNotificationControls()}
                  </div>
                  <div className="mt-1 max-h-[min(70vh,32rem)] overflow-y-auto overscroll-contain">
                    {renderNotificationList()}
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
                className={`relative inline-flex min-h-11 min-w-11 items-center justify-center rounded-full transition-colors active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 ${
                  isFounder
                    ? `bg-[#1B4978] text-white hover:bg-navy ${showUserMenu ? 'ring-2 ring-brand/20' : ''}`
                    : `bg-status-warning-bg text-status-warning hover:bg-status-warning/20 ${showUserMenu ? 'ring-2 ring-status-warning/25' : ''}`
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

      {isCompactViewport && (
        <Modal
          isOpen={showNotifications}
          onClose={() => setShowNotifications(false)}
          title={notificationHeading}
          description="Updates for your role and assigned sites."
          maxWidth="full"
          presentation="top-sheet"
        >
          <div
            id="navbar-notifications-panel"
            className="space-y-2"
          >
            <div className="flex items-center justify-between gap-2 border-b border-surface-border/70 pb-2">
              <span
                className="inline-flex shrink-0 items-center gap-1.5 text-[11px] font-medium text-status-success"
                title="Live Supabase Realtime and background sync are active"
              >
                <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-status-success animate-pulse" />
                Live updates
              </span>
              {renderNotificationControls()}
            </div>
            {renderNotificationList(true)}
          </div>
        </Modal>
      )}
    </>
  );
};
