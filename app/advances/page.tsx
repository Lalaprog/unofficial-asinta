'use client';

import React, { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { AppShell } from '@/components/layout/AppShell';
import { AdvanceRequestsPanel } from '@/components/advances/AdvanceRequestsPanel';
import { useAuth } from '@/lib/auth/authContext';
import { useQuickAction } from '@/lib/mobile/quickActions';
import { useDataStore } from '@/lib/data/store';
import { Advance } from '@/types';
import {
  Plus,
  Search,
  TrendingDown,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { FilterSummary } from '@/components/ui/FilterSummary';
import { WorkspaceHeader } from '@/components/ui/WorkspaceHeader';
import { EmptyState } from '@/components/ui/EmptyState';
import { WorkspaceFilters } from '@/components/ui/WorkspaceFilters';
import { useToast } from '@/components/ui/Toast';
import { Badge } from '@/components/ui/Badge';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Modal } from '@/components/ui/Modal';
import { formatPeso, formatPesoCompact } from '@/lib/email/format';

export default function AdvancesPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-48 px-4 py-8 text-center text-sm text-ink-secondary">
          Loading Bale requests…
        </div>
      }
    >
      <AdvancesPageContent />
    </Suspense>
  );
}

function AdvancesPageContent() {
  const { isFounder, assurance, isLoading: authLoading } = useAuth();
  const { isLoaded } = useDataStore();
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeTab = isFounder && searchParams?.get('tab') === 'issued' ? 'issued' : 'requests';
  const [quickBale, setQuickBale] = useState(false);
  useQuickAction('/advances', ['bale'], isFounder && assurance === 'ready' && !authLoading && isLoaded, () => {
    setQuickBale(true);
    router.replace('/advances?tab=issued', { scroll: false });
  });

  const selectTab = (tab: 'requests' | 'issued') => {
    router.replace(`/advances?tab=${tab}`, { scroll: false });
  };

  return (
    <AppShell>
      <div className="w-full space-y-5">
        <WorkspaceHeader
          eyebrow="Workforce & pay"
          title={isFounder ? 'Bale Requests & Advances' : 'Bale Requests'}
          description={isFounder ? 'Review worker requests and keep issued advance balances separate.' : 'Submit a worker’s requested amount for Founder review.'}
        />

        {isFounder && (
          <div data-page-guide="tabs" className="flex flex-wrap gap-2" role="group" aria-label="Bale request and advance views">
            <button
              type="button"
              id="advances-requests-tab"
              aria-controls="advances-panel"
              aria-pressed={activeTab === 'requests'}
              onClick={() => selectTab('requests')}
              className={`min-h-11 rounded-lg px-4 text-xs font-semibold transition-[color,background-color,border-color,transform] duration-200 motion-safe:active:scale-[0.96] sm:motion-safe:active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${
                activeTab === 'requests'
                  ? 'bg-navy text-white'
                  : 'border border-surface-border bg-white text-ink-secondary hover:bg-surface-inset hover:text-navy'
              }`}
            >
              Requests
            </button>
            <button
              type="button"
              id="advances-issued-tab"
              aria-controls="advances-panel"
              aria-pressed={activeTab === 'issued'}
              onClick={() => selectTab('issued')}
              className={`min-h-11 rounded-lg px-4 text-xs font-semibold transition-[color,background-color,border-color,transform] duration-200 motion-safe:active:scale-[0.96] sm:motion-safe:active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${
                activeTab === 'issued'
                  ? 'bg-navy text-white'
                  : 'border border-surface-border bg-white text-ink-secondary hover:bg-surface-inset hover:text-navy'
              }`}
            >
              Issued advances
            </button>
          </div>
        )}

        <div
          data-page-guide="list"
          id="advances-panel"
          aria-label={isFounder ? (activeTab === 'requests' ? 'Requests' : 'Issued advances') : undefined}
        >
          {activeTab === 'requests' ? (
            <div key="requests" className="animate-panel-enter"><AdvanceRequestsPanel /></div>
          ) : (
            <div key="issued" className="animate-panel-enter"><IssuedAdvancesPanel openQuick={quickBale} onQuickOpened={() => setQuickBale(false)} /></div>
          )}
        </div>
      </div>
    </AppShell>
  );
}

function IssuedAdvancesPanel({ openQuick, onQuickOpened }: { openQuick: boolean; onQuickOpened: () => void }) {
  const { showToast } = useToast();
  const [isAdding, setIsAdding] = useState(false);
  const [isDeducting, setIsDeducting] = useState(false);
  const addLock = React.useRef(false);
  const deductLock = React.useRef(false);
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
  React.useEffect(() => { if (openQuick) { setIsAddModalOpen(true); onQuickOpened(); } }, [openQuick, onQuickOpened]);
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
    if (addLock.current || !formData.worker_id || !formData.project_id || !formData.amount) return;
    addLock.current = true;
    setIsAdding(true);
    try {
      const created = await createAdvance({
        worker_id: formData.worker_id,
        project_id: formData.project_id,
        amount: parseFloat(formData.amount),
        reason: formData.reason || 'Personal cash advance (Bale)',
        date: formData.date,
      });

      if (created) {
        showToast('success', 'Advance recorded.');
        setIsAddModalOpen(false);
        setFormData({
          worker_id: '',
          project_id: '',
          amount: '',
          reason: '',
          date: new Date().toISOString().split('T')[0],
        });
      } else {
        showToast('error', 'Advance not confirmed. Check the ledger before trying again.');
      }
    } catch {
      showToast('error', 'Advance not confirmed. Check the ledger before trying again.');
    } finally {
      addLock.current = false;
      setIsAdding(false);
    }
  };

  const handleDeductSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (deductLock.current || !selectedAdvance || !deductionAmount) return;
    deductLock.current = true;
    setIsDeducting(true);
    try {
      const success = await recordAdvanceDeduction(selectedAdvance.id, parseFloat(deductionAmount));
      if (success) {
        showToast('success', 'Deduction recorded.');
        setIsDeductModalOpen(false);
        setDeductionAmount('');
      } else {
        showToast('error', 'Deduction not confirmed. Close this dialog and check the refreshed balance and audit history before retrying; manual deductions can be duplicated.');
      }
    } catch {
      showToast('error', 'Deduction not confirmed. Close this dialog and check the refreshed balance and audit history before retrying; manual deductions can be duplicated.');
    } finally {
      deductLock.current = false;
      setIsDeducting(false);
    }
  };

  return (
    <div className="space-y-6">
        {/* Header */}
        <div className="animate-mobile-lift flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-surface-border/60">
          <div>
            <h2 className="text-lg sm:text-xl font-semibold text-navy tracking-tight">
              Worker Advances (&ldquo;Bale&rdquo;)
            </h2>
            <p className="text-xs text-ink-secondary mt-0.5">
              Track issued advances, recorded deductions and outstanding balances
            </p>
          </div>

          <Button
            variant="primary"
            size="sm"
            onClick={() => setIsAddModalOpen(true)}
            leftIcon={<Plus className="w-4 h-4" />}
          >
            Record Bale
          </Button>
        </div>

        {/* Bale Overview Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 auto-rows-fr">
          <div className="h-full p-4 sm:p-5 rounded-xl bg-white border border-surface-border flex flex-col justify-between">
            <div className="text-xs font-medium text-ink-secondary">Active Bale Balance</div>
            <div className="font-serif text-2xl font-semibold text-navy mt-1 tabular-nums break-words">{formatPHP(totalOutstandingBale)}</div>
          </div>

          <div className="h-full p-4 sm:p-5 rounded-xl bg-white border border-surface-border flex flex-col justify-between">
            <div className="text-xs font-medium text-ink-secondary">Workers with Advances</div>
            <div className="text-2xl font-bold text-navy mt-1 tabular-nums">
              {new Set(projectScopedAdvances.filter((a) => a.status === 'active' || a.status === 'partially_deducted').map((a) => a.worker_id)).size}
            </div>
          </div>

          <div className="h-full p-4 sm:p-5 rounded-xl bg-white border border-surface-border flex flex-col justify-between">
            <div className="text-xs font-medium text-ink-secondary">Deductions recorded (all statuses)</div>
            <div className="font-serif text-2xl font-semibold text-status-success mt-1 tabular-nums break-words">
              {formatPHP(projectScopedAdvances.reduce((sum, a) => sum + Number(a.amount_deducted || 0), 0))}
            </div>
          </div>
        </div>

        <p className="text-xs leading-relaxed text-ink-secondary">Summary reflects loaded advances for the selected project; older records may be missing. Search and status filters apply to the list below.</p>

        <WorkspaceFilters title="Find an issued advance" summary={<FilterSummary count={filteredAdvances.length} itemName="advance" active={Boolean(searchQuery) || projectFilter !== 'all' || statusFilter !== 'all'} onClear={() => { setSearchQuery(''); setProjectFilter('all'); setStatusFilter('all'); }} />}>
          <div className="flex flex-col sm:flex-row flex-wrap sm:items-end gap-3">
            <div className="w-full sm:w-80">
              <Input
                label="Search advances"
                placeholder="Search worker name, reason, project..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                leftIcon={<Search className="w-4 h-4" />}
              />
            </div>

            <div className="w-full sm:w-64">
              <Select
                label="Project"
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
                label="Status"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                options={[
                  { label: 'All Statuses', value: 'all' },
                  { label: 'Active', value: 'active' },
                  { label: 'Partially Deducted', value: 'partially_deducted' },
                  { label: 'Fully Deducted', value: 'fully_deducted' },
                  { label: 'Cancelled', value: 'cancelled' },
                ]}
              />
            </div>
          </div>
        </WorkspaceFilters>

        {/* Advances List */}
        <div className="bg-white rounded-xl border border-surface-border overflow-hidden">
          <div className="divide-y divide-surface-border/70">
            {filteredAdvances.map((adv) => {
              const worker = workers.find((w) => w.id === adv.worker_id);
              const proj = projects.find((p) => p.id === adv.project_id);
              const balance = adv.amount - adv.amount_deducted;

              const canRecordDeduction = balance > 0 && (adv.status === 'active' || adv.status === 'partially_deducted');
              const statusBadgeVariant =
                adv.status === 'fully_deducted'
                  ? 'success'
                  : adv.status === 'partially_deducted'
                  ? 'warning'
                  : adv.status === 'cancelled'
                  ? 'neutral'
                  : 'navy';

              return (
                <div
                  key={adv.id}
                  className="p-4 sm:p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4 hover:bg-surface transition-colors"
                >
                  {/* Left: Worker & Reason */}
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-center space-x-2">
                      <span className="font-bold text-sm text-navy">{worker?.name}</span>
                      <span className="text-xs text-ink-secondary">({worker?.position})</span>
                      <Badge variant={statusBadgeVariant} size="sm">
                        {{active: 'Active', partially_deducted: 'Partially deducted', fully_deducted: 'Fully deducted', cancelled: 'Cancelled'}[adv.status]}
                      </Badge>
                    </div>

                    <div className="break-words text-xs text-ink-primary font-medium">{adv.reason}</div>

                    <div className="break-words text-xs text-ink-secondary">
                      Site: <span className="font-semibold text-navy">{proj?.name}</span> · Date Given: {adv.date}
                    </div>
                  </div>

                  {/* Middle: Amount & Deductions */}
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 text-xs py-2 lg:py-0">
                    <div>
                      <div className="text-ink-secondary">Original Advance</div>
                      <div className="font-bold text-navy text-sm mt-0.5">{formatPeso(adv.amount)}</div>
                    </div>

                    <div>
                      <div className="text-ink-secondary">Deducted</div>
                      <div className="font-semibold text-status-success text-sm mt-0.5">
                        {formatPeso(adv.amount_deducted)}
                      </div>
                    </div>

                    <div>
                      <div className="text-ink-secondary">{adv.status === 'cancelled' ? 'Undeducted amount (cancelled)' : 'Remaining Balance'}</div>
                      <div className={`font-bold text-sm mt-0.5 ${balance > 0 ? 'text-status-warning' : 'text-slate-400'}`}>
                        {formatPeso(balance)}
                      </div>
                    </div>
                  </div>

                  {/* Right Actions */}
                  <div className="flex items-center space-x-2">
                    {canRecordDeduction && (
                      <Button
                        variant="soft"
                        size="sm"
                        onClick={() => {
                          setSelectedAdvance(adv);
                          setDeductionAmount('');
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
              <EmptyState title={advances.length === 0 ? 'No advances yet' : 'No advances match'} description={advances.length === 0 ? 'No issued advances have been recorded yet.' : 'No advances match the current search or filters. Clear filters to see all advances.'} />
            )}
          </div>
        </div>

      {/* RECORD BALE MODAL */}
      <Modal
        isOpen={isAddModalOpen}
        onClose={() => setIsAddModalOpen(false)}
        dismissOnBackdrop={!isAdding}
        dismissOnEscape={!isAdding}
        showCloseButton={!isAdding}
        title="Record Worker Advance (Bale)"
        description="Record money already given to the worker as an issued advance. Eligible balances may be considered when generating payroll; this does not transfer money."
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
              min="0.01"
              step="0.01"
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
            <Button type="button" variant="secondary" onClick={() => setIsAddModalOpen(false)} disabled={isAdding}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" isLoading={isAdding}>
              {isAdding ? 'Recording advance…' : 'Log Advance into Ledger'}
            </Button>
          </div>
        </form>
      </Modal>

      {/* MANUAL DEDUCTION MODAL */}
      <Modal
        isOpen={isDeductModalOpen}
        onClose={() => setIsDeductModalOpen(false)}
        dismissOnBackdrop={!isDeducting}
        dismissOnEscape={!isDeducting}
        showCloseButton={!isDeducting}
        title="Record Manual Bale Repayment / Deduction"
        description="Manually deduct an amount from this worker's active bale balance. If the result is unconfirmed, check the balance and audit history before retrying."
      >
        {selectedAdvance && (
          <form onSubmit={handleDeductSubmit} className="space-y-4 text-xs">
            <div className="p-3.5 rounded-xl bg-surface-inset border border-surface-border space-y-1">
              <div className="font-bold text-navy">
                {workers.find((w) => w.id === selectedAdvance.worker_id)?.name}
              </div>
              <div className="text-ink-secondary">
                Original Advance: {formatPeso(selectedAdvance.amount)}
              </div>
              <div className="font-semibold text-status-warning">
                Outstanding Balance: {formatPeso(selectedAdvance.amount - selectedAdvance.amount_deducted)}
              </div>
            </div>

            <Input
              label="Deduction Amount (PHP ₱)"
              type="number"
              value={deductionAmount}
              onChange={(e) => setDeductionAmount(e.target.value)}
              required
              min="0.01"
              step="0.01"
              max={selectedAdvance.amount - selectedAdvance.amount_deducted}
            />

            <div className="pt-2 flex justify-end space-x-2">
              <Button type="button" variant="secondary" onClick={() => setIsDeductModalOpen(false)} disabled={isDeducting}>
                Cancel
              </Button>
              <Button variant="primary" type="submit" isLoading={isDeducting}>
                {isDeducting ? 'Recording deduction…' : 'Apply Deduction'}
              </Button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}
