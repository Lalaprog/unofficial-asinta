'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { AppShell } from '@/components/layout/AppShell';
import { useDataStore } from '@/lib/data/store';
import {
  Receipt,
  CreditCard,
  HandCoins,
  AlertTriangle,
  ArrowRight,
  Sparkles,
  CheckCircle2,
  Send,
} from 'lucide-react';
import { StatCard } from '@/components/ui/StatCard';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/Card';
import { Modal } from '@/components/ui/Modal';
import { buildReminderSMS } from '@/lib/sms/templates';
import { formatPesoCompact } from '@/lib/email/format';

export default function FounderDashboard() {
  const {
    invoices,
    expenses,
    advances,
    clients,
    projects,
    getFounderMetrics,
    sendSMS,
  } = useDataStore();

  const metrics = getFounderMetrics();

  // Quick SMS modal state
  const [smsModalOpen, setSmsModalOpen] = useState(false);
  const [selectedInvoiceForSMS, setSelectedInvoiceForSMS] = useState<any>(null);
  const [smsSending, setSmsSending] = useState(false);
  const [smsSuccessMessage, setSmsSuccessMessage] = useState<string | null>(null);

  const formatPHP = formatPesoCompact;

  const handleOpenSMSModal = (inv: any) => {
    setSelectedInvoiceForSMS(inv);
    setSmsSuccessMessage(null);
    setSmsModalOpen(true);
  };

  /** Centralized reminder wording (fallback variant — no email-date claim). */
  const buildSmsPreviewMessage = (inv: any): string => {
    const client = clients.find((c) => c.id === inv.client_id);
    const project = projects.find((p) => p.id === inv.project_id);
    return buildReminderSMS({
      contactPerson: client?.contact_person,
      companyName: client?.name,
      invoiceNumber: inv.invoice_number,
      projectName: project?.name || 'your project',
      outstandingBalance: inv.amount - inv.amount_paid,
      dueDate: inv.due_date,
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

  return (
    <AppShell requireFounder={true}>
      <div className="space-y-8">
        {/* Top Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2 border-b border-surface-border/60">
          <div>
            <div className="flex items-center space-x-2">
              <span className="text-xs font-bold text-navy uppercase tracking-widest">
                Executive Management
              </span>
              <span className="text-xs text-ink-muted">·</span>
              <span className="text-xs text-ink-secondary">Batangas Firm Operations</span>
            </div>
            <h1 className="text-2xl sm:text-3xl font-extrabold text-navy tracking-tight mt-1">
              Business Financial Overview
            </h1>
          </div>

          {/* Quick Action Buttons */}
          <div className="flex items-center space-x-2.5">
            <Link href="/invoices">
              <Button variant="secondary" size="sm" leftIcon={<Receipt className="w-3.5 h-3.5" />}>
                New Invoice
              </Button>
            </Link>
            <Link href="/expenses">
              <Button variant="primary" size="sm" leftIcon={<Sparkles className="w-3.5 h-3.5" />}>
                Record Expense
              </Button>
            </Link>
          </div>
        </div>

        {/* Primary Statistics Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6 auto-rows-fr">
          <StatCard
            title="Total Invoiced"
            value={formatPHP(metrics.totalInvoiced)}
            subtitle={`${formatPHP(metrics.totalCollected)} collected to date`}
            icon={<Receipt className="w-5 h-5" />}
            trend={{
              value: `${Math.round((metrics.totalCollected / (metrics.totalInvoiced || 1)) * 100)}% Collected`,
              isPositive: true,
            }}
          />

          <StatCard
            title="Receivables Outstanding"
            value={formatPHP(metrics.totalOutstanding)}
            subtitle={
              metrics.totalOverdue > 0
                ? `${formatPHP(metrics.totalOverdue)} overdue`
                : 'All accounts current'
            }
            icon={<AlertTriangle className="w-5 h-5" />}
            alert={metrics.totalOverdue > 0}
            trend={
              metrics.totalOverdue > 0
                ? { value: `${metrics.overdueInvoicesCount} Overdue`, isPositive: false }
                : undefined
            }
          />

          <StatCard
            title="Project Expenses"
            value={formatPHP(metrics.totalExpenses)}
            subtitle={`Materials: ${formatPHP(metrics.expensesByCategory.materials)}`}
            icon={<CreditCard className="w-5 h-5" />}
          />

          <StatCard
            title="Active Bale Balance"
            value={formatPHP(metrics.totalBaleBalance)}
            subtitle={`${advances.filter((a) => a.status === 'active' || a.status === 'partially_deducted').length} workers with advances`}
            icon={<HandCoins className="w-5 h-5" />}
            highlight
          />
        </div>

        {/* Overdue Invoices Alert Banner (if any) */}
        {metrics.totalOverdue > 0 && (
          <div className="p-4 sm:p-5 rounded-2xl bg-status-warning-bg border border-status-warning/25 shadow-sm flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            <div className="flex items-start space-x-3.5 min-w-0">
              <div className="p-2 rounded-xl bg-status-warning-bg text-status-warning shrink-0">
                <AlertTriangle className="w-5 h-5" />
              </div>
              <div className="min-w-0">
                <h4 className="text-sm font-bold text-navy truncate">
                  Action Required: {metrics.overdueInvoicesCount} Overdue Progress Billing ({formatPHP(metrics.totalOverdue)})
                </h4>
                <p className="text-xs text-ink-secondary mt-0.5 truncate">
                  Dispatch an immediate PhilSMS or email reminder to settle overdue milestones.
                </p>
              </div>
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => handleOpenSMSModal(invoices.find((i) => i.status === 'overdue'))}
              leftIcon={<Send className="w-3.5 h-3.5 text-status-warning" />}
              className="shrink-0 text-status-warning border-status-warning/30 hover:bg-white/60"
            >
              Send SMS Reminder
            </Button>
          </div>
        )}

        {/* Project Profitability & Cost Control Matrix */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <Card className="lg:col-span-2">
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle>Project Performance & Profitability</CardTitle>
                <CardDescription>
                  Real-time budget consumption, collections, and net margin per site
                </CardDescription>
              </div>
              <Link href="/projects" className="text-xs font-semibold text-navy hover:underline inline-flex items-center gap-1">
                <span>All Projects</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </Link>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {metrics.projectFinancials.map((proj) => {
                  const percentBilled = Math.min(100, Math.round((proj.invoiced / (proj.budget || 1)) * 100));
                  const percentCollected = Math.min(100, Math.round((proj.collected / (proj.budget || 1)) * 100));

                  return (
                    <div
                      key={proj.id}
                      className="p-4 rounded-xl bg-surface-inset/40 border border-surface-border/70 hover:bg-surface-inset/80 transition-all space-y-3"
                    >
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1.5">
                        <div>
                          <div className="font-bold text-sm text-navy">{proj.name}</div>
                          <div className="text-xs text-ink-secondary">
                            Budget: <span className="font-semibold text-navy">{formatPHP(proj.budget)}</span>
                          </div>
                        </div>
                        <div className="text-left sm:text-right">
                          <div className="text-sm font-bold text-navy">
                            {formatPHP(proj.collected)} <span className="text-xs font-normal text-ink-muted">Collected</span>
                          </div>
                          <div className="text-xs text-ink-secondary">
                            Expenses: <span className="font-semibold text-ink-primary">{formatPHP(proj.expenses)}</span>
                          </div>
                        </div>
                      </div>

                      {/* Progress bar */}
                      <div className="space-y-1">
                        <div className="flex justify-between text-[11px] text-ink-secondary font-medium">
                          <span>Progress Billed: {percentBilled}%</span>
                          <span className="text-status-success font-semibold">Margin: {proj.margin}%</span>
                        </div>
                        <div className="w-full h-2 bg-slate-200 rounded-full overflow-hidden flex">
                          <div
                            className="bg-navy transition-all"
                            style={{ width: `${percentCollected}%` }}
                            title={`Collected: ${percentCollected}%`}
                          />
                          <div
                            className="bg-slate-400 transition-all"
                            style={{ width: `${Math.max(0, percentBilled - percentCollected)}%` }}
                            title={`Pending: ${percentBilled - percentCollected}%`}
                          />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          {/* Expense Breakdown by Category */}
          <Card>
            <CardHeader>
              <CardTitle>Expense Distribution</CardTitle>
              <CardDescription>Breakdown across architectural cost codes</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-3.5">
                {[
                  { label: 'Raw Materials', key: 'materials', amount: metrics.expensesByCategory.materials, color: 'bg-navy' },
                  { label: 'Labor & Craft', key: 'labor', amount: metrics.expensesByCategory.labor, color: 'bg-slate-700' },
                  { label: 'Heavy Equipment', key: 'equipment', amount: metrics.expensesByCategory.equipment, color: 'bg-amber-600' },
                  { label: 'LGU Permits & Fees', key: 'permits', amount: metrics.expensesByCategory.permits, color: 'bg-emerald-700' },
                  { label: 'Logistics & Fuel', key: 'transportation', amount: metrics.expensesByCategory.transportation, color: 'bg-sky-700' },
                ].map((item) => {
                  const share = metrics.totalExpenses > 0 ? Math.round((item.amount / metrics.totalExpenses) * 100) : 0;
                  return (
                    <div key={item.key} className="space-y-1">
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-semibold text-navy">{item.label}</span>
                        <span className="text-ink-secondary font-mono">{formatPHP(item.amount)} ({share}%)</span>
                      </div>
                      <div className="w-full h-1.5 bg-slate-100 rounded-full overflow-hidden">
                        <div className={`h-full ${item.color}`} style={{ width: `${share}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="mt-6 pt-5 border-t border-surface-border/60">
                <Link href="/expenses" className="block">
                  <Button variant="outline" size="sm" className="w-full">
                    View Complete Expense Ledger
                  </Button>
                </Link>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Recent Transactions & Outstanding Invoices */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Recent Invoices */}
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle>Recent Invoices</CardTitle>
                <CardDescription>Client progress billing milestone records</CardDescription>
              </div>
              <Link href="/invoices" className="text-xs font-semibold text-navy hover:underline">
                View All
              </Link>
            </CardHeader>
            <CardContent>
              <div className="divide-y divide-surface-border/60">
                {invoices.slice(0, 4).map((inv) => (
                  <div key={inv.id} className="py-3 flex items-center justify-between gap-3">
                    <div>
                      <div className="font-bold text-xs text-navy font-mono">{inv.invoice_number}</div>
                      <div className="text-xs text-ink-secondary">
                        Due {inv.due_date}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-xs font-bold text-navy">{formatPHP(inv.amount)}</div>
                      <div className="mt-0.5">
                        <Badge
                          variant={
                            inv.status === 'paid'
                              ? 'success'
                              : inv.status === 'overdue'
                              ? 'danger'
                              : 'warning'
                          }
                          size="sm"
                        >
                          {inv.status.replace('_', ' ')}
                        </Badge>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Recent Expenses with AI tags */}
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle>Recent Expenses</CardTitle>
                <CardDescription>Site disbursements & AI categorized entries</CardDescription>
              </div>
              <Link href="/expenses" className="text-xs font-semibold text-navy hover:underline">
                View All
              </Link>
            </CardHeader>
            <CardContent>
              <div className="divide-y divide-surface-border/60">
                {expenses.slice(0, 4).map((exp) => (
                  <div key={exp.id} className="py-3 flex items-start justify-between gap-3">
                    <div className="space-y-0.5 max-w-[70%]">
                      <div className="font-semibold text-xs text-navy line-clamp-1">{exp.description}</div>
                      <div className="text-[11px] text-ink-secondary flex items-center gap-1.5">
                        <span className="capitalize">{exp.category}</span>
                        <span>·</span>
                        <span>{exp.expense_date}</span>
                        {exp.ai_bale_detection && (
                          <span className="px-1.5 py-0.2 bg-status-warning-bg text-status-warning rounded font-semibold text-[10px]">
                            Bale
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-xs font-bold text-navy">{formatPHP(exp.amount)}</div>
                      <div className="text-[10px] text-status-success font-medium">Confirmed</div>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* PhilSMS Modal */}
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
                  <div className="flex justify-between">
                    <span className="text-ink-secondary">Invoice Number:</span>
                    <span className="font-bold text-navy font-mono">{selectedInvoiceForSMS.invoice_number}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-ink-secondary">Outstanding Balance:</span>
                    <span className="font-bold text-status-danger">
                      {formatPHP(selectedInvoiceForSMS.amount - selectedInvoiceForSMS.amount_paid)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-ink-secondary">Original Due Date:</span>
                    <span className="font-medium text-navy">{selectedInvoiceForSMS.due_date}</span>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <label className="font-bold text-navy uppercase text-[11px]">SMS Message Preview (PhilSMS)</label>
                  <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 text-ink-primary font-sans leading-relaxed text-xs">
                    {buildSmsPreviewMessage(selectedInvoiceForSMS)}
                  </div>
                </div>

                <div className="pt-2 flex justify-end space-x-2">
                  <Button variant="secondary" onClick={() => setSmsModalOpen(false)}>
                    Cancel
                  </Button>
                  <Button
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
