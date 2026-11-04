'use client';

import React, { useState } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { useDataStore } from '@/lib/data/store';
import { Payroll } from '@/types';
import {
  Plus,
  Search,
  Printer,
  ShieldCheck,
  Check,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { FilterSummary } from '@/components/ui/FilterSummary';
import { WorkspaceHeader } from '@/components/ui/WorkspaceHeader';
import { WorkspaceFilters } from '@/components/ui/WorkspaceFilters';
import { useToast } from '@/components/ui/Toast';
import { Badge } from '@/components/ui/Badge';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { SearchableSelect } from '@/components/ui/SearchableSelect';
import { Modal } from '@/components/ui/Modal';
import { AsintaEmblem, AsintaWordmark } from '@/components/ui/AsintaLogo';
import { formatPeso, formatPesoCompact } from '@/lib/email/format';
import { formatRecordedWork } from '@/lib/payroll/display';
import { AttendanceMatrix } from '@/components/payroll/AttendanceMatrix';
import { getManilaClock } from '@/lib/reminders/scheduler';

export default function PayrollPage() {
  const { showToast } = useToast();
  const [pendingPayAction, setPendingPayAction] = useState<{ pay: Payroll; status: 'approved' | 'paid' } | null>(null);
  const [isUpdatingStatus, setIsUpdatingStatus] = useState(false);
  const statusLock = React.useRef(false);
  const generateLock = React.useRef(false);
  const {
    payroll,
    workers,
    projects,
    attendance,
    advances,
    createPayrollRun,
    updatePayrollStatus,
  } = useDataStore();

  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [projectFilter, setProjectFilter] = useState<string>('all');

  // Modals
  const [isGenerateModalOpen, setIsGenerateModalOpen] = useState(false);
  const [isPayslipModalOpen, setIsPayslipModalOpen] = useState(false);
  const [selectedPayroll, setSelectedPayroll] = useState<Payroll | null>(null);

  // Generate run state (defaults to the past 7 days through today)
  const todayStr = getManilaClock().dateIso;
  const weekAgoStr = new Date(Date.parse(`${todayStr}T00:00:00Z`) - 6 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const [periodStart, setPeriodStart] = useState(weekAgoStr);
  const [periodEnd, setPeriodEnd] = useState(todayStr);
  const [generateProjectId, setGenerateProjectId] = useState<string>('all');
  const [isGenerating, setIsGenerating] = useState(false);

  const formatPHP = formatPesoCompact;

  /**
   * Resolves the project site(s) associated with a payroll record using:
   * 1. Attendance logged by the worker during the payroll period
   * 2. Project site names recorded in `pay.notes`
   * 3. Fallback to the worker's overall attendance/advance project assignments
   */
  const getProjectsForPayroll = (pay: Payroll) => {
    const periodProjectIds = new Set(
      attendance
        .filter(
          (a) =>
            a.worker_id === pay.worker_id &&
            a.date >= pay.period_start &&
            a.date <= pay.period_end
        )
        .map((a) => a.project_id)
    );

    if (pay.notes) {
      projects.forEach((proj) => {
        if (pay.notes?.toLowerCase().includes(proj.name.toLowerCase())) {
          periodProjectIds.add(proj.id);
        }
      });
    }

    if (periodProjectIds.size === 0) {
      attendance
        .filter((a) => a.worker_id === pay.worker_id)
        .forEach((a) => periodProjectIds.add(a.project_id));
      advances
        .filter((adv) => adv.worker_id === pay.worker_id)
        .forEach((adv) => periodProjectIds.add(adv.project_id));
    }

    return projects.filter((p) => periodProjectIds.has(p.id));
  };

  const filteredPayroll = payroll.filter((p) => {
    const worker = workers.find((w) => w.id === p.worker_id);
    const payProjects = getProjectsForPayroll(p);

    const matchesProject =
      projectFilter === 'all' || payProjects.some((proj) => proj.id === projectFilter);

    const matchesSearch =
      worker?.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      worker?.position.toLowerCase().includes(searchQuery.toLowerCase()) ||
      payProjects.some((proj) => proj.name.toLowerCase().includes(searchQuery.toLowerCase())) ||
      (p.notes && p.notes.toLowerCase().includes(searchQuery.toLowerCase()));

    const matchesStatus = statusFilter === 'all' || p.status === statusFilter;
    return matchesProject && matchesSearch && matchesStatus;
  });

  const totalNetDisbursement = filteredPayroll.reduce((sum, p) => sum + Number(p.net_pay || 0), 0);
  const totalBaleRecovered = filteredPayroll.reduce((sum, p) => sum + Number(p.bale_deduction || 0), 0);

  const periodAttendanceRecords = attendance.filter(
    (a) =>
      a.date >= periodStart &&
      a.date <= periodEnd &&
      (generateProjectId === 'all' || a.project_id === generateProjectId)
  );
  const periodAttendanceCount = periodAttendanceRecords.length;
  const unverifiedSelfLogsCount = periodAttendanceRecords.filter(
    (a) =>
      a.worker_id === a.recorded_by &&
      !a.is_founder_override &&
      (a.status === 'present' || a.status === 'half_day')
  ).length;

  const existingPeriodVouchers = payroll.filter(
    (p) => p.period_start === periodStart && p.period_end === periodEnd
  );

  const handleGenerateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (generateLock.current) return;
    generateLock.current = true;
    setIsGenerating(true);
    try {
      const created = await createPayrollRun(periodStart, periodEnd, generateProjectId);
      if (created) {
        setIsGenerateModalOpen(false);
      }
    } catch {
      showToast('error', 'Could not confirm the payroll run. Refresh and check the vouchers before trying again.');
    } finally {
      generateLock.current = false;
      setIsGenerating(false);
    }
  };

  const handleConfirmStatus = async () => {
    if (!pendingPayAction || statusLock.current) return;
    statusLock.current = true;
    setIsUpdatingStatus(true);
    try {
      const success = await updatePayrollStatus(pendingPayAction.pay.id, pendingPayAction.status);
      if (success) {
        showToast('success', pendingPayAction.status === 'paid'
          ? 'Payroll payment and Bale deductions recorded.'
          : 'Payroll voucher approved.');
        setPendingPayAction(null);
      } else {
        showToast('error', 'Update not confirmed. Check payroll and the advance ledger before retrying.');
      }
    } catch {
      showToast('error', 'Update not confirmed. Check payroll and the advance ledger before retrying.');
    } finally {
      statusLock.current = false;
      setIsUpdatingStatus(false);
    }
  };

  return (
    <AppShell requireFounder={true}>
      <div className="space-y-6">
        <WorkspaceHeader
          eyebrow="Workforce & pay"
          title="Payroll"
          description="Review attendance-based vouchers, Bale deductions and worker payslips."
          action={<Button variant="primary" size="md" onClick={() => setIsGenerateModalOpen(true)} leftIcon={<Plus className="w-4 h-4" />}>New Payroll Run</Button>}
        />

        <AttendanceMatrix start={periodStart} end={periodEnd} site={generateProjectId} setStart={setPeriodStart} setEnd={setPeriodEnd} setSite={setGenerateProjectId} projects={projects} />

        {/* Top Summary Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 auto-rows-fr">
          <div className="h-full p-4 sm:p-5 rounded-xl bg-white border border-surface-border flex flex-col justify-between">
            <div className="text-xs font-medium text-ink-secondary">Net pay on shown vouchers</div>
            <div className="text-2xl font-bold text-navy mt-1 tabular-nums break-words">{formatPHP(totalNetDisbursement)}</div>
          </div>

          <div className="h-full p-4 sm:p-5 rounded-xl bg-white border border-surface-border flex flex-col justify-between">
            <div className="text-xs font-medium text-ink-secondary">Bale deductions on shown vouchers</div>
            <div className="text-2xl font-bold text-status-success mt-1 tabular-nums break-words">{formatPHP(totalBaleRecovered)}</div>
          </div>

          <div className="h-full p-4 sm:p-5 rounded-xl bg-white border border-surface-border flex flex-col justify-between">
            <div className="text-xs font-medium text-ink-secondary">Vouchers needing review</div>
            <div className="text-2xl font-bold text-status-warning mt-1 tabular-nums">
              {filteredPayroll.filter((p) => p.status === 'draft' || p.status === 'reviewed').length}
            </div>
          </div>
        </div>

        <p className="text-xs leading-relaxed text-ink-secondary">Summary reflects the current filters and includes vouchers of all shown statuses. Deductions on draft or approved vouchers are not necessarily collected.</p>

        <WorkspaceFilters title="Find a payroll voucher" summary={<FilterSummary count={filteredPayroll.length} itemName="payroll" active={Boolean(searchQuery) || projectFilter !== 'all' || statusFilter !== 'all'} onClear={() => { setSearchQuery(''); setProjectFilter('all'); setStatusFilter('all'); }} />}>
          <div className="flex flex-col sm:flex-row flex-wrap sm:items-end gap-3">
            <div className="w-full sm:w-80">
              <Input
                label="Search payroll"
                placeholder="Search worker, position, or project..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                leftIcon={<Search className="w-4 h-4" />}
              />
            </div>

            <div className="w-full sm:w-64">
              <SearchableSelect
                label="Project"
                searchLabel="Search voucher project sites"
                value={projectFilter}
                onChange={(e) => setProjectFilter(e.target.value)}
                fixedOption={{ label: 'All Project Sites', value: 'all' }}
                options={projects.map((p) => ({
                  label: `${p.name} (${p.location.split(',')[0]})`,
                  value: p.id,
                }))}
              />
            </div>

            <div className="w-full sm:w-48">
              <Select
                label="Status"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                options={[
                  { label: 'All Statuses', value: 'all' },
                  { label: 'Draft', value: 'draft' },
                  { label: 'Reviewed', value: 'reviewed' },
                  { label: 'Approved', value: 'approved' },
                  { label: 'Paid', value: 'paid' },
                ]}
              />
            </div>
          </div>
        </WorkspaceFilters>

        {/* Payroll Table */}
        <div className="bg-white rounded-xl border border-surface-border overflow-hidden">
          <div className="divide-y divide-surface-border/70">
            {filteredPayroll.map((pay) => {
              const worker = workers.find((w) => w.id === pay.worker_id);
              const payProjects = getProjectsForPayroll(pay);

              const statusBadgeVariant =
                pay.status === 'paid'
                  ? 'success'
                  : pay.status === 'approved'
                  ? 'info'
                  : 'warning';

              return (
                <div
                  key={pay.id}
                  className="p-4 sm:p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4 hover:bg-surface transition-colors"
                >
                  {/* Left: Worker info */}
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-center flex-wrap gap-2">
                      <span className="font-bold text-sm text-navy">{worker?.name}</span>
                      <span className="text-xs text-ink-secondary">({worker?.position})</span>
                      <Badge variant={statusBadgeVariant} size="sm">
                        {pay.status}
                      </Badge>
                    </div>

                    <div className="text-xs text-ink-secondary">
                      Period: <span className="font-semibold text-navy">{pay.period_start} → {pay.period_end}</span> · Days: {formatRecordedWork(pay.days_worked, 'days')} · Hours: {formatRecordedWork(pay.hours_worked, 'hours')}
                    </div>

                    {payProjects.length > 0 && (
                      <div className="text-xs text-ink-secondary flex items-center flex-wrap gap-1.5">
                        <span>Project Site{payProjects.length > 1 ? 's' : ''}:</span>
                        {payProjects.map((proj) => (
                          <span
                            key={proj.id}
                            className="min-w-0 max-w-full truncate px-2 py-0.5 rounded-lg bg-surface-inset border border-surface-border text-[11px] font-semibold text-navy"
                          >
                            {proj.name}
                          </span>
                        ))}
                      </div>
                    )}

                    {pay.notes && (
                      <div className="break-words text-xs text-ink-muted italic">{pay.notes}</div>
                    )}
                  </div>

                  {/* Middle: Calculation columns */}
                  <div className="grid grid-cols-3 gap-4 text-xs py-2 lg:py-0">
                    <div>
                      <div className="text-ink-secondary">Gross Wages</div>
                      <div className="font-bold text-navy text-sm mt-0.5">{formatPeso(pay.gross_pay)}</div>
                    </div>

                    <div>
                      <div className="text-ink-secondary">Bale Deduction</div>
                      <div className={`font-bold text-sm mt-0.5 ${pay.bale_deduction > 0 ? 'text-status-danger' : 'text-slate-400'}`}>
                        -{formatPeso(pay.bale_deduction)}
                      </div>
                    </div>

                    <div>
                      <div className="text-ink-secondary font-semibold">Net Pay</div>
                      <div className="font-extrabold text-navy text-base mt-0.5">{formatPeso(pay.net_pay)}</div>
                    </div>
                  </div>

                  {/* Right: Actions */}
                  <div className="flex items-center flex-wrap gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        setSelectedPayroll(pay);
                        setIsPayslipModalOpen(true);
                      }}
                      leftIcon={<Printer className="w-3.5 h-3.5" />}
                    >
                      Print Payslip
                    </Button>

                    {(pay.status === 'draft' || pay.status === 'reviewed') && (
                      <Button
                        variant="soft"
                        size="sm"
                        onClick={() => setPendingPayAction({ pay, status: 'approved' })}
                        leftIcon={<ShieldCheck className="w-3.5 h-3.5 text-navy" />}
                      >
                        Approve
                      </Button>
                    )}

                    {pay.status === 'approved' && (
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => setPendingPayAction({ pay, status: 'paid' })}
                        leftIcon={<Check className="w-3.5 h-3.5" />}
                      >
                        Mark as Paid
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}

            {filteredPayroll.length === 0 && (
              <div className="p-12 text-center text-xs text-ink-secondary">
                {payroll.length === 0 ? 'No payroll vouchers have been recorded yet.' : 'No payroll vouchers match the current search or filters. Clear filters to see all vouchers.'}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* GENERATE RUN MODAL */}
      <Modal
        isOpen={isGenerateModalOpen}
        onClose={() => setIsGenerateModalOpen(false)}
        dismissOnBackdrop={!isGenerating}
        dismissOnEscape={!isGenerating}
        showCloseButton={!isGenerating}
        title="Compute Weekly / Bi-Monthly Payroll"
        description="Calculate gross pay from attendance and suggest Bale deductions. Deductions are attempted when the voucher is marked paid."
      >
        <form onSubmit={handleGenerateSubmit} className="space-y-4 text-xs">
          <SearchableSelect
            label="Project Site Scope"
            searchLabel="Search payroll run sites"
            value={generateProjectId}
            onChange={(e) => setGenerateProjectId(e.target.value)}
            fixedOption={{ label: 'All Project Sites (Firm-wide Run)', value: 'all' }}
            options={projects.map((p) => ({
              label: `${p.name} (${p.location.split(',')[0]})`,
              value: p.id,
            }))}
          />

          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Period Start Date"
              type="date"
              value={periodStart}
              onChange={(e) => setPeriodStart(e.target.value)}
              max={periodEnd}
              required
            />
            <Input
              label="Period End Date"
              type="date"
              value={periodEnd}
              onChange={(e) => setPeriodEnd(e.target.value)}
              min={periodStart}
              required
            />
          </div>

          <div className="p-3.5 rounded-2xl bg-surface-inset border border-surface-border space-y-1.5 text-ink-secondary">
            <div className="flex items-center justify-between">
              <span className="font-bold text-navy text-xs">Attendance currently loaded:</span>
              <Badge variant={periodAttendanceCount > 0 ? 'success' : 'warning'} size="sm">
                {periodAttendanceCount} loaded log{periodAttendanceCount === 1 ? '' : 's'} in range
              </Badge>
            </div>
            <div>
              This preview may omit records. Generating checks the selected period directly from the server. Review the resulting vouchers before approval, and avoid concurrent payroll, attendance or advance changes during generation.
            </div>
            {unverifiedSelfLogsCount > 0 && (
              <div className="text-[11px] font-semibold text-status-warning pt-1 border-t border-surface-border/60">
                At least {unverifiedSelfLogsCount} supervisor self-attendance log(s) need Founder verification on the Attendance page. Other unverified supervisor records may also be held back.
              </div>
            )}
            <div className="text-[11px] font-semibold text-navy pt-1 border-t border-surface-border/60">
              {existingPeriodVouchers.length > 0 && <>At least {existingPeriodVouchers.length} loaded voucher(s) exist for {periodStart} → {periodEnd}. </>}
              The run recalculates eligible draft or reviewed vouchers; approved and paid vouchers are skipped. A site-scoped run may recalculate an existing worker-period voucher rather than creating a separate voucher for that site.
            </div>
          </div>

          <div className="pt-3 flex justify-end space-x-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setIsGenerateModalOpen(false)}
              disabled={isGenerating}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              type="submit"
              isLoading={isGenerating}
              disabled={isGenerating}
            >
              {isGenerating ? 'Preparing payroll…' : 'Generate / Refresh Payroll Run'}
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        isOpen={Boolean(pendingPayAction)}
        onClose={() => setPendingPayAction(null)}
        dismissOnBackdrop={!isUpdatingStatus}
        dismissOnEscape={!isUpdatingStatus}
        showCloseButton={!isUpdatingStatus}
        title={pendingPayAction?.status === 'paid' ? 'Confirm payroll payment' : 'Approve payroll voucher'}
        description={pendingPayAction?.status === 'paid' ? 'Only mark this voucher paid after the worker has actually been paid.' : 'Review the voucher before approving it.'}
      >
        {pendingPayAction && (
          <div className="space-y-4 text-xs">
            <div className="space-y-1 rounded-xl border border-surface-border bg-surface-inset p-4">
              <p className="text-sm font-semibold text-navy">{workers.find((worker) => worker.id === pendingPayAction.pay.worker_id)?.name || 'Worker unavailable'}</p>
              <p className="text-ink-secondary">Period: {pendingPayAction.pay.period_start} → {pendingPayAction.pay.period_end}</p>
              <p className="font-semibold text-navy">Net pay: {formatPeso(pendingPayAction.pay.net_pay)}</p>
              <p className="text-ink-secondary">Bale deduction on voucher: {formatPeso(pendingPayAction.pay.bale_deduction)}</p>
            </div>
            {pendingPayAction.status === 'paid' && pendingPayAction.pay.bale_deduction > 0 && (
              <p className="rounded-xl border border-status-warning/25 bg-status-warning-bg px-3 py-2.5 leading-relaxed text-ink-secondary">
                Payment status and Bale deductions are recorded together. If the current active Bale balance is insufficient, the payment cannot be recorded. If the result is unconfirmed, refresh and check both ledgers before retrying; historical payments may still need reconciliation.
              </p>
            )}
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button type="button" variant="secondary" disabled={isUpdatingStatus} onClick={() => setPendingPayAction(null)}>Cancel</Button>
              <Button type="button" variant="primary" isLoading={isUpdatingStatus} onClick={handleConfirmStatus}>
                {isUpdatingStatus ? 'Updating…' : pendingPayAction.status === 'paid' ? 'Confirm paid' : 'Approve voucher'}
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {/* PRINTABLE PAYSLIP MODAL */}
      <Modal
        isOpen={isPayslipModalOpen}
        onClose={() => setIsPayslipModalOpen(false)}
        title="Asinta Architects — Official Worker Payslip"
        description="Printable worker compensation slip and signed acknowledgment."
        maxWidth="lg"
      >
        {selectedPayroll && (() => {
          const worker = workers.find((w) => w.id === selectedPayroll.worker_id);

          return (
            <div className="space-y-6">
              {/* Printable Payslip Card */}
              <div className="p-6 rounded-2xl bg-white border border-slate-300 font-sans space-y-5 text-ink-primary">
                {/* Header */}
                <div className="flex items-start justify-between pb-4 border-b-2 border-navy">
                  <div className="flex items-center gap-3">
                    <AsintaEmblem size={30} />
                    <div>
                      <AsintaWordmark height={18} />
                      <div className="text-[11px] font-medium text-ink-secondary mt-1">
                        Design · Build · Batangas
                      </div>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-xs font-bold text-navy">WORKER PAYSLIP · {selectedPayroll.status.toUpperCase()}</div>
                    <div className="text-[11px] text-ink-secondary tabular-nums">
                      Period: {selectedPayroll.period_start} to {selectedPayroll.period_end}
                    </div>
                  </div>
                </div>

                {/* Worker Details */}
                <div className="grid grid-cols-2 gap-4 text-xs">
                  <div>
                    <div className="text-[10px] font-bold uppercase text-ink-secondary">Worker Name</div>
                    <div className="font-bold text-navy text-sm mt-0.5">{worker?.name}</div>
                    <div className="text-ink-secondary">{worker?.position}</div>
                    {getProjectsForPayroll(selectedPayroll).length > 0 && (
                      <div className="text-[11px] text-navy font-semibold mt-1">
                        Site: {getProjectsForPayroll(selectedPayroll).map((p) => p.name).join(', ')}
                      </div>
                    )}
                  </div>
                  <div className="text-right">
                    <div className="text-[10px] font-bold uppercase text-ink-secondary">Current worker rate</div>
                    <div className="font-bold text-navy mt-0.5">{worker ? `${formatPeso(worker.pay_rate)} / ${worker.pay_rate_type === 'hourly' ? 'hour' : 'day'}` : 'Not available'}</div>
                    <div className="text-ink-secondary">Days worked: {formatRecordedWork(selectedPayroll.days_worked, 'days')}</div>
                  </div>
                </div>

                {/* Breakdown Table */}
                <div className="border border-slate-200 rounded-xl overflow-x-auto text-xs">
                  <table className="w-full">
                    <thead className="bg-slate-50 font-bold text-navy uppercase text-[10px] border-b border-slate-200">
                      <tr>
                        <th className="p-2.5 text-left">Earnings & Deductions</th>
                        <th className="p-2.5 text-right">Amount (PHP)</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      <tr>
                        <td className="p-2.5">Gross wages</td>
                        <td className="p-2.5 text-right font-mono font-bold text-navy">{formatPeso(selectedPayroll.gross_pay)}</td>
                      </tr>
                      {selectedPayroll.bale_deduction > 0 && (
                        <tr className="text-status-danger">
                          <td className="p-2.5">Bale / Cash Advance Deduction</td>
                          <td className="p-2.5 text-right font-mono font-bold">-{formatPeso(selectedPayroll.bale_deduction)}</td>
                        </tr>
                      )}
                      {selectedPayroll.other_deductions > 0 && (
                        <tr className="text-status-danger">
                          <td className="p-2.5">Other Deductions / Tools</td>
                          <td className="p-2.5 text-right font-mono font-bold">-{formatPeso(selectedPayroll.other_deductions)}</td>
                        </tr>
                      )}
                      <tr className="bg-slate-50/80 font-black text-sm text-navy">
                        <td className="p-2.5">NET TAKE-HOME PAY</td>
                        <td className="p-2.5 text-right font-mono text-base">{formatPeso(selectedPayroll.net_pay)}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                {/* Worker Signature Acknowledgment */}
                <div className="pt-4 border-t border-slate-200 flex items-end justify-between text-[11px]">
                  <div>
                    <div className="text-[10px] text-ink-secondary">Authorized by:</div>
                    <div className="font-bold text-navy">Ar. Junel Buyagon</div>
                    <div className="text-[9px] text-ink-muted">Principal Architect</div>
                  </div>

                  <div className="text-center">
                    <div className="w-44 border-b border-navy mb-1" />
                    <div className="text-[10px] font-semibold text-navy">Worker Signature & Date</div>
                    <div className="text-[9px] text-ink-muted">Acknowledgment, if applicable</div>
                  </div>
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex justify-between items-center">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => window.print()}
                  leftIcon={<Printer className="w-3.5 h-3.5" />}
                >
                  Print Payslip
                </Button>
                <Button variant="primary" size="sm" onClick={() => setIsPayslipModalOpen(false)}>
                  Close
                </Button>
              </div>
            </div>
          );
        })()}
      </Modal>
    </AppShell>
  );
}
