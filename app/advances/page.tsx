'use client';

import React, { useState } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { useDataStore } from '@/lib/data/store';
import { Advance } from '@/types';
import {
  Plus,
  Search,
  TrendingDown,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Modal } from '@/components/ui/Modal';
import { formatPesoCompact } from '@/lib/email/format';

export default function AdvancesPage() {
  const {
    advances,
    workers,
    projects,
    createAdvance,
    recordAdvanceDeduction,
  } = useDataStore();

  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [projectFilter, setProjectFilter] = useState<string>('all');

  // Modals
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [isDeductModalOpen, setIsDeductModalOpen] = useState(false);
  const [selectedAdvance, setSelectedAdvance] = useState<Advance | null>(null);
  const [deductionAmount, setDeductionAmount] = useState('');

  // Form State
  const [formData, setFormData] = useState({
    worker_id: '',
    project_id: '',
    amount: '',
    reason: '',
    date: new Date().toISOString().split('T')[0],
  });

  const formatPHP = formatPesoCompact;

  const projectScopedAdvances =
    projectFilter === 'all'
      ? advances
      : advances.filter((adv) => adv.project_id === projectFilter);

  const filteredAdvances = projectScopedAdvances.filter((adv) => {
    const worker = workers.find((w) => w.id === adv.worker_id);
    const proj = projects.find((p) => p.id === adv.project_id);

    const matchesSearch =
      worker?.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      adv.reason.toLowerCase().includes(searchQuery.toLowerCase()) ||
      proj?.name.toLowerCase().includes(searchQuery.toLowerCase());

    const matchesStatus = statusFilter === 'all' || adv.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const totalOutstandingBale = projectScopedAdvances
    .filter((a) => a.status === 'active' || a.status === 'partially_deducted')
    .reduce((sum, a) => sum + (a.amount - a.amount_deducted), 0);

  const handleAddSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.worker_id || !formData.project_id || !formData.amount) return;

    const created = await createAdvance({
      worker_id: formData.worker_id,
      project_id: formData.project_id,
      amount: parseFloat(formData.amount),
      reason: formData.reason || 'Personal cash advance (Bale)',
      date: formData.date,
    });

    if (created) {
      setIsAddModalOpen(false);
      setFormData({
        worker_id: '',
        project_id: '',
        amount: '',
        reason: '',
        date: new Date().toISOString().split('T')[0],
      });
    }
  };

  const handleDeductSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedAdvance || !deductionAmount) return;

    const success = await recordAdvanceDeduction(selectedAdvance.id, parseFloat(deductionAmount));
    if (success) {
      setIsDeductModalOpen(false);
      setDeductionAmount('');
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
                Worker Advance Ledger
              </span>
              <span className="text-xs text-ink-muted">·</span>
              <span className="text-xs text-ink-secondary">Bale Tracking & Payroll Sync</span>
            </div>
            <h1 className="text-2xl sm:text-3xl font-extrabold text-navy tracking-tight mt-1">
              Worker Advances (&ldquo;Bale&rdquo;)
            </h1>
          </div>

          <Button
            variant="primary"
            size="md"
            onClick={() => setIsAddModalOpen(true)}
            leftIcon={<Plus className="w-4 h-4" />}
          >
            Record Worker Bale
          </Button>
        </div>

        {/* Bale Overview Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 auto-rows-fr">
          <div className="h-full p-5 rounded-2xl bg-white border border-surface-border shadow-sm flex flex-col justify-between">
            <div className="text-xs font-semibold text-ink-secondary uppercase truncate">Active Bale Balance</div>
            <div className="text-2xl font-bold text-navy mt-1 tabular-nums truncate">{formatPHP(totalOutstandingBale)}</div>
          </div>

          <div className="h-full p-5 rounded-2xl bg-white border border-surface-border shadow-sm flex flex-col justify-between">
            <div className="text-xs font-semibold text-ink-secondary uppercase truncate">Workers with Advances</div>
            <div className="text-2xl font-bold text-navy mt-1 tabular-nums">
              {new Set(projectScopedAdvances.filter((a) => a.status === 'active' || a.status === 'partially_deducted').map((a) => a.worker_id)).size}
            </div>
          </div>

          <div className="h-full p-5 rounded-2xl bg-white border border-surface-border shadow-sm flex flex-col justify-between">
            <div className="text-xs font-semibold text-ink-secondary uppercase truncate">Total Repaid to Date</div>
            <div className="text-2xl font-bold text-status-success mt-1 tabular-nums truncate">
              {formatPHP(projectScopedAdvances.reduce((sum, a) => sum + Number(a.amount_deducted || 0), 0))}
            </div>
          </div>
        </div>

        {/* Filters */}
        <div className="flex flex-col sm:flex-row flex-wrap items-center gap-3">
          <div className="w-full sm:w-80">
            <Input
              placeholder="Search worker name, reason, project..."
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
                { label: 'Active', value: 'active' },
                { label: 'Partially Deducted', value: 'partially_deducted' },
                { label: 'Fully Deducted', value: 'fully_deducted' },
              ]}
            />
          </div>
        </div>

        {/* Advances List */}
        <div className="bg-white rounded-3xl border border-surface-border shadow-[6px_6px_18px_rgba(11,31,58,0.06),-6px_-6px_18px_rgba(255,255,255,0.95)] overflow-hidden">
          <div className="divide-y divide-surface-border/70">
            {filteredAdvances.map((adv) => {
              const worker = workers.find((w) => w.id === adv.worker_id);
              const proj = projects.find((p) => p.id === adv.project_id);
              const balance = adv.amount - adv.amount_deducted;

              const statusBadgeVariant =
                adv.status === 'fully_deducted'
                  ? 'success'
                  : adv.status === 'partially_deducted'
                  ? 'warning'
                  : 'navy';

              return (
                <div
                  key={adv.id}
                  className="p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4 hover:bg-slate-50/60 transition-colors"
                >
                  {/* Left: Worker & Reason */}
                  <div className="space-y-1">
                    <div className="flex items-center space-x-2">
                      <span className="font-bold text-sm text-navy">{worker?.name}</span>
                      <span className="text-xs text-ink-secondary">({worker?.position})</span>
                      <Badge variant={statusBadgeVariant} size="sm">
                        {adv.status.replace('_', ' ')}
                      </Badge>
                    </div>

                    <div className="text-xs text-ink-primary font-medium">{adv.reason}</div>

                    <div className="text-xs text-ink-secondary">
                      Site: <span className="font-semibold text-navy">{proj?.name}</span> · Date Given: {adv.date}
                    </div>
                  </div>

                  {/* Middle: Amount & Deductions */}
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 text-xs py-2 lg:py-0">
                    <div>
                      <div className="text-ink-secondary">Original Advance</div>
                      <div className="font-bold text-navy text-sm mt-0.5">{formatPHP(adv.amount)}</div>
                    </div>

                    <div>
                      <div className="text-ink-secondary">Deducted</div>
                      <div className="font-semibold text-status-success text-sm mt-0.5">
                        {formatPHP(adv.amount_deducted)}
                      </div>
                    </div>

                    <div>
                      <div className="text-ink-secondary">Remaining Balance</div>
                      <div className={`font-bold text-sm mt-0.5 ${balance > 0 ? 'text-status-warning' : 'text-slate-400'}`}>
                        {formatPHP(balance)}
                      </div>
                    </div>
                  </div>

                  {/* Right Actions */}
                  <div className="flex items-center space-x-2">
                    {balance > 0 && (
                      <Button
                        variant="soft"
                        size="sm"
                        onClick={() => {
                          setSelectedAdvance(adv);
                          setDeductionAmount(String(Math.min(balance, 1500)));
                          setIsDeductModalOpen(true);
                        }}
                        leftIcon={<TrendingDown className="w-3.5 h-3.5" />}
                      >
                        Record Deduction
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}

            {filteredAdvances.length === 0 && (
              <div className="p-12 text-center text-xs text-ink-secondary">
                No advances found matching current criteria.
              </div>
            )}
          </div>
        </div>
      </div>

      {/* RECORD BALE MODAL */}
      <Modal
        isOpen={isAddModalOpen}
        onClose={() => setIsAddModalOpen(false)}
        title="Record Worker Advance (Bale)"
        description="Log an advance disbursement. This will be automatically factored into upcoming payroll deductions."
        maxWidth="lg"
      >
        <form onSubmit={handleAddSubmit} className="space-y-4 text-xs">
          <Select
            label="Worker Recipient"
            value={formData.worker_id}
            onChange={(e) => setFormData({ ...formData, worker_id: e.target.value })}
            required
          >
            <option value="">Select Worker...</option>
            {workers.filter((w) => w.active).map((w) => (
              <option key={w.id} value={w.id}>
                {w.name} — {w.position} (₱{w.pay_rate}/day)
              </option>
            ))}
          </Select>

          <Select
            label="Project Site"
            value={formData.project_id}
            onChange={(e) => setFormData({ ...formData, project_id: e.target.value })}
            required
          >
            <option value="">Select Project...</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>

          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Advance Amount (PHP ₱)"
              type="number"
              placeholder="2000"
              value={formData.amount}
              onChange={(e) => setFormData({ ...formData, amount: e.target.value })}
              required
            />

            <Input
              label="Disbursement Date"
              type="date"
              value={formData.date}
              onChange={(e) => setFormData({ ...formData, date: e.target.value })}
              required
            />
          </div>

          <Input
            label="Reason / Purpose"
            placeholder="e.g. Emergency family medical assistance, motorcycle maintenance"
            value={formData.reason}
            onChange={(e) => setFormData({ ...formData, reason: e.target.value })}
            required
          />

          <div className="pt-3 flex justify-end space-x-2">
            <Button variant="secondary" onClick={() => setIsAddModalOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" type="submit">
              Log Advance into Ledger
            </Button>
          </div>
        </form>
      </Modal>

      {/* MANUAL DEDUCTION MODAL */}
      <Modal
        isOpen={isDeductModalOpen}
        onClose={() => setIsDeductModalOpen(false)}
        title="Record Manual Bale Repayment / Deduction"
        description="Manually deduct an amount from this worker's active bale balance."
      >
        {selectedAdvance && (
          <form onSubmit={handleDeductSubmit} className="space-y-4 text-xs">
            <div className="p-3.5 rounded-xl bg-surface-inset border border-surface-border space-y-1">
              <div className="font-bold text-navy">
                {workers.find((w) => w.id === selectedAdvance.worker_id)?.name}
              </div>
              <div className="text-ink-secondary">
                Original Advance: {formatPHP(selectedAdvance.amount)}
              </div>
              <div className="font-semibold text-status-warning">
                Outstanding Balance: {formatPHP(selectedAdvance.amount - selectedAdvance.amount_deducted)}
              </div>
            </div>

            <Input
              label="Deduction Amount (PHP ₱)"
              type="number"
              value={deductionAmount}
              onChange={(e) => setDeductionAmount(e.target.value)}
              required
              min="1"
              max={selectedAdvance.amount - selectedAdvance.amount_deducted}
            />

            <div className="pt-2 flex justify-end space-x-2">
              <Button variant="secondary" onClick={() => setIsDeductModalOpen(false)}>
                Cancel
              </Button>
              <Button variant="primary" type="submit">
                Apply Deduction
              </Button>
            </div>
          </form>
        )}
      </Modal>
    </AppShell>
  );
}
