'use client';

import React, { useMemo, useState } from 'react';
import { useAuth } from '@/lib/auth/authContext';
import { useDataStore } from '@/lib/data/store';
import type { AdvanceRequestStatus } from '@/types';
import { formatDatePH, formatPesoCompact } from '@/lib/email/format';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Modal } from '@/components/ui/Modal';
import { Check, HandCoins, X } from 'lucide-react';

function requestStatusLabel(status: AdvanceRequestStatus): string {
  if (status === 'pending_approval') return 'Awaiting approval';
  if (status === 'approved_pending_payment') return 'Approved · awaiting payment';
  if (status === 'issued') return 'Issued';
  return 'Rejected';
}

function requestStatusVariant(status: AdvanceRequestStatus) {
  if (status === 'pending_approval') return 'warning';
  if (status === 'approved_pending_payment') return 'info';
  if (status === 'issued') return 'success';
  return 'neutral';
}

export function AdvanceRequestsPanel() {
  const { user, isFounder, isSupervisor } = useAuth();
  const {
    advanceRequests,
    projects,
    workers,
    users,
    getProjectsForSupervisor,
    createAdvanceRequest,
    reviewAdvanceRequest,
    issueAdvanceRequest,
  } = useDataStore();

  const [requestModalOpen, setRequestModalOpen] = useState(false);
  const [selectedWorkerId, setSelectedWorkerId] = useState('');
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [requestedAmount, setRequestedAmount] = useState('');
  const [requestFilter, setRequestFilter] = useState<'open' | 'all'>('open');
  const [actioningRequestId, setActioningRequestId] = useState<string | null>(null);
  const [requestToIssue, setRequestToIssue] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const accessibleProjects = useMemo(
    () => (isFounder ? projects : user ? getProjectsForSupervisor(user.id) : []),
    [isFounder, projects, user, getProjectsForSupervisor]
  );
  const activeWorkers = workers.filter((worker) => worker.active);
  const pendingApprovalCount = advanceRequests.filter(
    (request) => request.status === 'pending_approval'
  ).length;
  const approvedPendingPaymentCount = advanceRequests.filter(
    (request) => request.status === 'approved_pending_payment'
  ).length;
  const visibleRequests = advanceRequests.filter((request) => {
    if (requestFilter === 'all') return true;
    return request.status === 'pending_approval' || request.status === 'approved_pending_payment';
  });

  const openRequestModal = () => {
    setSelectedWorkerId('');
    setSelectedProjectId(accessibleProjects.length === 1 ? accessibleProjects[0].id : '');
    setRequestedAmount('');
    setRequestModalOpen(true);
  };

  const handleSubmitRequest = async (event: React.FormEvent) => {
    event.preventDefault();
    const amount = Number(requestedAmount);
    if (!selectedWorkerId || !selectedProjectId || !Number.isFinite(amount) || amount <= 0) return;

    setIsSubmitting(true);
    const created = await createAdvanceRequest({
      worker_id: selectedWorkerId,
      project_id: selectedProjectId,
      requested_amount: amount,
    });
    setIsSubmitting(false);
    if (created) setRequestModalOpen(false);
  };

  const handleReview = async (id: string, decision: 'approve' | 'reject') => {
    setActioningRequestId(id);
    await reviewAdvanceRequest(id, decision);
    setActioningRequestId(null);
  };

  const handleIssue = async () => {
    if (!requestToIssue) return;
    setActioningRequestId(requestToIssue);
    const issued = await issueAdvanceRequest(requestToIssue);
    setActioningRequestId(null);
    if (issued) setRequestToIssue(null);
  };

  return (
    <div className="space-y-4">
      <div
        className={`flex flex-col gap-3 rounded-2xl border p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5 ${
          isSupervisor
            ? 'border-brand/15 bg-gradient-to-br from-white via-white to-brand/5'
            : 'border-surface-border bg-white'
        }`}
      >
        <div className="flex min-w-0 items-start gap-3">
          {isSupervisor && (
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-brand/10 bg-brand/5 text-brand">
              <HandCoins className="h-5 w-5" aria-hidden="true" />
            </span>
          )}
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-navy">
              {isFounder ? 'Advance request queue' : 'Request a worker Bale'}
            </h2>
            <p className="mt-1 max-w-2xl text-xs leading-relaxed text-ink-secondary">
              {isFounder
                ? 'Review requests first, then confirm payment only after the money is issued.'
                : 'Choose a worker and amount. Your project is added automatically when you have one assigned; select it if you supervise more than one. No reason or note is needed.'}
            </p>
          </div>
        </div>

        {isSupervisor && (
          <Button
            type="button"
            variant="primary"
            size="sm"
            className="w-full shrink-0 sm:w-auto"
            onClick={openRequestModal}
            disabled={accessibleProjects.length === 0 || activeWorkers.length === 0}
          >
            New Bale Request
          </Button>
        )}
      </div>

      {isSupervisor && (
        <div className="rounded-2xl border border-surface-border bg-white p-4 sm:p-5">
          <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-ink-muted">How it works</p>
          <ol className="mt-3 grid gap-3 sm:grid-cols-3">
            <li className="flex items-start gap-2.5">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand/10 text-[11px] font-bold text-brand">
                1
              </span>
              <div className="min-w-0">
                <p className="text-xs font-semibold text-navy">Send the request</p>
                <p className="mt-0.5 text-[11px] leading-relaxed text-ink-secondary">
                  Select a worker and enter the amount.
                </p>
              </div>
            </li>
            <li className="flex items-start gap-2.5">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand/10 text-[11px] font-bold text-brand">
                2
              </span>
              <div className="min-w-0">
                <p className="text-xs font-semibold text-navy">Founder reviews it</p>
                <p className="mt-0.5 text-[11px] leading-relaxed text-ink-secondary">
                  It stays a request while waiting.
                </p>
              </div>
            </li>
            <li className="flex items-start gap-2.5">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand/10 text-[11px] font-bold text-brand">
                3
              </span>
              <div className="min-w-0">
                <p className="text-xs font-semibold text-navy">Payment is confirmed</p>
                <p className="mt-0.5 text-[11px] leading-relaxed text-ink-secondary">
                  Only then is it recorded as an issued advance.
                </p>
              </div>
            </li>
          </ol>
        </div>
      )}

      {isSupervisor && (accessibleProjects.length === 0 || activeWorkers.length === 0) && (
        <p className="rounded-lg border border-status-warning/20 bg-status-warning-bg/50 px-3 py-2 text-xs leading-relaxed text-ink-secondary">
          {accessibleProjects.length === 0
            ? 'No assigned project is available for this account yet. Ask the Founder to assign a project before submitting a request.'
            : 'No active workers are available. Ask the Founder to add or activate a worker first.'}
        </p>
      )}

      {isFounder && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Card className="p-4">
            <p className="text-xs font-medium text-ink-secondary">Awaiting approval</p>
            <p className="mt-1 text-xl font-semibold tabular-nums text-navy">{pendingApprovalCount}</p>
          </Card>
          <Card className="p-4">
            <p className="text-xs font-medium text-ink-secondary">Approved · awaiting payment</p>
            <p className="mt-1 text-xl font-semibold tabular-nums text-navy">{approvedPendingPaymentCount}</p>
          </Card>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2" aria-label="Advance request filters">
        <Button
          type="button"
          size="sm"
          variant={requestFilter === 'open' ? 'soft' : 'ghost'}
          aria-pressed={requestFilter === 'open'}
          onClick={() => setRequestFilter('open')}
        >
          {isFounder ? 'Needs action' : 'Open requests'}
          {isFounder && pendingApprovalCount + approvedPendingPaymentCount > 0 && (
            <span className="ml-1 rounded-full bg-status-warning-bg px-1.5 py-0.5 text-[10px] text-status-warning">
              {pendingApprovalCount + approvedPendingPaymentCount}
            </span>
          )}
        </Button>
        <Button
          type="button"
          size="sm"
          variant={requestFilter === 'all' ? 'soft' : 'ghost'}
          aria-pressed={requestFilter === 'all'}
          onClick={() => setRequestFilter('all')}
        >
          All requests
        </Button>
      </div>

      {visibleRequests.length === 0 ? (
        <Card className="p-8 text-center">
          <HandCoins className="mx-auto h-7 w-7 text-ink-muted" aria-hidden="true" />
          <p className="mt-2 text-sm font-semibold text-navy">
            {requestFilter === 'open'
              ? isFounder
                ? 'No requests need action'
                : 'No open requests'
              : 'No Bale requests yet'}
          </p>
          <p className="mt-1 text-xs text-ink-secondary">
            {isSupervisor
              ? accessibleProjects.length === 0
                ? 'Ask the Founder to assign a project before submitting a request.'
                : activeWorkers.length === 0
                  ? 'Ask the Founder to add or activate a worker first.'
                  : 'Use “New Bale Request” to submit a worker’s requested amount.'
              : 'New Supervisor submissions will appear in this queue.'}
          </p>
        </Card>
      ) : (
        <div className="overflow-hidden rounded-xl border border-surface-border bg-white">
          <div className="divide-y divide-surface-border/70">
            {visibleRequests.map((request) => {
              const worker = workers.find((item) => item.id === request.worker_id);
              const project = projects.find((item) => item.id === request.project_id);
              const submitter = users.find((item) => item.id === request.submitted_by);
              const isActioning = actioningRequestId === request.id;

              return (
                <article key={request.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="break-words text-sm font-semibold text-navy">
                        {worker?.name || 'Worker'}
                      </span>
                      <Badge size="sm" variant={requestStatusVariant(request.status)}>
                        {requestStatusLabel(request.status)}
                      </Badge>
                    </div>
                    <p className="break-words text-xs text-ink-secondary">
                      {project?.name || 'Project'} · Requested {formatDatePH(request.created_at)}
                    </p>
                    {isFounder && (
                      <p className="break-words text-[11px] text-ink-muted">
                        Submitted by {submitter?.name || 'Supervisor'}
                      </p>
                    )}
                  </div>

                  <div className="flex flex-col gap-3 sm:items-end">
                    <p className="text-base font-semibold tabular-nums text-navy">
                      {formatPesoCompact(request.requested_amount)}
                    </p>
                    {isFounder && request.status === 'pending_approval' && (
                      <div className="flex flex-wrap gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          disabled={isActioning}
                          onClick={() => handleReview(request.id, 'reject')}
                          leftIcon={<X className="h-3.5 w-3.5" />}
                        >
                          Reject
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="primary"
                          disabled={isActioning}
                          onClick={() => handleReview(request.id, 'approve')}
                          leftIcon={<Check className="h-3.5 w-3.5" />}
                        >
                          Approve
                        </Button>
                      </div>
                    )}
                    {isFounder && request.status === 'approved_pending_payment' && (
                      <Button
                        type="button"
                        size="sm"
                        variant="primary"
                        disabled={isActioning}
                        onClick={() => setRequestToIssue(request.id)}
                        leftIcon={<Check className="h-3.5 w-3.5" />}
                      >
                        Confirm paid &amp; issue
                      </Button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      )}

      <Modal
        isOpen={requestModalOpen}
        onClose={() => setRequestModalOpen(false)}
        title="New Bale Request"
        description="Choose the worker and amount requested. Your assigned project is attached automatically when there is one, or select a site if you supervise multiple projects."
        maxWidth="md"
      >
        <form onSubmit={handleSubmitRequest} className="space-y-4 text-xs">
          <Select
            label="Worker"
            value={selectedWorkerId}
            onChange={(event) => setSelectedWorkerId(event.target.value)}
            required
          >
            <option value="">Select a worker</option>
            {activeWorkers.map((worker) => (
              <option key={worker.id} value={worker.id}>
                {worker.name} · {worker.position}
              </option>
            ))}
          </Select>

          {accessibleProjects.length === 1 ? (
            <div className="rounded-lg border border-surface-border bg-surface-inset px-3 py-2.5">
              <p className="text-[11px] font-medium text-ink-secondary">Assigned project</p>
              <p className="mt-0.5 break-words text-sm font-semibold text-navy">
                {accessibleProjects[0].name}
              </p>
            </div>
          ) : (
            <Select
              label="Project site"
              value={selectedProjectId}
              onChange={(event) => setSelectedProjectId(event.target.value)}
              required
            >
              <option value="">Select an assigned project</option>
              {accessibleProjects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </Select>
          )}

          <Input
            label="Requested amount (₱)"
            type="number"
            min="1"
            step="0.01"
            placeholder="2000"
            value={requestedAmount}
            onChange={(event) => setRequestedAmount(event.target.value)}
            required
          />

          <p className="rounded-lg bg-surface-inset px-3 py-2 text-[11px] leading-relaxed text-ink-secondary">
            This submits a request only. It does not add an issued advance or change payroll until the Founder confirms payment.
          </p>

          <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="secondary" onClick={() => setRequestModalOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" isLoading={isSubmitting}>
              Send to Founder
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        isOpen={Boolean(requestToIssue)}
        onClose={() => setRequestToIssue(null)}
        title="Confirm Bale payment"
        description="Use this only after the requested amount has actually been given to the worker."
      >
        {requestToIssue && (() => {
          const request = advanceRequests.find((item) => item.id === requestToIssue);
          const worker = request ? workers.find((item) => item.id === request.worker_id) : null;
          if (!request) return null;

          return (
            <div className="space-y-4 text-xs">
              <div className="rounded-xl border border-surface-border bg-surface-inset p-3.5">
                <div className="font-semibold text-navy">{worker?.name || 'Worker'}</div>
                <div className="mt-1 text-ink-secondary">
                  {formatPesoCompact(request.requested_amount)} · {projects.find((project) => project.id === request.project_id)?.name || 'Project'}
                </div>
              </div>
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button type="button" variant="secondary" onClick={() => setRequestToIssue(null)}>
                  Not yet
                </Button>
                <Button
                  type="button"
                  variant="primary"
                  onClick={handleIssue}
                  isLoading={actioningRequestId === request.id}
                  leftIcon={<Check className="h-3.5 w-3.5" />}
                >
                  Confirm paid &amp; issue
                </Button>
              </div>
            </div>
          );
        })()}
      </Modal>
    </div>
  );
}
