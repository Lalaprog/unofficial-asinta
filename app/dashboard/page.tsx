'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { AppShell } from '@/components/layout/AppShell';
import { useDataStore } from '@/lib/data/store';
import type { Invoice, ToolCondition } from '@/types';
import type { CostBurnSummary, ProjectFinancialSummary } from '@/lib/dashboard/financialMetrics';
import { calculateFinancialDashboardMetrics } from '@/lib/dashboard/financialMetrics';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Modal } from '@/components/ui/Modal';
import { buildReminderSMS } from '@/lib/sms/templates';
import { formatDatePH, formatPeso } from '@/lib/email/format';

const TOOL_CONDITION_LABELS: Record<ToolCondition, string> = {
  excellent: 'Excellent',
  good: 'Good',
  fair: 'Fair',
  needs_repair: 'Needs repair',
  damaged: 'Damaged',
};

function getProjectStatusVariant(status: ProjectFinancialSummary['status']) {
  if (status === 'active') return 'success';
  if (status === 'planning') return 'info';
  return 'warning';
}

function getProjectStatusDotColor(status: ProjectFinancialSummary['status']) {
  if (status === 'active') return 'bg-status-success';
  if (status === 'planning') return 'bg-status-info';
  return 'bg-status-warning';
}

// ---------------------------------------------------------------------------
// HCI Animated Number Hook & Components (Tabular, Eased, Reduced-Motion Safe)
// ---------------------------------------------------------------------------

function useAnimatedNumber(target: number, durationMs = 520): number {
  const [displayValue, setDisplayValue] = useState<number>(target);
  const prevTargetRef = useRef<number | null>(null);

  useEffect(() => {
    if (
      typeof window === 'undefined' ||
      typeof window.requestAnimationFrame !== 'function' ||
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    ) {
      setDisplayValue(target);
      prevTargetRef.current = target;
      return;
    }

    const startValue = prevTargetRef.current === null ? 0 : prevTargetRef.current;
    prevTargetRef.current = target;

    if (Math.abs(startValue - target) < 0.005) {
      setDisplayValue(target);
      return;
    }

    const startTime = performance.now();
    let rafId = 0;

    const tick = (now: number) => {
      const elapsed = Math.max(0, now - startTime);
      const progress = Math.min(1, elapsed / durationMs);
      // easeOutQuart: brisk initial sweep, settles trailing digits one by one
      const eased = 1 - Math.pow(1 - progress, 4);
      const nextVal = startValue + (target - startValue) * eased;
      setDisplayValue(progress >= 1 ? target : nextVal);

      if (progress < 1) {
        rafId = window.requestAnimationFrame(tick);
      }
    };

    rafId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(rafId);
  }, [target, durationMs]);

  return displayValue;
}

function AnimatedPeso({
  amount,
  className = '',
}: {
  amount: number;
  className?: string;
}) {
  const animated = useAnimatedNumber(amount, 540);
  const exactLabel = formatPeso(amount);
  return (
    <span className={`tabular-nums ${className}`} aria-label={exactLabel}>
      {formatPeso(animated)}
    </span>
  );
}

function AnimatedInteger({
  value,
  suffix = '',
  prefix = '',
  className = '',
}: {
  value: number;
  suffix?: string;
  prefix?: string;
  className?: string;
}) {
  const animated = useAnimatedNumber(value, 460);
  const rounded = Math.round(animated);
  return (
    <span
      className={`tabular-nums ${className}`}
      aria-label={`${prefix}${Math.round(value)}${suffix}`}
    >
      {prefix}
      {rounded.toLocaleString('en-PH')}
      {suffix}
    </span>
  );
}

function AnimatedDecimal({
  value,
  decimals = 1,
  suffix = '',
  prefix = '',
  className = '',
}: {
  value: number;
  decimals?: number;
  suffix?: string;
  prefix?: string;
  className?: string;
}) {
  const animated = useAnimatedNumber(value, 480);
  return (
    <span
      className={`tabular-nums ${className}`}
      aria-label={`${prefix}${value.toFixed(decimals)}${suffix}`}
    >
      {prefix}
      {animated.toFixed(decimals)}
      {suffix}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Bespoke Fading Bottom-Right Architectural & Financial Watermarks (No Lucide)
// ---------------------------------------------------------------------------

function ReceivablesWatermark() {
  return (
    <svg
      viewBox="0 0 120 120"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className="watermark-fade pointer-events-none absolute -bottom-4 -right-3 z-0 h-32 w-32 select-none text-brand/[0.085] transition-transform duration-300 group-hover:scale-105"
    >
      <rect
        x="22"
        y="16"
        width="64"
        height="82"
        rx="8"
        stroke="currentColor"
        strokeWidth="3.5"
      />
      <path
        d="M34 34H74M34 48H66M34 62H56"
        stroke="currentColor"
        strokeWidth="3.5"
        strokeLinecap="round"
      />
      <circle
        cx="78"
        cy="78"
        r="24"
        fill="white"
        fillOpacity="0.6"
        stroke="currentColor"
        strokeWidth="3.5"
      />
      <path
        d="M78 66V90M71 73.5C71 70.5 74 68.5 78 68.5C82 68.5 84.5 70.5 84.5 73.5C84.5 76.5 81.5 77.5 78 78.5C74.5 79.5 71.5 81 71.5 84C71.5 87 74.5 89 78.5 89C82.5 89 85 87 85 84"
        stroke="currentColor"
        strokeWidth="3.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function WorkforcePayWatermark() {
  return (
    <svg
      viewBox="0 0 120 120"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className="watermark-fade pointer-events-none absolute -bottom-4 -right-3 z-0 h-32 w-32 select-none text-brand/[0.085] transition-transform duration-300 group-hover:scale-105"
    >
      <rect
        x="16"
        y="24"
        width="88"
        height="52"
        rx="8"
        stroke="currentColor"
        strokeWidth="3.5"
      />
      <circle cx="60" cy="50" r="11" stroke="currentColor" strokeWidth="3.2" />
      <path
        d="M26 36H36M84 36H94M26 64H36M84 64H94"
        stroke="currentColor"
        strokeWidth="3.2"
        strokeLinecap="round"
      />
      <path
        d="M24 90H96"
        stroke="currentColor"
        strokeWidth="3"
        strokeDasharray="6 6"
        strokeLinecap="round"
      />
      <path
        d="M36 102H84"
        stroke="currentColor"
        strokeWidth="3.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ProjectCostWatermark() {
  return (
    <svg
      viewBox="0 0 120 120"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className="watermark-fade pointer-events-none absolute -bottom-4 -right-3 z-0 h-32 w-32 select-none text-brand/[0.085] transition-transform duration-300 group-hover:scale-105"
    >
      <path
        d="M20 96H102"
        stroke="currentColor"
        strokeWidth="3.5"
        strokeLinecap="round"
      />
      <rect
        x="28"
        y="64"
        width="14"
        height="32"
        rx="3"
        stroke="currentColor"
        strokeWidth="3.2"
      />
      <rect
        x="52"
        y="48"
        width="14"
        height="48"
        rx="3"
        stroke="currentColor"
        strokeWidth="3.2"
      />
      <rect
        x="76"
        y="30"
        width="14"
        height="66"
        rx="3"
        stroke="currentColor"
        strokeWidth="3.2"
      />
      <path
        d="M26 50L54 34L84 18M84 18H68M84 18V34"
        stroke="currentColor"
        strokeWidth="3.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ProjectScopeWatermark() {
  return (
    <svg
      viewBox="0 0 120 120"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className="watermark-fade pointer-events-none absolute -bottom-4 -right-3 z-0 h-32 w-32 select-none text-brand/[0.085] transition-transform duration-300 group-hover:scale-105"
    >
      <path
        d="M60 16L98 36V84L60 104L22 84V36L60 16Z"
        stroke="currentColor"
        strokeWidth="3.5"
        strokeLinejoin="round"
      />
      <path
        d="M22 36L60 56L98 36M60 56V104"
        stroke="currentColor"
        strokeWidth="3.2"
        strokeLinejoin="round"
      />
      <path
        d="M41 26L79 46M79 26L41 46"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeDasharray="4 4"
      />
    </svg>
  );
}

function AttentionBoardWatermark() {
  return (
    <svg
      viewBox="0 0 120 120"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className="watermark-fade pointer-events-none absolute -bottom-5 -right-4 z-0 h-36 w-36 select-none text-brand/[0.06]"
    >
      <circle cx="72" cy="72" r="38" stroke="currentColor" strokeWidth="3" strokeDasharray="6 6" />
      <circle cx="72" cy="72" r="24" stroke="currentColor" strokeWidth="3.2" />
      <path
        d="M72 58V74M72 83H72.05"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ProjectRegisterWatermark() {
  return (
    <svg
      viewBox="0 0 120 120"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className="watermark-fade pointer-events-none absolute -bottom-5 -right-4 z-0 h-36 w-36 select-none text-brand/[0.055]"
    >
      <rect x="18" y="22" width="84" height="76" rx="8" stroke="currentColor" strokeWidth="3.2" />
      <path d="M18 42H102M46 42V98M74 42V98M18 68H102" stroke="currentColor" strokeWidth="2.8" />
    </svg>
  );
}

function ArrowGlyph({ className = 'h-3.5 w-3.5' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className={`shrink-0 transition-transform duration-150 group-hover/link:translate-x-0.5 ${className}`}
    >
      <path
        d="M3.5 8H12.5M12.5 8L8.75 4.25M12.5 8L8.75 11.75"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function TrendUpGlyph({ className = 'h-3.5 w-3.5' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className={`shrink-0 ${className}`}
    >
      <path
        d="M2.5 11L6.5 7L9.2 9.7L13.5 4.5M13.5 4.5H9.8M13.5 4.5V8.2"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Helper Renderers
// ---------------------------------------------------------------------------

function renderToolConditionSummary(project: ProjectFinancialSummary) {
  if (project.toolUnits === 0) {
    return <span className="text-ink-muted">No tools assigned</span>;
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      {(Object.entries(project.toolConditionCounts) as [ToolCondition, number][])
        .filter(([, count]) => count > 0)
        .map(([condition, count]) => (
          <Badge
            key={condition}
            size="sm"
            variant={
              condition === 'damaged'
                ? 'danger'
                : condition === 'needs_repair'
                  ? 'warning'
                  : 'neutral'
            }
          >
            {count} {TOOL_CONDITION_LABELS[condition].toLowerCase()}
          </Badge>
        ))}
    </div>
  );
}

function renderProjectSpend(project: ProjectFinancialSummary, formatPHP: (amount: number) => string) {
  const visualPercent = project.spendPercent === null ? 0 : Math.min(100, Math.max(0, project.spendPercent));

  return (
    <div className="min-w-0">
      <div className="font-semibold tabular-nums text-navy">{formatPHP(project.recordedExpenses)}</div>
      {project.spendPercent === null ? (
        <div className="mt-0.5 text-[11px] text-ink-muted">No estimate set</div>
      ) : (
        <>
          <div className={`mt-0.5 text-[11px] font-medium ${project.isOverEstimate ? 'text-status-danger' : 'text-ink-secondary'}`}>
            {project.spendPercent}% of estimate used
            {project.isOverEstimate && ` · ${formatPHP(project.amountOverEstimate)} over`}
          </div>
          <div
            className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-[#ece7dc]"
            role="progressbar"
            aria-label={`${project.name} recorded expenses versus estimate`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={visualPercent}
          >
            <div
              className={`h-full rounded-full transition-all duration-500 ease-out ${
                project.isOverEstimate ? 'bg-status-danger' : 'bg-brand'
              }`}
              style={{ width: `${visualPercent}%` }}
            />
          </div>
        </>
      )}
    </div>
  );
}

function renderCostBurnBadge(costBurn: CostBurnSummary) {
  const pct = costBurn.activeBudgetPercent ?? costBurn.activeSpendSharePercent ?? 0;

  if (costBurn.activePeriod === 'today') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-status-warning/25 bg-status-warning-bg px-2.5 py-0.5 text-[11px] font-semibold text-status-warning">
        <TrendUpGlyph className="h-3 w-3" />
        <AnimatedDecimal value={pct} decimals={1} prefix="+" suffix="% today" />
      </span>
    );
  }

  if (costBurn.activePeriod === 'last_7_days') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-brand/20 bg-[#eef4fa] px-2.5 py-0.5 text-[11px] font-semibold text-brand">
        <TrendUpGlyph className="h-3 w-3" />
        <AnimatedDecimal value={pct} decimals={1} prefix="+" suffix="% (7d)" />
      </span>
    );
  }

  if (costBurn.activePeriod === 'latest_day') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-[#dfd8c8] bg-[#f7f4ec] px-2.5 py-0.5 text-[11px] font-semibold text-navy">
        <TrendUpGlyph className="h-3 w-3" />
        <AnimatedDecimal value={pct} decimals={1} prefix="+" suffix="% latest" />
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-[#e3ddd2] bg-[#faf8f3] px-2.5 py-0.5 text-[11px] font-medium text-ink-muted">
      0.0% today
    </span>
  );
}

// ---------------------------------------------------------------------------
// Main Founder Dashboard Component
// ---------------------------------------------------------------------------

export default function FounderDashboard() {
  const {
    invoices,
    expenses,
    advances,
    advanceRequests,
    attendance,
    payroll,
    tools,
    clients,
    projects,
    sendSMS,
  } = useDataStore();

  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);

  const now = new Date();
  const asOfDate = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');

  const metrics = useMemo(
    () =>
      calculateFinancialDashboardMetrics(
        {
          invoices,
          expenses,
          advances,
          advanceRequests,
          attendance,
          payroll,
          tools,
          projects,
          selectedProjectId,
        },
        asOfDate
      ),
    [
      invoices,
      expenses,
      advances,
      advanceRequests,
      attendance,
      payroll,
      tools,
      projects,
      selectedProjectId,
      asOfDate,
    ]
  );

  const [smsModalOpen, setSmsModalOpen] = useState(false);
  const [selectedInvoiceForSMS, setSelectedInvoiceForSMS] = useState<Invoice | null>(null);
  const [smsSending, setSmsSending] = useState(false);
  const smsSendLock = useRef(false);
  const [smsSuccessMessage, setSmsSuccessMessage] = useState<string | null>(null);

  const formatPHP = formatPeso;

  const handleOpenSMSModal = (invoice: Invoice) => {
    setSelectedInvoiceForSMS(invoice);
    setSmsSuccessMessage(null);
    setSmsModalOpen(true);
  };

  const buildSmsPreviewMessage = (invoice: Invoice): string => {
    const client = clients.find((item) => item.id === invoice.client_id);
    const project = projects.find((item) => item.id === invoice.project_id);
    return buildReminderSMS({
      contactPerson: client?.contact_person,
      companyName: client?.name,
      invoiceNumber: invoice.invoice_number,
      projectName: project?.name || 'your project',
      outstandingBalance: Math.max(0, invoice.amount - invoice.amount_paid),
      dueDate: invoice.due_date,
      paymentRequestSentDate: null,
    });
  };

  const handleSendInvoiceSMS = async () => {
    if (!selectedInvoiceForSMS || smsSendLock.current) return;
    smsSendLock.current = true;
    setSmsSending(true);
    try {
      const sent = await sendSMS({ invoiceId: selectedInvoiceForSMS.id, message: buildSmsPreviewMessage(selectedInvoiceForSMS) });
      if (sent) setSmsSuccessMessage('Reminder handed to the PhilSMS gateway — see the SMS log for its status.');
    } finally {
      smsSendLock.current = false;
      setSmsSending(false);
    }
  };

  const activeProject = metrics.selectedProject;
  const scopeKey = activeProject ? activeProject.id : 'all-projects';
  const oldestOverdueInvoice = metrics.receivables.overdueInvoices[0];
  const currentProjectCount = metrics.projects.length;
  const scopedProjects = activeProject ? [activeProject] : metrics.projects;
  const projectsWithoutEstimateCount = scopedProjects.filter(
    (project) => project.budgetEstimate <= 0
  ).length;
  const pendingAdvanceRequestCount = metrics.baleRequests.pendingApprovalCount;
  const approvedAdvanceRequestCount = metrics.baleRequests.approvedPendingPaymentCount;

  const attentionItemCount =
    Number(metrics.receivables.overdueInvoiceCount > 0) +
    Number(metrics.payroll.needsReviewCount > 0) +
    Number(pendingAdvanceRequestCount > 0) +
    Number(approvedAdvanceRequestCount > 0) +
    Number(metrics.projectsOverEstimate.length > 0) +
    Number(metrics.tools.attentionUnits > 0);

  // Receivables split percentages for the health bar in Card 1
  const overdueSharePercent =
    metrics.receivables.outstanding > 0
      ? Math.min(
          100,
          Math.max(0, Math.round((metrics.receivables.overdue / metrics.receivables.outstanding) * 100))
        )
      : 0;
  const currentNotDueSharePercent =
    metrics.receivables.outstanding > 0 ? Math.max(0, 100 - overdueSharePercent) : 0;

  // Overall budget utilization bar for Card 3
  const overallSpendPercent = metrics.costBurn.overallSpendPercent;
  const overallSpendBarWidth =
    overallSpendPercent === null ? 0 : Math.min(100, Math.max(0, overallSpendPercent));

  const handleSelectProject = (projectId: string | null) => {
    setSelectedProjectId((current) => (current === projectId ? null : projectId));
  };

  return (
    <AppShell requireFounder={true}>
      <div className="dashboard-workspace w-full space-y-6 lg:space-y-7">
        {/* Header with subtle entrance */}
        <header
          style={{ '--rise-delay': '0ms' } as React.CSSProperties}
          className="blueprint-accent animate-card-rise flex flex-col gap-5 overflow-hidden rounded-[22px] border border-[#ded7c9] bg-[#f8f6f0] p-5 shadow-sm sm:flex-row sm:items-end sm:justify-between sm:p-6 lg:p-7"
        >
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <div className="inline-flex items-center gap-2 rounded-full border border-[#e3dccd] bg-white/85 px-3 py-1 text-[9px] font-bold uppercase tracking-[0.16em] text-brand">
                <span className="h-1.5 w-1.5 rounded-full bg-brand" aria-hidden="true" />
                Asinta Corp. · Founder desk
              </div>
              {activeProject && (
                <button
                  type="button"
                  onClick={() => setSelectedProjectId(null)}
                  className="inline-flex items-center gap-1.5 rounded-full border border-brand/25 bg-brand/10 px-3 py-1 text-[10px] font-bold text-brand transition-colors hover:bg-brand/15"
                  title="Click to reset project filter and view all projects"
                >
                  <span>Scope: {activeProject.name}</span>
                  <span aria-hidden="true" className="text-xs leading-none">
                    ×
                  </span>
                </button>
              )}
            </div>
            <h1 className="mt-3 text-2xl font-semibold tracking-tight text-navy sm:text-3xl">
              Studio overview
            </h1>
            <p className="mt-1.5 max-w-2xl text-xs leading-relaxed text-ink-secondary sm:text-sm">
              {activeProject
                ? `Focused project view for ${activeProject.name}—balances, workforce pay, daily budget burn, and follow-ups.`
                : 'Client balances, workforce payments, project costs, and site scope—all in one place.'}
            </p>
            <p className="mt-2 text-[11px] font-medium text-ink-muted">
              Snapshot as of {formatDatePH(metrics.asOfDate)}
            </p>
          </div>

          <div className="relative z-10 flex shrink-0 flex-wrap items-center gap-2">
            {activeProject && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="min-h-11 border border-[#ded7c9] bg-white/80"
                onClick={() => setSelectedProjectId(null)}
              >
                All projects
              </Button>
            )}
            <Link href="/invoices" prefetch={false} className="inline-flex min-h-11 items-center justify-center rounded-lg border border-surface-border bg-white px-3 text-xs font-medium text-navy transition-colors hover:border-surface-borderHover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2">
              Invoices
            </Link>
            <Link href="/expenses" prefetch={false} className="inline-flex min-h-11 items-center justify-center rounded-lg border border-brand bg-brand px-3 text-xs font-medium text-white transition-colors hover:bg-brand-deep focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2">
              Expenses
            </Link>
          </div>
        </header>

        {/* Top 4 KPI + Filter Cards */}
        <section
          aria-label="Balanced studio summary"
          className="dashboard-summary-grid grid grid-cols-1 gap-3.5 sm:grid-cols-2"
        >
          {/* CARD 1: Client Balances Due */}
          <Card
            style={{ '--rise-delay': '55ms' } as React.CSSProperties}
            className="group animate-card-rise relative flex h-full min-w-0 flex-col justify-between overflow-hidden border-[#e3ddd2] p-4 shadow-sm sm:p-5"
          >
            <div
              aria-hidden="true"
              className="absolute inset-x-0 top-0 h-[3px] bg-gradient-to-r from-brand/75 via-[#b5a68e]/55 to-transparent"
            />
            <ReceivablesWatermark />

            <div key={`receivables-${scopeKey}`} className="animate-scope-refresh relative z-10 flex h-full flex-col justify-between">
              <div>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h2 className="break-words text-[10px] font-bold uppercase tracking-[0.13em] text-ink-secondary">
                      Client balances due
                    </h2>
                    <p className="mt-0.5 truncate text-[11px] text-ink-muted">
                      {activeProject ? activeProject.name : `Across ${currentProjectCount} current projects`}
                    </p>
                  </div>
                  {metrics.receivables.overdueInvoiceCount > 0 ? (
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-status-danger/25 bg-status-danger-bg px-2.5 py-0.5 text-[10px] font-bold text-status-danger">
                      <span className="h-1.5 w-1.5 rounded-full bg-status-danger" aria-hidden="true" />
                      <AnimatedInteger value={metrics.receivables.overdueInvoiceCount} suffix=" overdue" />
                    </span>
                  ) : (
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-status-success/25 bg-status-success-bg px-2.5 py-0.5 text-[10px] font-bold text-status-success">
                      <span className="h-1.5 w-1.5 rounded-full bg-status-success" aria-hidden="true" />
                      On schedule
                    </span>
                  )}
                </div>

                <p className="mt-3 break-words text-2xl font-semibold tracking-tight text-navy sm:text-[28px]">
                  <AnimatedPeso amount={metrics.receivables.outstanding} />
                </p>

                {/* Health split progress bar */}
                <div className="mt-3">
                  <div className="flex items-center justify-between text-[10px] font-semibold text-ink-muted">
                    <span>
                      <AnimatedInteger value={metrics.receivables.openInvoiceCount} /> open invoice
                      {metrics.receivables.openInvoiceCount === 1 ? '' : 's'}
                    </span>
                    <span>
                      {metrics.receivables.outstanding > 0
                        ? `${currentNotDueSharePercent}% current · ${overdueSharePercent}% overdue`
                        : 'No open balance'}
                    </span>
                  </div>
                  <div
                    className="mt-1.5 flex h-1.5 w-full overflow-hidden rounded-full bg-[#ece7dc]"
                    role="progressbar"
                    aria-label="Client receivables health split"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={currentNotDueSharePercent}
                  >
                    <div
                      className="h-full bg-brand transition-all duration-500 ease-out"
                      style={{ width: `${currentNotDueSharePercent}%` }}
                    />
                    <div
                      className="h-full bg-status-danger transition-all duration-500 ease-out"
                      style={{ width: `${overdueSharePercent}%` }}
                    />
                  </div>
                </div>

                {/* Micro-ledger breakdown */}
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <div className="rounded-xl border border-[#e9e3d8] bg-[#faf8f3]/90 px-2.5 py-2">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-ink-muted">
                      Current
                    </p>
                    <p className="mt-0.5 truncate text-xs font-semibold text-navy">
                      <AnimatedPeso amount={metrics.receivables.currentNotDue} />
                    </p>
                    <p className="text-[10px] text-ink-secondary">
                      <AnimatedInteger value={metrics.receivables.currentNotDueCount} /> not yet due
                    </p>
                  </div>

                  <div
                    className={`rounded-xl border px-2.5 py-2 ${
                      metrics.receivables.overdueInvoiceCount > 0
                        ? 'border-status-danger/20 bg-status-danger-bg/45'
                        : 'border-[#e9e3d8] bg-[#faf8f3]/90'
                    }`}
                  >
                    <p className="text-[10px] font-bold uppercase tracking-wider text-ink-muted">
                      Overdue
                    </p>
                    <p
                      className={`mt-0.5 truncate text-xs font-semibold ${
                        metrics.receivables.overdueInvoiceCount > 0
                          ? 'text-status-danger'
                          : 'text-status-success'
                      }`}
                    >
                      {metrics.receivables.overdueInvoiceCount > 0 ? (
                        <AnimatedPeso amount={metrics.receivables.overdue} />
                      ) : (
                        'No overdue balances'
                      )}
                    </p>
                    <p className="text-[10px] text-ink-secondary">
                      <AnimatedInteger value={metrics.receivables.overdueInvoiceCount} /> past due date
                    </p>
                  </div>
                </div>
              </div>

              <div className="mt-3 flex items-center justify-between border-t border-[#eee9df] pt-2.5 text-xs">
                <Link
                  href="/invoices"
                  className="group/link inline-flex min-h-8 items-center gap-1.5 font-semibold text-brand hover:underline"
                >
                  Open invoices <ArrowGlyph />
                </Link>
                {oldestOverdueInvoice && (
                  <button
                    type="button"
                    onClick={() => handleOpenSMSModal(oldestOverdueInvoice)}
                    className="inline-flex min-h-8 items-center gap-1 rounded-lg border border-[#e3ddd2] bg-[#faf8f3] px-2.5 py-1 text-[11px] font-semibold text-navy transition-colors hover:border-brand/35 hover:text-brand"
                  >
                    Remind client
                  </button>
                )}
              </div>
            </div>
          </Card>

          {/* CARD 2: Workforce & Pay (Horizontal Architectural Cut Between Payroll & Bale) */}
          <Card
            style={{ '--rise-delay': '110ms' } as React.CSSProperties}
            className="group animate-card-rise relative flex h-full min-w-0 flex-col justify-between overflow-hidden border-[#e3ddd2] p-4 shadow-sm sm:p-5"
          >
            <div
              aria-hidden="true"
              className="absolute inset-x-0 top-0 h-[3px] bg-gradient-to-r from-brand/75 via-[#b5a68e]/55 to-transparent"
            />
            <WorkforcePayWatermark />

            <div key={`workforce-${scopeKey}`} className="animate-scope-refresh relative z-10 flex h-full flex-col justify-between">
              {/* TOP SECTION: Payroll */}
              <div>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h2 className="break-words text-[10px] font-bold uppercase tracking-[0.13em] text-ink-secondary">
                      Workforce &amp; pay
                    </h2>
                    <p className="mt-0.5 text-[10px] font-semibold uppercase tracking-wider text-brand">
                      Payroll vouchers
                    </p>
                  </div>
                  <Link
                    href="/payroll"
                    className="group/link inline-flex shrink-0 items-center gap-1 rounded-full border border-[#e3ddd2] bg-[#faf8f3] px-2.5 py-0.5 text-[11px] font-semibold text-brand transition-colors hover:bg-[#f2ede2]"
                  >
                    Open payroll <ArrowGlyph className="h-3 w-3" />
                  </Link>
                </div>

                <div className="mt-2.5 flex items-baseline justify-between gap-2">
                  <p className="break-words text-2xl font-semibold tracking-tight text-navy sm:text-[28px]">
                    <AnimatedPeso amount={metrics.payroll.approvedUnpaid} />
                  </p>
                  <span className="shrink-0 text-[11px] font-medium text-ink-secondary">
                    <AnimatedInteger value={metrics.payroll.approvedUnpaidCount} /> approved to pay
                  </span>
                </div>

                <div className="mt-1.5 flex items-center justify-between text-xs text-ink-secondary">
                  <span>
                    <AnimatedInteger value={metrics.payroll.needsReviewCount} /> need review
                  </span>
                  <span className="font-semibold text-navy">
                    <AnimatedPeso amount={metrics.payroll.needsReview} /> net pay
                  </span>
                </div>
              </div>

              {/* THE ARCHITECTURAL HORIZONTAL CUT */}
              <div className="relative -mx-4 my-3 flex items-center sm:-mx-5" aria-hidden="true">
                <span className="-ml-1.5 h-3 w-3 shrink-0 rounded-full border border-[#dfd8c9] bg-[#F7F9FC]" />
                <div className="flex-1 border-t border-dashed border-[#d5cdbd]" />
                <span className="mx-2 rounded-full border border-[#e5dfd2] bg-[#faf8f3] px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.14em] text-ink-muted">
                  Bale &amp; advances
                </span>
                <div className="flex-1 border-t border-dashed border-[#d5cdbd]" />
                <span className="-mr-1.5 h-3 w-3 shrink-0 rounded-full border border-[#dfd8c9] bg-[#F7F9FC]" />
              </div>

              {/* BOTTOM SECTION: Bale Requests & Issued Advances */}
              <div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-xl border border-[#e8e1d4] bg-[#faf8f3]/95 px-2.5 py-2">
                    <p className="text-[10px] font-bold uppercase tracking-wide text-ink-muted">
                      Bale requests
                    </p>
                    <p className="mt-0.5 text-xs font-semibold text-navy">
                      <AnimatedInteger
                        value={pendingAdvanceRequestCount + approvedAdvanceRequestCount}
                        suffix=" open"
                      />
                    </p>
                    <p className="mt-0.5 text-[10px] leading-snug text-ink-secondary">
                      <AnimatedInteger value={pendingAdvanceRequestCount} /> approval ·{' '}
                      <AnimatedInteger value={approvedAdvanceRequestCount} /> payout
                    </p>
                  </div>

                  <div className="rounded-xl border border-[#e8e1d4] bg-[#faf8f3]/95 px-2.5 py-2">
                    <p className="text-[10px] font-bold uppercase tracking-wide text-ink-muted">
                      Issued advances
                    </p>
                    <p className="mt-0.5 truncate text-xs font-semibold text-navy">
                      <AnimatedPeso amount={metrics.advances.outstanding} />
                    </p>
                    <p className="mt-0.5 text-[10px] leading-snug text-ink-secondary">
                      <AnimatedInteger value={metrics.advances.count} /> active balance
                      {metrics.advances.count === 1 ? '' : 's'}
                    </p>
                  </div>
                </div>

                <div className="mt-2.5 flex items-center justify-between text-xs">
                  <span className="text-[11px] text-ink-muted">
                    Issued advances outstanding: {formatPHP(metrics.advances.outstanding)}
                  </span>
                  <Link
                    href="/advances?tab=requests"
                    className="group/link inline-flex min-h-7 shrink-0 items-center gap-1 font-semibold text-brand hover:underline"
                  >
                    Review requests <ArrowGlyph />
                  </Link>
                </div>
              </div>
            </div>
          </Card>

          {/* CARD 3: Project Costs Recorded (With Daily Budget Burn % + Smart Fallback) */}
          <Card
            style={{ '--rise-delay': '165ms' } as React.CSSProperties}
            className="group animate-card-rise relative flex h-full min-w-0 flex-col justify-between overflow-hidden border-[#e3ddd2] p-4 shadow-sm sm:p-5"
          >
            <div
              aria-hidden="true"
              className="absolute inset-x-0 top-0 h-[3px] bg-gradient-to-r from-brand/75 via-[#b5a68e]/55 to-transparent"
            />
            <ProjectCostWatermark />

            <div key={`costs-${scopeKey}`} className="animate-scope-refresh relative z-10 flex h-full flex-col justify-between">
              <div>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h2 className="break-words text-[10px] font-bold uppercase tracking-[0.13em] text-ink-secondary">
                      Project costs recorded
                    </h2>
                    <p className="mt-0.5 truncate text-[11px] text-ink-muted">
                      {activeProject
                        ? `Logged expenses for ${activeProject.name}`
                        : `Logged expenses across ${currentProjectCount} current projects`}
                    </p>
                  </div>
                  {renderCostBurnBadge(metrics.costBurn)}
                </div>

                <p className="mt-3 break-words text-2xl font-semibold tracking-tight text-navy sm:text-[28px]">
                  <AnimatedPeso amount={metrics.projectRecordedExpensesTotal} />
                </p>

                {/* Overall Budget Utilization Progress Bar */}
                <div className="mt-3">
                  <div className="flex items-center justify-between gap-2 text-[11px]">
                    <span
                      className={`font-semibold ${
                        metrics.costBurn.isOverEstimate ? 'text-status-danger' : 'text-navy'
                      }`}
                    >
                      {overallSpendPercent !== null ? (
                        <>
                          <AnimatedInteger value={overallSpendPercent} suffix="% of budget used" />
                        </>
                      ) : (
                        'No budget estimate set'
                      )}
                    </span>
                    <span className="truncate text-[10px] font-medium text-ink-secondary">
                      Est: <AnimatedPeso amount={metrics.projectBudgetEstimateTotal} />
                      {projectsWithoutEstimateCount > 0 && ` (${projectsWithoutEstimateCount} unset)`}
                    </span>
                  </div>

                  <div
                    className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-[#ece7dc]"
                    role="progressbar"
                    aria-label="Recorded project costs versus budget estimate"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={overallSpendBarWidth}
                  >
                    <div
                      className={`h-full rounded-full transition-all duration-500 ease-out ${
                        metrics.costBurn.isOverEstimate ? 'bg-status-danger' : 'bg-brand'
                      }`}
                      style={{ width: `${overallSpendBarWidth}%` }}
                    />
                  </div>
                </div>

                {/* Daily / Smart Fallback Usage Velocity Callout */}
                <div className="mt-3 rounded-xl border border-[#e8e1d4] bg-[#faf8f3]/95 px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-ink-muted">
                      {metrics.costBurn.activePeriod === 'today'
                        ? 'Daily budget burn (today)'
                        : metrics.costBurn.activePeriod === 'last_7_days'
                          ? '7-day fund usage (₱0 today)'
                          : metrics.costBurn.activePeriod === 'latest_day'
                            ? `Latest burn (${formatDatePH(metrics.costBurn.referenceDate)})`
                            : 'Daily fund usage'}
                    </span>
                    <span className="text-xs font-semibold text-navy">
                      +<AnimatedPeso amount={metrics.costBurn.activeAmount} />
                    </span>
                  </div>
                  <p className="mt-0.5 text-[11px] leading-relaxed text-ink-secondary">
                    {metrics.costBurn.activePeriod === 'today' ? (
                      <>
                        {metrics.costBurn.activeBudgetPercent !== null
                          ? `${metrics.costBurn.activeBudgetPercent}% of budget used today`
                          : `${metrics.costBurn.activeSpendSharePercent ?? 0}% of logged spend added today`}{' '}
                        across {metrics.costBurn.activeCount} entr
                        {metrics.costBurn.activeCount === 1 ? 'y' : 'ies'}
                      </>
                    ) : metrics.costBurn.activePeriod === 'last_7_days' ? (
                      <>
                        {metrics.costBurn.activeBudgetPercent !== null
                          ? `${metrics.costBurn.activeBudgetPercent}% of budget used in the last 7 days`
                          : `${metrics.costBurn.activeSpendSharePercent ?? 0}% of spend logged in 7 days`}{' '}
                        ({metrics.costBurn.activeCount} entr
                        {metrics.costBurn.activeCount === 1 ? 'y' : 'ies'})
                      </>
                    ) : metrics.costBurn.activePeriod === 'latest_day' ? (
                      <>
                        {metrics.costBurn.activeBudgetPercent !== null
                          ? `${metrics.costBurn.activeBudgetPercent}% of budget used on latest active day`
                          : `${metrics.costBurn.activeSpendSharePercent ?? 0}% of total logged on latest day`}
                      </>
                    ) : (
                      '0% of budget used today · No expense entries recorded yet'
                    )}
                  </p>
                </div>
              </div>

              <div className="mt-3 flex items-center justify-between border-t border-[#eee9df] pt-2.5 text-xs">
                <Link
                  href={activeProject ? `/projects/${activeProject.id}` : '/projects'}
                  className="group/link inline-flex min-h-8 items-center gap-1.5 font-semibold text-brand hover:underline"
                >
                  {activeProject ? 'Open project details' : 'View project breakdown'} <ArrowGlyph />
                </Link>
                <span className="text-[10px] text-ink-muted">Expenses only</span>
              </div>
            </div>
          </Card>

          {/* CARD 4: Interactive Project Scope Filter (Scrollable, Replaces Tools Card) */}
          <Card
            style={{ '--rise-delay': '220ms' } as React.CSSProperties}
            className="group animate-card-rise relative flex h-full min-w-0 flex-col justify-between overflow-hidden border-[#e3ddd2] p-4 shadow-sm sm:p-5"
          >
            <div
              aria-hidden="true"
              className="absolute inset-x-0 top-0 h-[3px] bg-gradient-to-r from-brand/75 via-[#b5a68e]/55 to-transparent"
            />
            <ProjectScopeWatermark />

            <div className="relative z-10 flex h-full flex-col justify-between">
              <div>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h2 className="break-words text-[10px] font-bold uppercase tracking-[0.13em] text-ink-secondary">
                      Project scope filter
                    </h2>
                    <p className="mt-0.5 text-[11px] text-ink-muted">
                      Press a project to filter dashboard
                    </p>
                  </div>
                  {activeProject ? (
                    <button
                      type="button"
                      onClick={() => setSelectedProjectId(null)}
                      className="shrink-0 rounded-full border border-brand/25 bg-brand/10 px-2.5 py-0.5 text-[10px] font-bold text-brand transition-colors hover:bg-brand/20"
                    >
                      Reset ×
                    </button>
                  ) : (
                    <Badge size="sm" variant="outline">
                      {currentProjectCount} current
                    </Badge>
                  )}
                </div>

                {/* Current Active Scope Summary */}
                <div className="mt-2.5 rounded-xl border border-[#e6dfd2] bg-[#faf8f3] px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-sm font-semibold text-navy">
                      {activeProject ? activeProject.name : 'All current projects'}
                    </p>
                    {activeProject && (
                      <Badge size="sm" variant={getProjectStatusVariant(activeProject.status)}>
                        {activeProject.status.replace('_', ' ')}
                      </Badge>
                    )}
                  </div>
                  <p className="mt-0.5 truncate text-[11px] text-ink-secondary">
                    {activeProject
                      ? `${activeProject.location || 'Site scope'} · ${
                          activeProject.spendPercent !== null
                            ? `${activeProject.spendPercent}% budget used`
                            : 'No estimate set'
                        }`
                      : `Combined view across ${currentProjectCount} active & planning sites`}
                  </p>
                </div>

                {/* Constrained Scrollable Project List */}
                <div
                  role="group"
                  aria-label="Filter dashboard by project"
                  className="mt-2.5 max-h-[144px] space-y-1 overflow-y-auto pr-1"
                >
                  <button
                    type="button"
                    aria-pressed={selectedProjectId === null}
                    onClick={() => setSelectedProjectId(null)}
                    className={`flex min-h-9 w-full items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5 text-left text-xs transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 ${
                      selectedProjectId === null
                        ? 'border-navy bg-navy text-white shadow-sm'
                        : 'border-[#e8e1d4] bg-white/90 text-navy hover:border-brand/40 hover:bg-[#faf8f3]'
                    }`}
                  >
                    <span className="flex min-w-0 items-center gap-2 font-semibold">
                      <span
                        className={`h-2 w-2 shrink-0 rounded-full ${
                          selectedProjectId === null ? 'bg-white' : 'bg-brand'
                        }`}
                        aria-hidden="true"
                      />
                      <span className="truncate">All current projects</span>
                    </span>
                    <span
                      className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold tabular-nums ${
                        selectedProjectId === null
                          ? 'bg-white/15 text-white'
                          : 'bg-[#f3EFE6] text-ink-secondary'
                      }`}
                    >
                      {currentProjectCount}
                    </span>
                  </button>

                  {metrics.projects.map((project) => {
                    const isSelected = selectedProjectId === project.id;
                    return (
                      <button
                        key={project.id}
                        type="button"
                        aria-pressed={isSelected}
                        onClick={() => handleSelectProject(project.id)}
                        className={`flex min-h-9 w-full items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5 text-left text-xs transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 ${
                          isSelected
                            ? 'border-navy bg-navy text-white shadow-sm'
                            : 'border-[#e8e1d4] bg-white/90 text-navy hover:border-brand/40 hover:bg-[#faf8f3]'
                        }`}
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <span
                            className={`h-2 w-2 shrink-0 rounded-full ${
                              isSelected ? 'bg-white' : getProjectStatusDotColor(project.status)
                            }`}
                            aria-hidden="true"
                          />
                          <span className="truncate font-medium">{project.name}</span>
                        </span>
                        <span
                          className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold tabular-nums ${
                            isSelected
                              ? 'bg-white/15 text-white'
                              : project.isOverEstimate
                                ? 'bg-status-danger-bg text-status-danger'
                                : 'bg-[#f3EFE6] text-ink-secondary'
                          }`}
                        >
                          {project.spendPercent !== null ? `${project.spendPercent}%` : 'No est.'}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="mt-2.5 flex items-center justify-between border-t border-[#eee9df] pt-2 text-xs">
                <span className="text-[10px] text-ink-muted">
                  {activeProject ? 'Filtered to 1 project' : 'Scroll to pick a site'}
                </span>
                <Link
                  href="/projects"
                  className="group/link inline-flex min-h-7 items-center gap-1 font-semibold text-brand hover:underline"
                >
                  Manage projects <ArrowGlyph />
                </Link>
              </div>
            </div>
          </Card>
        </section>

        {/* Bottom Panels: Needs Attention (with Tools Needing Attention) + Project Register */}
        <div
          style={{ '--rise-delay': '275ms' } as React.CSSProperties}
          className="dashboard-detail-grid animate-card-rise grid grid-cols-1 gap-4"
        >
          {/* FOLLOW-UP BOARD: Needs Attention (Includes Tools Needing Attention) */}
          <section className="relative min-w-0 overflow-hidden rounded-2xl border border-[#e3ddd2] bg-white shadow-sm">
            <AttentionBoardWatermark />

            <div className="relative z-10 flex items-center justify-between gap-3 border-b border-[#e9e3d8] bg-[#fbfaf7] px-4 py-4 sm:px-5">
              <div className="flex min-w-0 items-center gap-3">
                <span
                  aria-hidden="true"
                  className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border text-xs font-bold ${
                    attentionItemCount > 0
                      ? 'border-status-warning/25 bg-status-warning-bg text-status-warning'
                      : 'border-status-success/25 bg-status-success-bg text-status-success'
                  }`}
                >
                  {attentionItemCount > 0 ? '!' : '✓'}
                </span>
                <div className="min-w-0">
                  <p className="text-[9px] font-bold uppercase tracking-[0.16em] text-ink-muted">
                    Follow-up board {activeProject ? `· ${activeProject.name}` : ''}
                  </p>
                  <h2 className="mt-0.5 text-base font-semibold text-navy">Needs attention</h2>
                  <p className="mt-1 text-xs leading-relaxed text-ink-secondary">
                    {attentionItemCount > 0
                      ? `${attentionItemCount} ${attentionItemCount === 1 ? 'area has' : 'areas have'} an item to review`
                      : 'No open follow-ups in the current snapshot'}
                  </p>
                </div>
              </div>
              <Badge size="sm" variant={attentionItemCount > 0 ? 'warning' : 'success'}>
                {attentionItemCount} {attentionItemCount === 1 ? 'area' : 'areas'}
              </Badge>
            </div>

            <div key={`attention-${scopeKey}`} className="animate-scope-refresh relative z-10 divide-y divide-[#eee9df] px-4 sm:px-5">
              {metrics.receivables.overdueInvoiceCount > 0 && (
                <div className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex min-w-0 items-start gap-2.5">
                    <span
                      aria-hidden="true"
                      className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-status-danger"
                    />
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-navy">
                        {metrics.receivables.overdueInvoiceCount} overdue invoice
                        {metrics.receivables.overdueInvoiceCount === 1 ? '' : 's'}
                      </p>
                      <p className="text-xs text-ink-secondary">
                        {formatPHP(metrics.receivables.overdue)} outstanding
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2 pl-4 sm:pl-0">
                    <Link href="/invoices" prefetch={false}>
                      <Button type="button" variant="secondary" size="sm" className="min-h-10">
                        Review
                      </Button>
                    </Link>
                    {oldestOverdueInvoice && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="min-h-10"
                        onClick={() => handleOpenSMSModal(oldestOverdueInvoice)}
                      >
                        Send reminder
                      </Button>
                    )}
                  </div>
                </div>
              )}

              {metrics.payroll.needsReviewCount > 0 && (
                <Link
                  href="/payroll"
                  className="group/link flex min-h-14 items-center justify-between gap-3 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/25"
                >
                  <div className="flex min-w-0 items-start gap-2.5">
                    <span
                      aria-hidden="true"
                      className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-status-warning"
                    />
                    <div className="min-w-0">
                      <p className="break-words text-sm font-semibold text-navy">
                        {metrics.payroll.needsReviewCount} payroll voucher
                        {metrics.payroll.needsReviewCount === 1 ? '' : 's'} need review
                      </p>
                      <p className="text-xs text-ink-secondary">
                        {formatPHP(metrics.payroll.needsReview)} net pay
                      </p>
                    </div>
                  </div>
                  <ArrowGlyph className="h-4 w-4 text-ink-muted" />
                </Link>
              )}

              {pendingAdvanceRequestCount > 0 && (
                <Link
                  href="/advances?tab=requests"
                  className="group/link flex min-h-14 items-center justify-between gap-3 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/25"
                >
                  <div className="flex min-w-0 items-start gap-2.5">
                    <span
                      aria-hidden="true"
                      className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-status-warning"
                    />
                    <div className="min-w-0">
                      <p className="break-words text-sm font-semibold text-navy">
                        {pendingAdvanceRequestCount} Bale request
                        {pendingAdvanceRequestCount === 1 ? '' : 's'} await approval
                      </p>
                      <p className="text-xs text-ink-secondary">
                        Submitted by Supervisors for Founder review
                      </p>
                    </div>
                  </div>
                  <ArrowGlyph className="h-4 w-4 text-ink-muted" />
                </Link>
              )}

              {approvedAdvanceRequestCount > 0 && (
                <Link
                  href="/advances?tab=requests"
                  className="group/link flex min-h-14 items-center justify-between gap-3 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/25"
                >
                  <div className="flex min-w-0 items-start gap-2.5">
                    <span
                      aria-hidden="true"
                      className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-status-info"
                    />
                    <div className="min-w-0">
                      <p className="break-words text-sm font-semibold text-navy">
                        {approvedAdvanceRequestCount} approved Bale request
                        {approvedAdvanceRequestCount === 1 ? '' : 's'} await payment
                      </p>
                      <p className="text-xs text-ink-secondary">
                        Not yet counted as issued advances
                      </p>
                    </div>
                  </div>
                  <ArrowGlyph className="h-4 w-4 text-ink-muted" />
                </Link>
              )}

              {metrics.projectsOverEstimate.length > 0 && (
                <Link
                  href="/projects"
                  className="group/link flex min-h-14 items-center justify-between gap-3 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/25"
                >
                  <div className="flex min-w-0 items-start gap-2.5">
                    <span
                      aria-hidden="true"
                      className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-status-danger"
                    />
                    <div className="min-w-0">
                      <p className="break-words text-sm font-semibold text-navy">
                        {metrics.projectsOverEstimate.length} project
                        {metrics.projectsOverEstimate.length === 1 ? '' : 's'} over estimate
                      </p>
                      <p className="break-words text-xs text-ink-secondary">
                        {metrics.projectsOverEstimate
                          .slice(0, 2)
                          .map((project) => project.name)
                          .join(', ')}
                        {metrics.projectsOverEstimate.length > 2 ? ', …' : ''}
                      </p>
                    </div>
                  </div>
                  <ArrowGlyph className="h-4 w-4 text-ink-muted" />
                </Link>
              )}

              {/* Tools needing attention integrated into Needs Attention board */}
              {metrics.tools.attentionUnits > 0 && (
                <Link
                  href="/tools"
                  className="group/link flex min-h-14 items-center justify-between gap-3 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/25"
                >
                  <div className="flex min-w-0 items-start gap-2.5">
                    <span
                      aria-hidden="true"
                      className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-status-warning"
                    />
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <p className="break-words text-sm font-semibold text-navy">
                          {metrics.tools.attentionUnits} tool unit
                          {metrics.tools.attentionUnits === 1 ? '' : 's'} need service
                        </p>
                        <Badge size="sm" variant="neutral">
                          Tools needing attention
                        </Badge>
                      </div>
                      <p className="mt-0.5 text-xs text-ink-secondary">
                        {metrics.tools.needsRepairUnits} need repair · {metrics.tools.damagedUnits}{' '}
                        damaged · {metrics.tools.totalUnits} total in scope
                      </p>
                      {!activeProject && (
                        <p className="mt-0.5 text-[11px] text-ink-muted">
                          Central depot: {metrics.tools.depotUnits} units ·{' '}
                          {metrics.tools.depotAttentionUnits} need service
                        </p>
                      )}
                    </div>
                  </div>
                  <ArrowGlyph className="h-4 w-4 text-ink-muted" />
                </Link>
              )}

              {attentionItemCount === 0 && (
                <div className="py-4">
                  <div className="flex items-start gap-3 rounded-xl border border-[#e8e1d4] bg-[#faf8f3] p-3.5">
                    <span
                      aria-hidden="true"
                      className="mt-1 h-2 w-2 shrink-0 rounded-full bg-status-success"
                    />
                    <div>
                      <p className="text-sm font-semibold text-navy">All clear for now</p>
                      <p className="mt-1 text-xs leading-relaxed text-ink-secondary">
                        No overdue invoices, payroll reviews, open Bale requests, over-estimate
                        projects, or tool-service items.
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* Quiet Tools & Inventory Footer so inventory remains accessible even when 0 need repair */}
              <div className="flex items-center justify-between gap-2 py-3 text-xs text-ink-secondary">
                <span>
                  Tools &amp; inventory: <strong className="text-navy">{metrics.tools.totalUnits}</strong>{' '}
                  units ({metrics.tools.depotUnits} in central depot)
                </span>
                <Link
                  href="/tools"
                  className="group/link inline-flex shrink-0 items-center gap-1 font-semibold text-brand hover:underline"
                >
                  Review inventory <ArrowGlyph />
                </Link>
              </div>
            </div>
          </section>

          {/* PROJECT REGISTER */}
          <section className="dashboard-register relative min-w-0 overflow-hidden rounded-2xl border border-[#e3ddd2] bg-white shadow-sm">
            <ProjectRegisterWatermark />

            <div className="relative z-10 flex flex-col gap-3 border-b border-[#e9e3d8] bg-[#fbfaf7] px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
              <div className="min-w-0">
                <p className="text-[9px] font-bold uppercase tracking-[0.16em] text-ink-muted">
                  Project register
                </p>
                <h2 className="mt-0.5 text-base font-semibold text-navy">
                  Estimates &amp; recorded expenses
                </h2>
                <p className="mt-1 text-xs leading-relaxed text-ink-secondary">
                  Logged expense entries only. Open a project name for details, or use Focus scope to filter this dashboard.
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2 sm:ml-3">
                {activeProject ? (
                  <button
                    type="button"
                    onClick={() => setSelectedProjectId(null)}
                    className="inline-flex min-h-8 items-center gap-1.5 rounded-lg border border-brand/25 bg-brand/10 px-2.5 py-1 text-xs font-semibold text-brand hover:bg-brand/15"
                  >
                    <span>Showing: {activeProject.name}</span>
                    <span aria-hidden="true">×</span>
                  </button>
                ) : (
                  <Badge size="sm" variant="outline">
                    {currentProjectCount} current
                  </Badge>
                )}
                <Link
                  href="/projects"
                  prefetch={false}
                  className="group/link inline-flex min-h-10 items-center gap-1 rounded-lg border border-[#e3ddd2] bg-white px-3 text-xs font-semibold text-brand transition-colors hover:bg-[#f7f5ef]"
                >
                  All projects <ArrowGlyph />
                </Link>
              </div>
            </div>

            {scopedProjects.length === 0 ? (
              <div className="relative z-10 px-4 py-8 text-center sm:px-5">
                <p className="mt-2 text-sm font-semibold text-navy">No current projects</p>
                <p className="mt-1 text-xs text-ink-secondary">
                  Add a project to compare its estimate with logged costs.
                </p>
              </div>
            ) : (
              <div key={`register-${scopeKey}`} className="animate-scope-refresh relative z-10">
                <div className="dashboard-register-table hidden overflow-x-auto">
                  <table className="w-full min-w-[820px] table-fixed text-left text-xs">
                    <colgroup>
                      <col className="w-[24%]" />
                      <col className="w-[15%]" />
                      <col className="w-[19%]" />
                      <col className="w-[17%]" />
                      <col className="w-[25%]" />
                    </colgroup>
                    <thead className="bg-[#f6f4ed] text-[10px] font-bold uppercase tracking-[0.1em] text-ink-muted">
                      <tr>
                        <th scope="col" className="px-4 py-3 font-semibold">Project</th>
                        <th scope="col" className="px-3 py-3 font-semibold">Estimate</th>
                        <th scope="col" className="px-3 py-3 font-semibold">Expenses logged</th>
                        <th scope="col" className="px-3 py-3 font-semibold">Client balance</th>
                        <th scope="col" className="px-3 py-3 font-semibold">Tool condition by units</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-surface-border/60">
                      {scopedProjects.map((project) => {
                        const isSelected = selectedProjectId === project.id;
                        return (
                          <tr
                            key={project.id}
                            className={`align-top transition-colors ${
                              isSelected ? 'bg-[#f5f8fc]' : 'hover:bg-[#fbfaf7]'
                            }`}
                          >
                            <td className="px-4 py-3.5">
                              <div className="flex items-start justify-between gap-2">
                                <Link
                                  href={`/projects/${project.id}`}
                                  className="break-words font-semibold text-navy hover:text-brand hover:underline"
                                >
                                  {project.name}
                                </Link>
                              </div>
                              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                                <Badge size="sm" variant={getProjectStatusVariant(project.status)}>
                                  {project.status.replace('_', ' ')}
                                </Badge>
                                <button
                                  type="button"
                                  onClick={() => handleSelectProject(project.id)}
                                  className="text-[10px] font-semibold text-brand hover:underline"
                                >
                                  {isSelected ? 'Clear filter' : 'Focus scope'}
                                </button>
                              </div>
                            </td>
                            <td className="px-3 py-3.5 font-semibold tabular-nums text-navy">
                              {project.budgetEstimate > 0 ? formatPHP(project.budgetEstimate) : 'Not set'}
                            </td>
                            <td className="px-3 py-3.5">
                              {renderProjectSpend(project, formatPHP)}
                            </td>
                            <td className="px-3 py-3.5">
                              <div className="font-semibold tabular-nums text-navy">
                                {formatPHP(project.outstandingInvoices)}
                              </div>
                              <div className="mt-0.5 text-[11px] text-ink-secondary">
                                {project.openInvoiceCount} open invoice
                                {project.openInvoiceCount === 1 ? '' : 's'}
                              </div>
                            </td>
                            <td className="px-3 py-3.5">
                              <div className="mb-1 text-[11px] text-ink-secondary">
                                {project.toolUnits} total · {project.toolUnitsNeedingAttention} need service
                              </div>
                              {renderToolConditionSummary(project)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                <div className="dashboard-register-cards grid grid-cols-1 gap-3 p-3 sm:p-4">
                  {scopedProjects.map((project) => {
                    const isSelected = selectedProjectId === project.id;
                    return (
                      <article
                        key={project.id}
                        className={`min-w-0 rounded-xl border p-3.5 transition-colors sm:p-4 ${
                          isSelected
                            ? 'border-brand/40 bg-[#f6f9fd]'
                            : 'border-[#e3ddd2] bg-white hover:bg-[#fffefa]'
                        }`}
                      >
                        <div className="flex min-w-0 items-start justify-between gap-2">
                          <Link
                            href={`/projects/${project.id}`}
                            className="min-w-0 break-words text-sm font-semibold text-navy hover:text-brand hover:underline"
                          >
                            {project.name}
                          </Link>
                          <div className="flex shrink-0 items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => handleSelectProject(project.id)}
                              className="rounded-md border border-[#e3ddd2] bg-[#faf8f3] px-2 py-0.5 text-[10px] font-semibold text-brand hover:border-brand/35"
                            >
                              {isSelected ? 'All sites' : 'Filter'}
                            </button>
                            <Badge
                              size="sm"
                              variant={getProjectStatusVariant(project.status)}
                              className="shrink-0"
                            >
                              {project.status.replace('_', ' ')}
                            </Badge>
                          </div>
                        </div>
                        <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-3">
                          <div className="min-w-0">
                            <p className="text-[11px] text-ink-secondary">Budget estimate</p>
                            <p className="mt-0.5 break-words text-sm font-semibold tabular-nums text-navy">
                              {project.budgetEstimate > 0 ? formatPHP(project.budgetEstimate) : 'Not set'}
                            </p>
                          </div>
                          <div className="min-w-0">
                            <p className="text-[11px] text-ink-secondary">Recorded expenses</p>
                            {renderProjectSpend(project, formatPHP)}
                          </div>
                          <div className="min-w-0">
                            <p className="text-[11px] text-ink-secondary">Client balance due</p>
                            <p className="mt-0.5 break-words text-sm font-semibold tabular-nums text-navy">
                              {formatPHP(project.outstandingInvoices)}
                            </p>
                            <p className="text-[11px] text-ink-secondary">
                              {project.openInvoiceCount} open invoice
                              {project.openInvoiceCount === 1 ? '' : 's'}
                            </p>
                          </div>
                          <div className="min-w-0">
                            <p className="text-[11px] text-ink-secondary">Tools</p>
                            <p className="mt-0.5 text-sm font-semibold tabular-nums text-navy">
                              {project.toolUnits} units · {project.toolUnitsNeedingAttention} need service
                            </p>
                          </div>
                        </div>
                        <div className="mt-3 border-t border-surface-border/60 pt-3">
                          <p className="mb-1.5 text-[11px] font-semibold text-ink-secondary">
                            Tool condition
                          </p>
                          {renderToolConditionSummary(project)}
                        </div>
                      </article>
                    );
                  })}
                </div>
              </div>
            )}
          </section>
        </div>

        <aside
          aria-label="How to read the dashboard figures"
          className="rounded-2xl border border-[#ded7c9] bg-[#f8f6f0] p-4 sm:p-5"
        >
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-brand" aria-hidden="true" />
            <h2 className="text-[10px] font-bold uppercase tracking-[0.15em] text-navy">
              How to read this snapshot
            </h2>
          </div>
          <ul className="mt-3 grid grid-cols-1 gap-3 text-[11px] leading-relaxed text-ink-secondary sm:grid-cols-2 2xl:grid-cols-4">
            <li className="border-l border-[#cfc4b2] pl-3">
              Receivables exclude draft and cancelled invoices.
            </li>
            <li className="border-l border-[#cfc4b2] pl-3">
              Workforce &amp; pay splits payroll vouchers above the cut from Bale requests and advances below.
            </li>
            <li className="border-l border-[#cfc4b2] pl-3">
              Project cost velocity tracks today’s budget burn percentage and falls back to 7-day or latest activity.
            </li>
            <li className="border-l border-[#cfc4b2] pl-3">
              Selecting a site in the Project Scope Filter scopes balances, workforce pay, costs, and follow-ups.
            </li>
          </ul>
        </aside>
      </div>

      <Modal
        isOpen={smsModalOpen}
        onClose={() => setSmsModalOpen(false)}
        dismissOnBackdrop={!smsSending}
        dismissOnEscape={!smsSending}
        showCloseButton={!smsSending}
        title="Send Payment Reminder (PhilSMS)"
        description="Review the reminder before sending it for this overdue invoice."
      >
        {selectedInvoiceForSMS && (
          <div className="space-y-4 text-xs">
            {smsSuccessMessage ? (
              <div className="rounded-xl border border-status-success/20 bg-status-success-bg p-4 text-center font-medium text-status-success">
                {smsSuccessMessage}
                <div className="mt-3"><Button type="button" variant="secondary" size="sm" onClick={() => setSmsModalOpen(false)}>Done</Button></div>
              </div>
            ) : (
              <>
                <div className="space-y-2 rounded-xl border border-surface-border bg-surface-inset p-3.5">
                  <div className="flex justify-between gap-3">
                    <span className="text-ink-secondary">Invoice Number:</span>
                    <span className="break-words text-right font-mono font-bold text-navy">
                      {selectedInvoiceForSMS.invoice_number}
                    </span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span className="text-ink-secondary">Outstanding Balance:</span>
                    <span className="font-bold text-status-danger">
                      {formatPHP(
                        Math.max(0, selectedInvoiceForSMS.amount - selectedInvoiceForSMS.amount_paid)
                      )}
                    </span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span className="text-ink-secondary">Original Due Date:</span>
                    <span className="font-medium text-navy">{selectedInvoiceForSMS.due_date}</span>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-ink-secondary">
                    SMS Message Preview (PhilSMS)
                  </label>
                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 font-sans text-xs leading-relaxed text-ink-primary">
                    {buildSmsPreviewMessage(selectedInvoiceForSMS)}
                  </div>
                </div>

                <p className="text-ink-secondary">If sending is unconfirmed, check the dispatch log and provider before retrying; it may have been sent.</p>
                <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
                  <Button type="button" variant="secondary" disabled={smsSending} onClick={() => setSmsModalOpen(false)}>
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    variant="primary"
                    onClick={handleSendInvoiceSMS}
                    isLoading={smsSending}
                  >
                    Send PhilSMS Now
                  </Button>
                </div>
              </>
            )}
          </div>
        )}
      </Modal>
    </AppShell>
  );
}
