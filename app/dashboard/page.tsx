'use client';

import React, { useMemo, useState } from 'react';
import Link from 'next/link';
import { AppShell } from '@/components/layout/AppShell';
import { useDataStore } from '@/lib/data/store';
import type { Invoice, ToolCondition } from '@/types';
import type { ProjectFinancialSummary } from '@/lib/dashboard/financialMetrics';
import { calculateFinancialDashboardMetrics } from '@/lib/dashboard/financialMetrics';
import {
  AlertTriangle,
  ArrowRight,
  Banknote,
  CheckCircle2,
  CreditCard,
  FolderKanban,
  HandCoins,
  Receipt,
  Send,
  Sparkles,
  Wrench,
} from 'lucide-react';
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

interface SummaryCardProps {
  title: string;
  value: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}

function SummaryCard({ title, value, icon, children }: SummaryCardProps) {
  return (
    <Card className="h-full min-w-0 p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="break-words text-xs font-semibold text-ink-secondary">{title}</h2>
          <p className="mt-2 break-words text-2xl font-semibold tracking-tight text-navy tabular-nums sm:text-3xl">
            {value}
          </p>
        </div>
        <div
          aria-hidden="true"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-surface-border bg-surface-inset text-brand"
        >
          {icon}
        </div>
      </div>
      <div className="mt-3 space-y-1.5 text-xs leading-relaxed text-ink-secondary">{children}</div>
    </Card>
  );
}

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
            className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-inset"
            role="progressbar"
            aria-label={`${project.name} recorded expenses versus estimate`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={visualPercent}
          >
            <div
              className={`h-full rounded-full ${project.isOverEstimate ? 'bg-status-danger' : 'bg-brand'}`}
              style={{ width: `${visualPercent}%` }}
            />
          </div>
        </>
      )}
    </div>
  );
}

export default function FounderDashboard() {
  const {
    invoices,
    expenses,
    advances,
    advanceRequests,
    payroll,
    tools,
    clients,
    projects,
    sendSMS,
  } = useDataStore();

  const now = new Date();
  const asOfDate = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
  const metrics = useMemo(
    () =>
      calculateFinancialDashboardMetrics(
        { invoices, expenses, advances, payroll, tools, projects },
        asOfDate
      ),
    [invoices, expenses, advances, payroll, tools, projects, asOfDate]
  );

  const [smsModalOpen, setSmsModalOpen] = useState(false);
  const [selectedInvoiceForSMS, setSelectedInvoiceForSMS] = useState<Invoice | null>(null);
  const [smsSending, setSmsSending] = useState(false);
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
    if (!selectedInvoiceForSMS) return;
    setSmsSending(true);

    const sent = await sendSMS({
      invoiceId: selectedInvoiceForSMS.id,
      message: buildSmsPreviewMessage(selectedInvoiceForSMS),
    });
    setSmsSending(false);
    if (!sent) return;
    setSmsSuccessMessage('Reminder handed to the PhilSMS gateway — see the SMS log for its status.');
    setTimeout(() => {
      setSmsModalOpen(false);
      setSmsSuccessMessage(null);
    }, 1800);
  };

  const oldestOverdueInvoice = metrics.receivables.overdueInvoices[0];
  const currentProjectCount = metrics.projects.length;
  const projectsWithoutEstimateCount = metrics.projects.filter(
    (project) => project.budgetEstimate <= 0
  ).length;
  const pendingAdvanceRequestCount = advanceRequests.filter(
    (request) => request.status === 'pending_approval'
  ).length;
  const approvedAdvanceRequestCount = advanceRequests.filter(
    (request) => request.status === 'approved_pending_payment'
  ).length;
  const attentionItemCount =
    Number(metrics.receivables.overdueInvoiceCount > 0) +
    Number(metrics.payroll.needsReviewCount > 0) +
    Number(pendingAdvanceRequestCount > 0) +
    Number(approvedAdvanceRequestCount > 0) +
    Number(metrics.projectsOverEstimate.length > 0) +
    Number(metrics.tools.attentionUnits > 0);

  return (
    <AppShell requireFounder={true}>
      <div className="w-full space-y-5 lg:space-y-6">
        <header className="blueprint-accent flex flex-col gap-3 border-b border-surface-border/60 pb-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight text-navy sm:text-2xl">
              Financial Overview
            </h1>
            <p className="mt-1 text-xs text-ink-secondary">
              Founder snapshot · as of {formatDatePH(metrics.asOfDate)}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Link href="/invoices" prefetch={false}>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="min-h-11"
                leftIcon={<Receipt className="h-3.5 w-3.5" />}
              >
                New Invoice
              </Button>
            </Link>
            <Link href="/expenses" prefetch={false}>
              <Button
                type="button"
                variant="primary"
                size="sm"
                className="min-h-11"
                leftIcon={<Sparkles className="h-3.5 w-3.5" />}
              >
                Record Expense
              </Button>
            </Link>
          </div>
        </header>

        <section aria-label="Financial summary" className="grid grid-cols-1 gap-3 sm:grid-cols-2 2xl:grid-cols-4">
          <SummaryCard
            title="Client balances due"
            value={formatPHP(metrics.receivables.outstanding)}
            icon={<Receipt className="h-5 w-5" />}
          >
            <p>{metrics.receivables.openInvoiceCount} open invoices across all projects</p>
            {metrics.receivables.overdueInvoiceCount > 0 ? (
              <p className="font-semibold text-status-danger">
                {metrics.receivables.overdueInvoiceCount} overdue · {formatPHP(metrics.receivables.overdue)}
              </p>
            ) : (
              <p className="inline-flex items-center gap-1.5 text-status-success">
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0" /> No overdue balances
              </p>
            )}
            <Link href="/invoices" className="inline-flex min-h-10 items-center gap-1 font-semibold text-brand hover:underline">
              Review invoices <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </SummaryCard>

          <SummaryCard
            title="Approved payroll to pay"
            value={formatPHP(metrics.payroll.approvedUnpaid)}
            icon={<Banknote className="h-5 w-5" />}
          >
            <p>{metrics.payroll.approvedUnpaidCount} approved unpaid payroll vouchers</p>
            <p>
              Needs review: {metrics.payroll.needsReviewCount} · {formatPHP(metrics.payroll.needsReview)}
            </p>
            <p className="font-medium text-navy">
              Open advances (issued balance): {formatPHP(metrics.advances.outstanding)}
            </p>
            <div className="border-t border-surface-border/60 pt-2">
              <p className="font-medium text-navy">Bale requests · not yet issued</p>
              <p>
                {pendingAdvanceRequestCount} awaiting approval · {approvedAdvanceRequestCount} approved, awaiting payment
              </p>
              <Link
                href="/advances?tab=requests"
                className="inline-flex min-h-10 items-center gap-1 font-semibold text-brand hover:underline"
              >
                Review request queue <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </div>
            <Link href="/payroll" className="inline-flex min-h-10 items-center gap-1 font-semibold text-brand hover:underline">
              Open payroll <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </SummaryCard>

          <SummaryCard
            title="Current project estimate vs spend"
            value={formatPHP(metrics.projectRecordedExpensesTotal)}
            icon={<CreditCard className="h-5 w-5" />}
          >
            <p>Recorded expenses across {currentProjectCount} current projects</p>
            <p className="break-words font-medium text-navy">
              Saved estimates: {formatPHP(metrics.projectBudgetEstimateTotal)}
              {projectsWithoutEstimateCount > 0 &&
                ` · ${projectsWithoutEstimateCount} not set`}
            </p>
            <p className="text-[11px] text-ink-muted">
                  Logged expense entries only; payroll has no project link.
            </p>
          </SummaryCard>

          <SummaryCard
            title="Tool units needing attention"
            value={String(metrics.tools.attentionUnits)}
            icon={<Wrench className="h-5 w-5" />}
          >
            <p>
              Needs repair: {metrics.tools.needsRepairUnits} · Damaged: {metrics.tools.damagedUnits}
            </p>
            <p>{metrics.tools.totalUnits} total units in the inventory</p>
            <p>
              Central depot: {metrics.tools.depotUnits} units · {metrics.tools.depotAttentionUnits} need service
            </p>
            <Link href="/tools" className="inline-flex min-h-10 items-center gap-1 font-semibold text-brand hover:underline">
              Review inventory <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </SummaryCard>
        </section>

        <div className="grid grid-cols-1 gap-4 2xl:grid-cols-[minmax(18rem,0.8fr)_minmax(0,2fr)]">
          <section className="min-w-0 overflow-hidden rounded-2xl border border-surface-border bg-white">
            <div className="flex items-start justify-between gap-3 border-b border-surface-border/70 px-4 py-4 sm:px-5">
              <div className="min-w-0">
                <h2 className="text-base font-semibold text-navy">Needs attention</h2>
                <p className="mt-1 text-xs text-ink-secondary">
                  {attentionItemCount > 0
                    ? `${attentionItemCount} areas need a follow-up`
                    : 'No urgent items in the current ledger snapshot'}
                </p>
              </div>
              {attentionItemCount === 0 && (
                <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-status-success" aria-hidden="true" />
              )}
            </div>

            <div className="divide-y divide-surface-border/60 px-4 sm:px-5">
              {metrics.receivables.overdueInvoiceCount > 0 && (
                <div className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex min-w-0 items-start gap-2.5">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-status-danger" aria-hidden="true" />
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-navy">
                        {metrics.receivables.overdueInvoiceCount} overdue invoice{metrics.receivables.overdueInvoiceCount === 1 ? '' : 's'}
                      </p>
                      <p className="text-xs text-ink-secondary">
                        {formatPHP(metrics.receivables.overdue)} outstanding
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2 pl-6 sm:pl-0">
                    <Link href="/invoices" prefetch={false}>
                      <Button type="button" variant="secondary" size="sm" className="min-h-11">
                        Review
                      </Button>
                    </Link>
                    {oldestOverdueInvoice && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="min-h-11"
                        onClick={() => handleOpenSMSModal(oldestOverdueInvoice)}
                        leftIcon={<Send className="h-3.5 w-3.5" />}
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
                  className="flex min-h-14 items-center justify-between gap-3 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/25"
                >
                  <div className="flex min-w-0 items-start gap-2.5">
                    <Banknote className="mt-0.5 h-4 w-4 shrink-0 text-status-warning" aria-hidden="true" />
                    <div className="min-w-0">
                      <p className="break-words text-sm font-semibold text-navy">
                        {metrics.payroll.needsReviewCount} payroll voucher{metrics.payroll.needsReviewCount === 1 ? '' : 's'} need review
                      </p>
                      <p className="text-xs text-ink-secondary">{formatPHP(metrics.payroll.needsReview)} net pay</p>
                    </div>
                  </div>
                  <ArrowRight className="h-4 w-4 shrink-0 text-ink-muted" aria-hidden="true" />
                </Link>
              )}

              {pendingAdvanceRequestCount > 0 && (
                <Link
                  href="/advances?tab=requests"
                  className="flex min-h-14 items-center justify-between gap-3 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/25"
                >
                  <div className="flex min-w-0 items-start gap-2.5">
                    <HandCoins className="mt-0.5 h-4 w-4 shrink-0 text-status-warning" aria-hidden="true" />
                    <div className="min-w-0">
                      <p className="break-words text-sm font-semibold text-navy">
                        {pendingAdvanceRequestCount} Bale request{pendingAdvanceRequestCount === 1 ? '' : 's'} await approval
                      </p>
                      <p className="text-xs text-ink-secondary">Submitted by Supervisors for Founder review</p>
                    </div>
                  </div>
                  <ArrowRight className="h-4 w-4 shrink-0 text-ink-muted" aria-hidden="true" />
                </Link>
              )}

              {approvedAdvanceRequestCount > 0 && (
                <Link
                  href="/advances?tab=requests"
                  className="flex min-h-14 items-center justify-between gap-3 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/25"
                >
                  <div className="flex min-w-0 items-start gap-2.5">
                    <HandCoins className="mt-0.5 h-4 w-4 shrink-0 text-status-info" aria-hidden="true" />
                    <div className="min-w-0">
                      <p className="break-words text-sm font-semibold text-navy">
                        {approvedAdvanceRequestCount} approved Bale request{approvedAdvanceRequestCount === 1 ? '' : 's'} await payment
                      </p>
                      <p className="text-xs text-ink-secondary">Not yet counted as issued advances</p>
                    </div>
                  </div>
                  <ArrowRight className="h-4 w-4 shrink-0 text-ink-muted" aria-hidden="true" />
                </Link>
              )}

              {metrics.projectsOverEstimate.length > 0 && (
                <Link
                  href="/projects"
                  className="flex min-h-14 items-center justify-between gap-3 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/25"
                >
                  <div className="flex min-w-0 items-start gap-2.5">
                    <FolderKanban className="mt-0.5 h-4 w-4 shrink-0 text-status-warning" aria-hidden="true" />
                    <div className="min-w-0">
                      <p className="break-words text-sm font-semibold text-navy">
                        {metrics.projectsOverEstimate.length} project{metrics.projectsOverEstimate.length === 1 ? '' : 's'} over estimate
                      </p>
                      <p className="break-words text-xs text-ink-secondary">
                        {metrics.projectsOverEstimate.slice(0, 2).map((project) => project.name).join(', ')}
                        {metrics.projectsOverEstimate.length > 2 ? ', …' : ''}
                      </p>
                    </div>
                  </div>
                  <ArrowRight className="h-4 w-4 shrink-0 text-ink-muted" aria-hidden="true" />
                </Link>
              )}

              {metrics.tools.attentionUnits > 0 && (
                <Link
                  href="/tools"
                  className="flex min-h-14 items-center justify-between gap-3 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/25"
                >
                  <div className="flex min-w-0 items-start gap-2.5">
                    <Wrench className="mt-0.5 h-4 w-4 shrink-0 text-status-warning" aria-hidden="true" />
                    <div className="min-w-0">
                      <p className="break-words text-sm font-semibold text-navy">
                        {metrics.tools.attentionUnits} tool unit{metrics.tools.attentionUnits === 1 ? '' : 's'} need service
                      </p>
                      <p className="text-xs text-ink-secondary">
                        {metrics.tools.needsRepairUnits} need repair · {metrics.tools.damagedUnits} damaged
                      </p>
                    </div>
                  </div>
                  <ArrowRight className="h-4 w-4 shrink-0 text-ink-muted" aria-hidden="true" />
                </Link>
              )}

              {attentionItemCount === 0 && (
                <p className="py-4 text-sm text-ink-secondary">
                  No overdue invoices, payroll reviews, open Bale requests, over-estimate projects, or tool service items.
                </p>
              )}
            </div>
          </section>

          <section className="min-w-0 overflow-hidden rounded-2xl border border-surface-border bg-white">
            <div className="flex flex-col gap-2 border-b border-surface-border/70 px-4 py-4 sm:flex-row sm:items-end sm:justify-between sm:px-5">
              <div className="min-w-0">
                <h2 className="text-base font-semibold text-navy">Project estimates &amp; recorded expenses</h2>
                <p className="mt-1 text-xs leading-relaxed text-ink-secondary">
                  Logged expense entries only. Payroll has no project link, so it is not included in these comparisons.
                </p>
              </div>
              <Link href="/projects" prefetch={false} className="inline-flex min-h-11 shrink-0 items-center gap-1 text-xs font-semibold text-brand hover:underline">
                All projects <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </div>

            {metrics.projects.length === 0 ? (
              <div className="px-4 py-8 text-center sm:px-5">
                <FolderKanban className="mx-auto h-7 w-7 text-ink-muted" aria-hidden="true" />
                <p className="mt-2 text-sm font-semibold text-navy">No current projects</p>
                <p className="mt-1 text-xs text-ink-secondary">Add a project to compare its estimate with logged costs.</p>
              </div>
            ) : (
              <>
                <div className="hidden overflow-x-auto xl:block">
                  <table className="w-full min-w-[900px] table-fixed text-left text-xs">
                    <colgroup>
                      <col className="w-[24%]" />
                      <col className="w-[15%]" />
                      <col className="w-[19%]" />
                      <col className="w-[17%]" />
                      <col className="w-[25%]" />
                    </colgroup>
                    <thead className="bg-surface/70 text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
                      <tr>
                        <th scope="col" className="px-4 py-3 font-semibold">Project</th>
                        <th scope="col" className="px-3 py-3 font-semibold">Estimate</th>
                        <th scope="col" className="px-3 py-3 font-semibold">Expenses logged</th>
                        <th scope="col" className="px-3 py-3 font-semibold">Client balance</th>
                        <th scope="col" className="px-3 py-3 font-semibold">Tool condition by units</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-surface-border/60">
                      {metrics.projects.map((project) => (
                        <tr key={project.id} className="align-top transition-colors hover:bg-surface/40">
                          <td className="px-4 py-3.5">
                            <Link href={`/projects/${project.id}`} className="break-words font-semibold text-navy hover:text-brand hover:underline">
                              {project.name}
                            </Link>
                            <div className="mt-1">
                              <Badge size="sm" variant={getProjectStatusVariant(project.status)}>
                                {project.status.replace('_', ' ')}
                              </Badge>
                            </div>
                          </td>
                          <td className="px-3 py-3.5 font-semibold tabular-nums text-navy">
                            {project.budgetEstimate > 0 ? formatPHP(project.budgetEstimate) : 'Not set'}
                          </td>
                          <td className="px-3 py-3.5">
                            {renderProjectSpend(project, formatPHP)}
                          </td>
                          <td className="px-3 py-3.5">
                            <div className="font-semibold tabular-nums text-navy">{formatPHP(project.outstandingInvoices)}</div>
                            <div className="mt-0.5 text-[11px] text-ink-secondary">
                              {project.openInvoiceCount} open invoice{project.openInvoiceCount === 1 ? '' : 's'}
                            </div>
                          </td>
                          <td className="px-3 py-3.5">
                            <div className="mb-1 text-[11px] text-ink-secondary">
                              {project.toolUnits} total · {project.toolUnitsNeedingAttention} need service
                            </div>
                            {renderToolConditionSummary(project)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="grid grid-cols-1 gap-3 p-3 sm:p-4 xl:hidden">
                  {metrics.projects.map((project) => (
                    <article key={project.id} className="min-w-0 rounded-xl border border-surface-border/80 bg-white p-3.5 sm:p-4">
                      <div className="flex min-w-0 items-start justify-between gap-2">
                        <Link href={`/projects/${project.id}`} className="min-w-0 break-words text-sm font-semibold text-navy hover:text-brand hover:underline">
                          {project.name}
                        </Link>
                        <Badge size="sm" variant={getProjectStatusVariant(project.status)} className="shrink-0">
                          {project.status.replace('_', ' ')}
                        </Badge>
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
                          <p className="mt-0.5 break-words text-sm font-semibold tabular-nums text-navy">{formatPHP(project.outstandingInvoices)}</p>
                          <p className="text-[11px] text-ink-secondary">
                            {project.openInvoiceCount} open invoice{project.openInvoiceCount === 1 ? '' : 's'}
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
                        <p className="mb-1.5 text-[11px] font-semibold text-ink-secondary">Tool condition</p>
                        {renderToolConditionSummary(project)}
                      </div>
                    </article>
                  ))}
                </div>
              </>
            )}
          </section>
        </div>

        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-surface-border/70 bg-white/70 px-3.5 py-3 text-[11px] leading-relaxed text-ink-secondary sm:px-4">
          <span className="font-semibold text-navy">Metric notes:</span>
          <span>Receivables exclude draft/cancelled invoices.</span>
          <span aria-hidden="true">·</span>
          <span>Issued advances are separate from net payroll.</span>
          <span aria-hidden="true">·</span>
          <span>Requests stay outside issued balances until paid.</span>
          <span aria-hidden="true">·</span>
          <span>Project costs show logged expenses, not an end-cost forecast; payroll has no project link.</span>
        </div>
      </div>

      <Modal
        isOpen={smsModalOpen}
        onClose={() => setSmsModalOpen(false)}
        title="Send Payment Reminder (PhilSMS)"
        description="Deliver an instant SMS reminder to the client for this overdue invoice."
      >
        {selectedInvoiceForSMS && (
          <div className="space-y-4 text-xs">
            {smsSuccessMessage ? (
              <div className="p-4 rounded-xl bg-status-success-bg border border-status-success/20 text-status-success text-center font-medium">
                <CheckCircle2 className="w-8 h-8 mx-auto mb-2 text-status-success" />
                {smsSuccessMessage}
              </div>
            ) : (
              <>
                <div className="p-3.5 rounded-xl bg-surface-inset border border-surface-border space-y-2">
                  <div className="flex justify-between gap-3">
                    <span className="text-ink-secondary">Invoice Number:</span>
                    <span className="break-words text-right font-bold text-navy font-mono">
                      {selectedInvoiceForSMS.invoice_number}
                    </span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span className="text-ink-secondary">Outstanding Balance:</span>
                    <span className="font-bold text-status-danger">
                      {formatPHP(Math.max(0, selectedInvoiceForSMS.amount - selectedInvoiceForSMS.amount_paid))}
                    </span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span className="text-ink-secondary">Original Due Date:</span>
                    <span className="font-medium text-navy">{selectedInvoiceForSMS.due_date}</span>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-ink-secondary">SMS Message Preview (PhilSMS)</label>
                  <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 text-ink-primary font-sans leading-relaxed text-xs">
                    {buildSmsPreviewMessage(selectedInvoiceForSMS)}
                  </div>
                </div>

                <div className="pt-2 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                  <Button type="button" variant="secondary" onClick={() => setSmsModalOpen(false)}>
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    variant="primary"
                    onClick={handleSendInvoiceSMS}
                    isLoading={smsSending}
                    leftIcon={<Send className="w-3.5 h-3.5" />}
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
