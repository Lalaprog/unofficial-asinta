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
import { Badge } from '@/components/ui/Badge';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Modal } from '@/components/ui/Modal';
import { AsintaEmblem, AsintaWordmark } from '@/components/ui/AsintaLogo';
import { formatPesoCompact } from '@/lib/email/format';

export default function PayrollPage() {
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
  const todayStr = new Date().toISOString().split('T')[0];
  const weekAgoStr = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
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
    if (isGenerating) return;
    setIsGenerating(true);
    try {
      const created = await createPayrollRun(periodStart, periodEnd, generateProjectId);
      if (created) {
        setIsGenerateModalOpen(false);
      }
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <AppShell requireFounder={true}>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2 border-b border-surface-border/60">
          <div>
            <div className="flex items-center space-x-2">
              <span className="text-xs font-bold text-navy uppercase tracking-widest">
                Manpower Compensation
              </span>
              <span className="text-xs text-ink-muted">·</span>
              <span className="text-xs text-ink-secondary">Bale Integrated</span>
            </div>
            <h1 className="text-2xl sm:text-3xl font-extrabold text-navy tracking-tight mt-1">
              Automated Payroll Engine
            </h1>
          </div>

          <Button
            variant="primary"
            size="md"
            onClick={() => setIsGenerateModalOpen(true)}
            leftIcon={<Plus className="w-4 h-4" />}
          >
            Compute New Period Run
          </Button>
        </div>

        {/* Top Summary Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 auto-rows-fr">
          <div className="h-full p-5 rounded-2xl bg-white border border-surface-border shadow-sm flex flex-col justify-between">
            <div className="text-xs font-semibold text-ink-secondary uppercase truncate">Total Net Payroll</div>
            <div className="text-2xl font-bold text-navy mt-1 tabular-nums truncate">{formatPHP(totalNetDisbursement)}</div>
          </div>

          <div className="h-full p-5 rounded-2xl bg-white border border-surface-border shadow-sm flex flex-col justify-between">
            <div className="text-xs font-semibold text-ink-secondary uppercase truncate">Bale Deductions Recovered</div>
            <div className="text-2xl font-bold text-status-success mt-1 tabular-nums truncate">{formatPHP(totalBaleRecovered)}</div>
          </div>

          <div className="h-full p-5 rounded-2xl bg-white border border-surface-border shadow-sm flex flex-col justify-between">
            <div className="text-xs font-semibold text-ink-secondary uppercase truncate">Pending Founder Approval</div>
            <div className="text-2xl font-bold text-status-warning mt-1 tabular-nums">
              {filteredPayroll.filter((p) => p.status === 'draft' || p.status === 'reviewed').length}
            </div>
          </div>
        </div>

        {/* Filters */}
        <div className="flex flex-col sm:flex-row flex-wrap items-center gap-3">
          <div className="w-full sm:w-80">
            <Input
              placeholder="Search worker, position, or project..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              leftIcon={<Search className="w-4 h-4" />}
            />
          </div>

          <div className="w-full sm:w-64">
            <Select
              value={projectFilter}
              onChange={(e) => setProjectFilter(e.target.value)}
              options={[
                { label: 'All Project Sites', value: 'all' },
                ...projects.map((p) => ({
                  label: `${p.name} (${p.location.split(',')[0]})`,
                  value: p.id,
                })),
              ]}
            />
          </div>

          <div className="w-full sm:w-48">
            <Select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              options={[
                { label: 'All Statuses', value: 'all' },
                { label: 'Draft', value: 'draft' },
                { label: 'Approved', value: 'approved' },
                { label: 'Paid', value: 'paid' },
              ]}
            />
          </div>
        </div>

        {/* Payroll Table */}
        <div className="bg-white rounded-3xl border border-surface-border shadow-[6px_6px_18px_rgba(11,31,58,0.06),-6px_-6px_18px_rgba(255,255,255,0.95)] overflow-hidden">
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
                  className="p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4 hover:bg-slate-50/60 transition-colors"
                >
                  {/* Left: Worker info */}
                  <div className="space-y-1">
                    <div className="flex items-center flex-wrap gap-2">
                      <span className="font-bold text-sm text-navy">{worker?.name}</span>
                      <span className="text-xs text-ink-secondary">({worker?.position})</span>
                      <Badge variant={statusBadgeVariant} size="sm">
                        {pay.status}
                      </Badge>
                    </div>

                    <div className="text-xs text-ink-secondary">
                      Period: <span className="font-semibold text-navy">{pay.period_start} → {pay.period_end}</span> · Days: {pay.days_worked || 6} days ({pay.hours_worked || 48}h)
                    </div>

                    {payProjects.length > 0 && (
                      <div className="text-xs text-ink-secondary flex items-center flex-wrap gap-1.5">
                        <span>Project Site{payProjects.length > 1 ? 's' : ''}:</span>
                        {payProjects.map((proj) => (
                          <span
                            key={proj.id}
                            className="px-2 py-0.5 rounded-lg bg-surface-inset border border-surface-border text-[11px] font-semibold text-navy"
                          >
                            {proj.name}
                          </span>
                        ))}
                      </div>
                    )}

                    {pay.notes && (
                      <div className="text-xs text-ink-muted italic">{pay.notes}</div>
                    )}
                  </div>

                  {/* Middle: Calculation columns */}
                  <div className="grid grid-cols-3 gap-4 text-xs py-2 lg:py-0">
                    <div>
                      <div className="text-ink-secondary">Gross Wages</div>
                      <div className="font-bold text-navy text-sm mt-0.5">{formatPHP(pay.gross_pay)}</div>
                    </div>

                    <div>
                      <div className="text-ink-secondary">Bale Deduction</div>
                      <div className={`font-bold text-sm mt-0.5 ${pay.bale_deduction > 0 ? 'text-status-danger' : 'text-slate-400'}`}>
                        -{formatPHP(pay.bale_deduction)}
                      </div>
                    </div>

                    <div>
                      <div className="text-ink-secondary font-semibold">Net Pay</div>
                      <div className="font-extrabold text-navy text-base mt-0.5">{formatPHP(pay.net_pay)}</div>
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

                    {pay.status === 'draft' && (
                      <Button
                        variant="soft"
                        size="sm"
                        onClick={() => updatePayrollStatus(pay.id, 'approved')}
                        leftIcon={<ShieldCheck className="w-3.5 h-3.5 text-navy" />}
                      >
                        Approve
                      </Button>
                    )}

                    {pay.status === 'approved' && (
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => updatePayrollStatus(pay.id, 'paid')}
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
                No payroll records found matching current criteria.
              </div>
            )}
          </div>
        </div>
      </div>

      {/* GENERATE RUN MODAL */}
      <Modal
        isOpen={isGenerateModalOpen}
        onClose={() => setIsGenerateModalOpen(false)}
        title="Compute Weekly / Bi-Monthly Payroll"
        description="Automatically calculates gross pay from attendance and deducts active worker advances (bale)."
      >
        <form onSubmit={handleGenerateSubmit} className="space-y-4 text-xs">
          <Select
            label="Project Site Scope"
            value={generateProjectId}
            onChange={(e) => setGenerateProjectId(e.target.value)}
          >
            <option value="all">All Project Sites (Firm-wide Run)</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.location.split(',')[0]})
              </option>
            ))}
          </Select>

          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Period Start Date"
              type="date"
              value={periodStart}
              onChange={(e) => setPeriodStart(e.target.value)}
              required
            />
            <Input
              label="Period End Date"
              type="date"
              value={periodEnd}
              onChange={(e) => setPeriodEnd(e.target.value)}
              required
            />
          </div>

          <div className="p-3.5 rounded-2xl bg-surface-inset border border-surface-border space-y-1.5 text-ink-secondary">
            <div className="flex items-center justify-between">
              <span className="font-bold text-navy text-xs">Live Attendance Sync:</span>
              <Badge variant={periodAttendanceCount > 0 ? 'success' : 'warning'} size="sm">
                {periodAttendanceCount} attendance log{periodAttendanceCount === 1 ? '' : 's'} in range
              </Badge>
            </div>
            <div>
              Supervisor-submitted attendance is synced automatically — you do not need to re-submit attendance before running payroll.
            </div>
            {unverifiedSelfLogsCount > 0 && (
              <div className="text-[11px] font-semibold text-status-warning pt-1 border-t border-surface-border/60">
                Anti-Fraud Gate: {unverifiedSelfLogsCount} Supervisor self-attendance log(s) are awaiting Founder verification on the Attendance page and are held back until verified.
              </div>
            )}
            {existingPeriodVouchers.length > 0 && (
              <div className="text-[11px] font-semibold text-navy pt-1 border-t border-surface-border/60">
                Note: {existingPeriodVouchers.length} voucher(s) already exist for {periodStart} → {periodEnd}. Running again will refresh draft vouchers in-place without creating duplicates.
              </div>
            )}
          </div>

          <div className="pt-3 flex justify-end space-x-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setIsGenerateModalOpen(false)}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              type="submit"
              isLoading={isGenerating}
              disabled={isGenerating || periodAttendanceCount === 0}
            >
              {existingPeriodVouchers.length > 0 ? 'Refresh / Recalculate Run' : 'Generate Payroll Run'}
            </Button>
          </div>
        </form>
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
                      <div className="text-[10px] uppercase font-semibold text-ink-secondary tracking-widest mt-1">
                        Design · Build · Batangas
                      </div>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-xs font-bold text-navy">WORKER PAYSLIP</div>
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
                    <div className="text-[10px] font-bold uppercase text-ink-secondary">Wage Rate</div>
                    <div className="font-bold text-navy mt-0.5">₱{worker?.pay_rate} / Day</div>
                    <div className="text-ink-secondary">Days Worked: {selectedPayroll.days_worked || 6} days</div>
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
                        <td className="p-2.5">Gross Wages ({selectedPayroll.days_worked || 6} days @ ₱{worker?.pay_rate})</td>
                        <td className="p-2.5 text-right font-mono font-bold text-navy">{formatPHP(selectedPayroll.gross_pay)}</td>
                      </tr>
                      {selectedPayroll.bale_deduction > 0 && (
                        <tr className="text-status-danger">
                          <td className="p-2.5">Bale / Cash Advance Deduction</td>
                          <td className="p-2.5 text-right font-mono font-bold">-{formatPHP(selectedPayroll.bale_deduction)}</td>
                        </tr>
                      )}
                      {selectedPayroll.other_deductions > 0 && (
                        <tr className="text-status-danger">
                          <td className="p-2.5">Other Deductions / Tools</td>
                          <td className="p-2.5 text-right font-mono font-bold">-{formatPHP(selectedPayroll.other_deductions)}</td>
                        </tr>
                      )}
                      <tr className="bg-slate-50/80 font-black text-sm text-navy">
                        <td className="p-2.5">NET TAKE-HOME PAY</td>
                        <td className="p-2.5 text-right font-mono text-base">{formatPHP(selectedPayroll.net_pay)}</td>
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
                    <div className="text-[9px] text-ink-muted">Received in cash / envelope</div>
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
