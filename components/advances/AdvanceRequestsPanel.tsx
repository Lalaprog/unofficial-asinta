'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/lib/auth/authContext';
import { useDataStore } from '@/lib/data/store';
import { useBaleProjectWorkers } from '@/lib/attendance/useBaleProjectWorkers';
import { useBaleRequestSubmissionGuard } from '@/lib/attendance/useBaleRequestSubmissionGuard';
import { getManilaClock } from '@/lib/reminders/scheduler';
import { workerPayrollPeriod } from '@/lib/payroll/periods';
import { useWeeklyBaleStatuses } from '@/lib/attendance/useWeeklyBaleStatuses';
import { useBaleReviewGuard } from '@/lib/attendance/useBaleReviewGuard';
import { selectedBaleDuplicateSignals } from '@/lib/attendance/baleDuplicateSignals';
import { weeklyBaleExpiryHealthPreviewEnabled, weeklyBaleReleasePreviewEnabled, weeklyBaleIdempotentSubmissionPreviewEnabled, weeklyWorkerCutoverMode } from '@/lib/finance/featureAvailability';
import { WeeklyBaleExpiryHealth } from '@/components/advances/WeeklyBaleExpiryHealth';
import type { AdvanceRequest, AdvanceRequestStatus } from '@/types';
import { formatDatePH, formatPeso, formatPesoCompact } from '@/lib/email/format';
import { useToast } from '@/components/ui/Toast';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Modal } from '@/components/ui/Modal';
import { Check, ChevronDown, HandCoins, X } from 'lucide-react';

function requestStatusLabel(status: AdvanceRequestStatus): string {
  if (status === 'pending_approval') return 'Awaiting approval';
  if (status === 'approved_pending_payment') return 'Approved · awaiting payment';
  if (status === 'issued') return 'Issued · payment confirmed';
  return 'Rejected';
}

// Describe the recorded request state only; this is not independent proof of
// a transfer and cannot rule out separate, manually recorded advances.
function requestStatusDescription(status: AdvanceRequestStatus): string {
  switch (status) {
    case 'pending_approval': return 'Waiting for the Founder’s decision. This request has not been issued.';
    case 'approved_pending_payment': return 'Approved, but payment and issue have not been confirmed.';
    case 'issued': return 'Payment confirmation and an issued advance were recorded.';
    case 'rejected': return 'Rejected. This request did not create an issued advance.';
  }
}

function requestActivity(request: AdvanceRequest): { label: string; date: string }[] {
  const entries = [{ label: 'Request submitted', date: request.created_at }];
  if ((request.status === 'approved_pending_payment' || request.status === 'issued') && request.approved_at) {
    entries.push({ label: 'Approval recorded', date: request.approved_at });
  }
  if (request.status === 'rejected' && request.rejected_at) entries.push({ label: 'Rejection recorded', date: request.rejected_at });
  if (request.status === 'issued' && request.issued_at) entries.push({ label: 'Issue confirmation recorded', date: request.issued_at });
  return entries;
}

function requestStatusVariant(status: AdvanceRequestStatus) {
  if (status === 'pending_approval') return 'warning';
  if (status === 'approved_pending_payment') return 'info';
  if (status === 'issued') return 'success';
  return 'neutral';
}

type FounderStatusFilter = 'needs_action' | AdvanceRequestStatus | 'all';

type SiteRequestGroup = {
  siteId: string;
  siteName: string;
  requests: AdvanceRequest[];
};

const MAX_BATCH_APPROVAL_SIZE = 50;

export function AdvanceRequestsPanel() {
  const { user, isFounder, isSupervisor } = useAuth();
  const { showToast } = useToast();
  const submitLock = React.useRef(false);
  const batchLock = React.useRef(false);
  const actionLock = React.useRef(false);
  const reviewLock = React.useRef(false);
  const {
    advanceRequests,
    baleRequestCoverage,
    projects,
    workers,
    users,
    getProjectsForSupervisor,
    createAdvanceRequest,
    reviewAdvanceRequest,
    approveAdvanceRequests,
    issueAdvanceRequest,
  } = useDataStore();
  const router = useRouter();
  const searchParams = useSearchParams();
  const siteFromUrl = searchParams?.get('site') || 'all';
  const requestFromUrl = searchParams?.get('request') || null;

  const [requestModalOpen, setRequestModalOpen] = useState(false);
  const [selectedWorkerId, setSelectedWorkerId] = useState('');
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [requestedAmount, setRequestedAmount] = useState('');
  const [requestFilter, setRequestFilter] = useState<'open' | 'all'>('open');
  const [founderStatusFilter, setFounderStatusFilter] = useState<FounderStatusFilter>('needs_action');
  const [siteFilter, setSiteFilter] = useState(siteFromUrl);
  const [focusedRequestId, setFocusedRequestId] = useState<string | null>(requestFromUrl);
  const [collapsedSiteIds, setCollapsedSiteIds] = useState<Set<string>>(() => new Set());
  const [requestSelection, setRequestSelection] = useState<{ siteId: string | null; ids: string[] }>({
    siteId: null,
    ids: [],
  });
  const [isBatchApprovalOpen, setIsBatchApprovalOpen] = useState(false);
  const [isApprovingBatch, setIsApprovingBatch] = useState(false);
  const [actioningRequestId, setActioningRequestId] = useState<string | null>(null);
  const [requestToIssue, setRequestToIssue] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => setSiteFilter(siteFromUrl), [siteFromUrl]);
  useEffect(() => setFocusedRequestId(requestFromUrl), [requestFromUrl]);

  const accessibleProjects = useMemo(
    () => (isFounder ? projects : user ? getProjectsForSupervisor(user.id) : []),
    [isFounder, projects, user, getProjectsForSupervisor]
  );
  const team = useBaleProjectWorkers(user?.id, selectedProjectId, isSupervisor && requestModalOpen);
  const weeklyMode = weeklyBaleReleasePreviewEnabled();
  const idempotentSubmission = weeklyBaleIdempotentSubmissionPreviewEnabled();
  const cutoverMode = weeklyWorkerCutoverMode();
  const submissionGuard = useBaleRequestSubmissionGuard(user?.id, weeklyMode && isSupervisor);
  const reviewGuard = useBaleReviewGuard(user?.id, weeklyMode && isFounder);
  const [reviewedUncertainDecision, setReviewedUncertainDecision] = useState(false);
  const reviewScope = JSON.stringify([user?.id,isFounder,weeklyMode]);
  const activeReviewScope = React.useRef(reviewScope); activeReviewScope.current=reviewScope;
  const panelMounted = React.useRef(false);
  useEffect(()=>{panelMounted.current=true;return()=>{panelMounted.current=false;};},[]);
  useEffect(()=>{setReviewedUncertainDecision(false);},[reviewScope,reviewGuard.raw]);
  const submissionScope = JSON.stringify([user?.id, isSupervisor, weeklyMode]);
  const activeSubmissionScope = React.useRef(submissionScope);
  activeSubmissionScope.current = submissionScope;
  const [reviewedUncertainSubmission, setReviewedUncertainSubmission] = useState(false);
  useEffect(() => { setReviewedUncertainSubmission(false); }, [user?.id, weeklyMode]);
  const weeklyStatuses = useWeeklyBaleStatuses(weeklyMode, user?.id, isFounder ? 'founder' : isSupervisor ? 'supervisor' : 'other', isFounder ? advanceRequests : advanceRequests.filter(r => r.submitted_by === user?.id));
  const statusFor = (request: AdvanceRequest) => weeklyStatuses.data?.items.find(item => item.id === request.id && item.stored_status === request.status);
  const canReview = (request: AdvanceRequest) => request.status === 'pending_approval' && (weeklyMode ? reviewGuard.status === 'ready' && statusFor(request)?.can_review === true : !cutoverMode);
  // Statuses are a point-in-time server snapshot; only the Supervisor's own
  // loaded rows can be checked here, and another request may still be in flight.
  const snapshotTime = weeklyStatuses.data?.as_of;
  const snapshotWeek = snapshotTime && Number.isFinite(Date.parse(snapshotTime))
    ? workerPayrollPeriod(getManilaClock(new Date(snapshotTime)).dateIso).start
    : null;
  const ownSameWeekRequests = weeklyMode && isSupervisor && selectedWorkerId && snapshotWeek
    ? advanceRequests.filter(request => {
      const status = statusFor(request);
      return request.submitted_by === user?.id && request.worker_id === selectedWorkerId && status?.kind === 'weekly' &&
        status.period_start === snapshotWeek && status.effective_status !== 'rejected' && status.effective_status !== 'expired_unapproved';
    })
    : [];
  const activeWorkers = team.status === 'ready' ? team.workers : [];
  const missingWorkerDetails = team.status === 'ready' && team.someDetailsUnavailable;
  const pendingApprovalRequests = advanceRequests.filter(
    (request) => request.status === 'pending_approval'
  );
  const approvedPendingPaymentRequests = advanceRequests.filter(
    (request) => request.status === 'approved_pending_payment'
  );
  const pendingApprovalCount = pendingApprovalRequests.length;
  const approvedPendingPaymentCount = approvedPendingPaymentRequests.length;
  const pendingApprovalTotal = pendingApprovalRequests.reduce(
    (sum, request) => sum + request.requested_amount,
    0
  );
  const approvedPendingPaymentTotal = approvedPendingPaymentRequests.reduce(
    (sum, request) => sum + request.requested_amount,
    0
  );

  const visibleRequests = useMemo(() => {
    const scopedRequests = isFounder
      ? advanceRequests
      : advanceRequests.filter((request) => request.submitted_by === user?.id);

    if (focusedRequestId) {
      return scopedRequests.filter((request) => request.id === focusedRequestId);
    }

    if (isFounder) {
      return scopedRequests.filter((request) => {
        if (siteFilter !== 'all' && request.project_id !== siteFilter) return false;
        if (founderStatusFilter === 'all') return true;
        if (founderStatusFilter === 'needs_action') {
          return request.status === 'pending_approval' || request.status === 'approved_pending_payment';
        }
        return request.status === founderStatusFilter;
      });
    }

    if (requestFilter === 'all') return scopedRequests;
    return scopedRequests.filter(
      (request) => request.status === 'pending_approval' || request.status === 'approved_pending_payment'
    );
  }, [
    advanceRequests,
    founderStatusFilter,
    focusedRequestId,
    isFounder,
    requestFilter,
    siteFilter,
    user?.id,
  ]);

  const siteGroups = useMemo<SiteRequestGroup[]>(() => {
    const bySite = new Map<string, AdvanceRequest[]>();
    visibleRequests.forEach((request) => {
      const group = bySite.get(request.project_id) ?? [];
      group.push(request);
      bySite.set(request.project_id, group);
    });
    return Array.from(bySite.entries())
      .map(([siteId, requests]) => ({
        siteId,
        siteName: projects.find((project) => project.id === siteId)?.name || 'Site unavailable',
        requests,
      }))
      .sort((a, b) => a.siteName.localeCompare(b.siteName));
  }, [projects, visibleRequests]);

  const selectedRequestIds = new Set(requestSelection.ids);
  const selectedRequests = advanceRequests.filter(
    (request) => selectedRequestIds.has(request.id) && canReview(request)
  );
  const selectedRequestTotal = selectedRequests.reduce(
    (sum, request) => sum + request.requested_amount,
    0
  );
  const selectedSiteName = projects.find((project) => project.id === requestSelection.siteId)?.name || 'this site';
  const duplicateSignals = weeklyMode && isFounder && weeklyStatuses.data
    ? selectedBaleDuplicateSignals(advanceRequests, weeklyStatuses.data.items, new Set(advanceRequests.map(request => request.id)))
    : [];
  const possibleDuplicates = duplicateSignals.filter(signal => selectedRequests.some(request =>
    request.worker_id === signal.workerId && statusFor(request)?.period_start === signal.periodStart
  ));

  useEffect(() => {
    if (!focusedRequestId || !visibleRequests.some((request) => request.id === focusedRequestId)) return;
    const frame = window.requestAnimationFrame(() => {
      document.getElementById(`advance-request-${focusedRequestId}`)?.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusedRequestId, visibleRequests]);

  useEffect(() => {
    setRequestSelection((previous) => {
      const validIds = previous.ids.filter((id) =>
        advanceRequests.some(
          (request) =>
            request.id === id &&
            request.status === 'pending_approval' &&
            (weeklyMode ? weeklyStatuses.data?.items.some(item => item.id === request.id && item.stored_status === request.status && item.can_review) : !cutoverMode) &&
            request.project_id === previous.siteId
        )
      );
      if (validIds.length === previous.ids.length) return previous;
      return { siteId: validIds.length > 0 ? previous.siteId : null, ids: validIds };
    });
  }, [advanceRequests, cutoverMode, weeklyMode, weeklyStatuses.data]);

  const clearRequestFocus = () => {
    if (!focusedRequestId) return;
    setFocusedRequestId(null);
    const params = new URLSearchParams(searchParams?.toString() || '');
    params.delete('request');
    const query = params.toString();
    router.replace(query ? `/advances?${query}` : '/advances', { scroll: false });
  };

  const handleSiteFilterChange = (nextSiteId: string) => {
    setSiteFilter(nextSiteId);
    setFocusedRequestId(null);
    setRequestSelection({ siteId: null, ids: [] });
    const params = new URLSearchParams(searchParams?.toString() || '');
    params.set('tab', 'requests');
    params.delete('request');
    if (nextSiteId === 'all') params.delete('site');
    else params.set('site', nextSiteId);
    router.replace(`/advances?${params.toString()}`, { scroll: false });
  };

  const handleFounderStatusChange = (nextStatus: FounderStatusFilter) => {
    setFounderStatusFilter(nextStatus);
    setRequestSelection({ siteId: null, ids: [] });
    clearRequestFocus();
  };

  const toggleSiteExpanded = (siteId: string) => {
    setCollapsedSiteIds((previous) => {
      const next = new Set(previous);
      if (next.has(siteId)) next.delete(siteId);
      else next.add(siteId);
      return next;
    });
  };

  const toggleRequestSelection = (request: AdvanceRequest, checked: boolean) => {
    if (!canReview(request)) return;
    setRequestSelection((previous) => {
      if (checked) {
        if (previous.siteId && previous.siteId !== request.project_id) return previous;
        if (previous.ids.includes(request.id)) return previous;
        if (previous.ids.length >= MAX_BATCH_APPROVAL_SIZE) return previous;
        return { siteId: request.project_id, ids: [...previous.ids, request.id] };
      }
      const ids = previous.ids.filter((id) => id !== request.id);
      return { siteId: ids.length > 0 ? previous.siteId : null, ids };
    });
  };

  const toggleSiteRequestSelection = (group: SiteRequestGroup, checked: boolean) => {
    const pendingIds = group.requests
      .filter((request) => canReview(request))
      .map((request) => request.id);
    setRequestSelection((previous) => {
      if (!checked) {
        if (previous.siteId !== group.siteId) return previous;
        return { siteId: null, ids: [] };
      }
      if (previous.siteId && previous.siteId !== group.siteId) return previous;
      const availableSlots = Math.max(0, MAX_BATCH_APPROVAL_SIZE - previous.ids.length);
      const additionalIds = pendingIds
        .filter((id) => !previous.ids.includes(id))
        .slice(0, availableSlots);
      const nextIds = [...previous.ids, ...additionalIds];
      return { siteId: nextIds.length > 0 ? group.siteId : null, ids: nextIds };
    });
  };

  const handleApproveSelected = async () => {
    const requestIds = selectedRequests.map((request) => request.id);
    if (batchLock.current || reviewLock.current || requestIds.length === 0 || requestIds.length > MAX_BATCH_APPROVAL_SIZE) return;
    reviewLock.current = true;
    const marker = weeklyMode ? reviewGuard.begin('approve',requestIds) : null;
    if (weeklyMode && !marker) { reviewLock.current=false; return; }
    batchLock.current = true;
    setIsApprovingBatch(true);
    setIsBatchApprovalOpen(false);
    try {
      const approved = await approveAdvanceRequests(requestIds);
      if (!panelMounted.current || activeReviewScope.current!==reviewScope) return;
      if (approved && (!weeklyMode || (marker && reviewGuard.confirmed(marker)))) {
        setRequestSelection({ siteId: null, ids: [] });
      } else {
        showToast('error', 'Approval not confirmed. Check every request status before retrying.');
      }
    } catch {
      if (panelMounted.current && activeReviewScope.current===reviewScope) showToast('error', 'Approval not confirmed. Check every request status before retrying.');
    } finally {
      reviewLock.current = false;
      batchLock.current = false;
      if (panelMounted.current && activeReviewScope.current===reviewScope) setIsApprovingBatch(false);
    }
  };

  const openRequestModal = () => {
    setSelectedWorkerId('');
    setSelectedProjectId(accessibleProjects.length === 1 ? accessibleProjects[0].id : '');
    setRequestedAmount('');
    setRequestModalOpen(true);
  };

  const handleSubmitRequest = async (event: React.FormEvent) => {
    event.preventDefault();
    const amount = Number(requestedAmount);
    if ((cutoverMode && !weeklyMode) || (weeklyMode && submissionGuard.status !== 'ready') || submitLock.current || team.status !== 'ready' || !activeWorkers.some((worker) => worker.id === selectedWorkerId) || !selectedProjectId || !Number.isFinite(amount) || amount <= 0) return;
    submitLock.current = true;
    const marker = weeklyMode ? submissionGuard.begin(idempotentSubmission ? {worker:selectedWorkerId,project:selectedProjectId,amount:(Math.round(amount*100)/100).toFixed(2),period:workerPayrollPeriod(getManilaClock().dateIso).start} : undefined) : null;
    if (weeklyMode && !marker) { submitLock.current = false; return; }
    const requestId = idempotentSubmission && marker ? (JSON.parse(marker) as {request:string}).request : undefined;
    setIsSubmitting(true);
    try {
      const created = await createAdvanceRequest({
        worker_id: selectedWorkerId,
        project_id: selectedProjectId,
        requested_amount: amount,
        ...(requestId && marker ? {request_id:requestId,request_period_start:(JSON.parse(marker) as {period:string}).period} : {}),
      });
      const verified = created && (!weeklyMode || (typeof created.id === 'string' && !!created.id && (!requestId || created.id===requestId) && created.worker_id === selectedWorkerId && created.project_id === selectedProjectId && created.submitted_by === user?.id && created.requested_amount === Math.round(amount * 100) / 100));
      const confirmed = panelMounted.current && activeSubmissionScope.current === submissionScope && verified && (!weeklyMode || (marker && submissionGuard.confirmed(marker)));
      if (panelMounted.current && activeSubmissionScope.current === submissionScope) {
        if (confirmed) setRequestModalOpen(false);
        else {
          if (weeklyMode) setRequestModalOpen(false);
          showToast('error', 'Request submission not confirmed. Check the request list before retrying.');
        }
      }
    } catch {
      if (panelMounted.current && activeSubmissionScope.current === submissionScope) {
        if (weeklyMode) setRequestModalOpen(false);
        showToast('error', 'Request submission not confirmed. Check the request list before retrying.');
      }
    } finally {
      submitLock.current = false;
      if (panelMounted.current && activeSubmissionScope.current === submissionScope) setIsSubmitting(false);
    }
  };

  const retryUncertainRequest = async () => {
    if (!idempotentSubmission || !isSupervisor || submitLock.current) return;
    submitLock.current = true;
    const saved = submissionGuard.retry();
    if (!saved) { submitLock.current = false; return; }
    setIsSubmitting(true);
    try {
      const {attempt,marker} = saved;
      const created = await createAdvanceRequest({worker_id:attempt.worker,project_id:attempt.project,requested_amount:Number(attempt.amount),request_id:attempt.request,request_period_start:attempt.period});
      const verified = created && created.id===attempt.request && created.worker_id===attempt.worker && created.project_id===attempt.project && created.submitted_by===attempt.actor && created.requested_amount===Number(attempt.amount);
      const confirmed = panelMounted.current && activeSubmissionScope.current===submissionScope && verified && submissionGuard.confirmed(marker);
      if (!confirmed && panelMounted.current && activeSubmissionScope.current===submissionScope) showToast('error','Request outcome is still unconfirmed. Investigate before sending another.');
    } catch {
      if (panelMounted.current && activeSubmissionScope.current===submissionScope) showToast('error','Request outcome is still unconfirmed. Investigate before sending another.');
    } finally { submitLock.current=false; if (panelMounted.current && activeSubmissionScope.current===submissionScope) setIsSubmitting(false); }
  };

  const handleReview = async (id: string, decision: 'approve' | 'reject') => {
    const request = advanceRequests.find(item => item.id === id);
    if (actionLock.current || reviewLock.current || !request || !canReview(request)) return;
    reviewLock.current = true;
    const marker = weeklyMode ? reviewGuard.begin(decision,[id]) : null;
    if (weeklyMode && !marker) { reviewLock.current=false; return; }
    actionLock.current = true;
    setActioningRequestId(id);
    try {
      const success = await reviewAdvanceRequest(id, decision);
      if (!panelMounted.current || activeReviewScope.current!==reviewScope) return;
      if (!success || (weeklyMode && (!marker || !reviewGuard.confirmed(marker)))) showToast('error', 'Review not confirmed. Check the request status before retrying.');
    } catch {
      if (panelMounted.current && activeReviewScope.current===reviewScope) showToast('error', 'Review not confirmed. Check the request status before retrying.');
    } finally {
      reviewLock.current = false;
      actionLock.current = false;
      if (panelMounted.current && activeReviewScope.current===reviewScope) setActioningRequestId(null);
    }
  };

  const handleIssue = async () => {
    if (cutoverMode || weeklyMode || !requestToIssue || actionLock.current) return;
    actionLock.current = true;
    setActioningRequestId(requestToIssue);
    try {
      const issued = await issueAdvanceRequest(requestToIssue);
      if (issued) setRequestToIssue(null);
      else showToast('error', 'Payment confirmation not confirmed. Check the request and advance ledger before retrying.');
    } catch {
      showToast('error', 'Payment confirmation not confirmed. Check the request and advance ledger before retrying.');
    } finally {
      actionLock.current = false;
      setActioningRequestId(null);
    }
  };

  const renderRequestRow = (request: AdvanceRequest) => {
    const worker = workers.find((item) => item.id === request.worker_id);
    const project = projects.find((item) => item.id === request.project_id);
    const submitter = users.find((item) => item.id === request.submitted_by);
    const isActioning = actioningRequestId === request.id;
    const isSelected = selectedRequestIds.has(request.id);
    const weeklyStatus = weeklyMode ? statusFor(request) : undefined;
    const duplicateSignal = weeklyStatus && duplicateSignals.find(signal => signal.workerId === request.worker_id && signal.periodStart === weeklyStatus.period_start);
    const selectionDisabled =
      !canReview(request) ||
      (Boolean(requestSelection.siteId) && requestSelection.siteId !== request.project_id) ||
      (!isSelected && requestSelection.ids.length >= MAX_BATCH_APPROVAL_SIZE);

    return (
      <article
        key={request.id}
        id={`advance-request-${request.id}`}
        className={`flex flex-col gap-3 p-4 transition-colors sm:flex-row sm:items-center sm:justify-between sm:p-5 ${
          focusedRequestId === request.id ? 'bg-brand/[0.035] ring-1 ring-inset ring-brand/20' : ''
        }`}
      >
        <div className="flex min-w-0 items-start gap-3">
          {isFounder && request.status === 'pending_approval' && (
            <label className="mt-0.5 inline-flex min-h-11 min-w-11 shrink-0 cursor-pointer items-center justify-center rounded-lg hover:bg-surface-inset">
              <input
                type="checkbox"
                checked={isSelected}
                disabled={selectionDisabled}
                onChange={(event) => toggleRequestSelection(request, event.target.checked)}
                aria-label={`Select ${worker?.name || 'worker'} request for ${formatPeso(request.requested_amount)}`}
                className="h-4 w-4 rounded border-surface-border text-brand focus:ring-brand disabled:cursor-not-allowed"
              />
            </label>
          )}
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="break-words text-sm font-semibold text-navy">
                {worker?.name || 'Worker'}
              </span>
              <Badge size="sm" variant={requestStatusVariant(request.status)}>
                {weeklyStatus?.effective_status === 'expired_unapproved' ? 'Expired · awaiting recorded rejection' : weeklyStatus?.auto_expired ? 'Automatically rejected' : requestStatusLabel(request.status)}
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
            <p className="max-w-lg text-xs leading-relaxed text-ink-secondary">{weeklyStatus?.effective_status === 'expired_unapproved' ? 'The approval window ended after Tuesday. This request cannot be approved; recorded rejection may be pending the expiry job.' : weeklyStatus?.auto_expired ? 'Automatically rejected after the approval window; no Bale was issued.' : requestStatusDescription(request.status)}</p>
            {weeklyMode && !weeklyStatus && <p className="text-xs text-status-warning">Weekly status unavailable or changed. Reload the request list and weekly status before taking action.</p>}
            {weeklyMode && weeklyStatus?.kind === 'legacy' && <p className="text-xs text-status-warning">Legacy request: review separately; weekly actions are unavailable.</p>}
            {isFounder && weeklyStatus?.effective_status !== 'rejected' && weeklyStatus?.effective_status !== 'expired_unapproved' && duplicateSignal && <p className="text-xs text-status-warning">Possible repeated requests: {duplicateSignal.requestCount} non-rejected requests are visible for this worker and week. Check whether they are intentional; this list may be incomplete.</p>}
            <details className="group/activity text-xs">
              <summary className="inline-flex min-h-11 cursor-pointer items-center gap-1.5 rounded-md font-semibold text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand">
                Status dates <span className="sr-only">for {worker?.name || 'worker'} · {formatPeso(request.requested_amount)}</span>
                <ChevronDown aria-hidden="true" className="h-3.5 w-3.5 transition-transform group-open/activity:rotate-180" />
              </summary>
              <ul className="space-y-1 pb-1 text-ink-secondary">
                {requestActivity(request).map((event) => (
                  <li key={event.label}>{event.label}: {formatDatePH(event.date) || 'Date unavailable'}</li>
                ))}
              </ul>
              <p className="pb-1 text-[11px] leading-relaxed text-ink-muted">Dates are recorded status changes in Manila time, not a payment receipt.</p>
            </details>
          </div>
        </div>

        <div className="flex flex-col gap-3 sm:items-end">
          <p className="text-base font-semibold tabular-nums text-navy">
            {formatPeso(request.requested_amount)}
          </p>
          {isFounder && request.status === 'pending_approval' && (
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={isActioning || !canReview(request)}
                onClick={() => handleReview(request.id, 'reject')}
                leftIcon={<X className="h-3.5 w-3.5" />}
              >
                Reject
              </Button>
              <Button
                type="button"
                size="sm"
                variant="primary"
                disabled={isActioning || !canReview(request)}
                onClick={() => handleReview(request.id, 'approve')}
                leftIcon={<Check className="h-3.5 w-3.5" />}
              >
                Approve
              </Button>
            </div>
          )}
          {isFounder && !weeklyMode && !cutoverMode && request.status === 'approved_pending_payment' && (
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
  };

  return (
    <div className="space-y-4">
      {cutoverMode && !weeklyMode && <p role="alert" className="rounded-xl bg-status-warning-bg p-3 text-xs text-ink-secondary">Weekly Bale controls are not enabled. Requests and decisions are held until the configuration is reviewed.</p>}
      {weeklyMode && isFounder && reviewGuard.status === 'pending' && <section role="alert" className="space-y-2 rounded-xl bg-status-warning-bg p-3 text-xs text-ink-secondary">
        <p>A Bale review may have been recorded. Check each affected request and its history before another decision. An empty list does not prove failure; the earlier action may still be processing.</p>
        {reviewGuard.marker && <p className="break-all">{reviewGuard.marker.decision === 'approve' ? 'Approval' : 'Rejection'} · request IDs: {reviewGuard.marker.ids.join(', ')}</p>}
        <p>This warning exists only in this browser tab. It can be lost if storage is cleared, does not lock other devices, and clearing it does not cancel a request.</p>
        <label className="flex items-start gap-2"><input type="checkbox" checked={reviewedUncertainDecision} onChange={event=>setReviewedUncertainDecision(event.target.checked)} />I investigated each request and understand this does not cancel the earlier decision.</label>
        <Button type="button" size="sm" variant="secondary" disabled={!reviewedUncertainDecision || Boolean(actioningRequestId) || isApprovingBatch} onClick={()=>{if(reviewGuard.clearAfterReview())setReviewedUncertainDecision(false);}}>Clear Bale review warning</Button>
      </section>}
      {weeklyMode && isFounder && reviewGuard.status === 'unavailable' && <p role="alert" className="rounded-xl bg-status-warning-bg p-3 text-xs text-ink-secondary">This tab cannot safely check its Bale review warning. Decisions are held; investigate the request history and restore browser storage before continuing.</p>}
      {weeklyMode && isSupervisor && submissionGuard.status === 'pending' && <section role="alert" className="space-y-2 rounded-xl bg-status-warning-bg p-3 text-xs text-ink-secondary">
        <p>A Bale request may have been sent, but its result was not confirmed. Refresh and check the request list with the Founder before submitting another. An empty list does not prove the request failed; it may still be processing. Do not give or request money again based on this warning.</p>
        <p>This warning is only in this browser tab. Closing it or clearing storage may erase the warning; another tab or device can still send a request.</p>
        {idempotentSubmission && submissionGuard.pendingAttempt && <div className="space-y-2">
          <p>Exact retry: worker {submissionGuard.pendingAttempt.worker} · site {submissionGuard.pendingAttempt.project} · ₱{submissionGuard.pendingAttempt.amount} · week starting {submissionGuard.pendingAttempt.period}. This may confirm a previous save or send it if it was not saved; check the request list first.</p>
          <Button type="button" size="sm" variant="secondary" disabled={isSubmitting} onClick={()=>void retryUncertainRequest()}>Retry exact Bale request</Button>
        </div>}
        <label className="flex items-start gap-2"><input type="checkbox" checked={reviewedUncertainSubmission} onChange={e=>setReviewedUncertainSubmission(e.target.checked)} />I investigated the earlier request and understand that clearing this warning does not cancel it.</label>
        <Button type="button" size="sm" variant="secondary" disabled={!reviewedUncertainSubmission || isSubmitting} onClick={()=>{if(submissionGuard.clearAfterReview())setReviewedUncertainSubmission(false);}}>Clear warning after review</Button>
      </section>}
      {weeklyMode && isSupervisor && submissionGuard.status === 'unavailable' && <p role="alert" className="rounded-xl bg-status-warning-bg p-3 text-xs text-ink-secondary">This tab cannot safely check its request warning. New requests are held; investigate the request list and restore browser storage before trying again.</p>}
      {isFounder && user?.id && weeklyBaleExpiryHealthPreviewEnabled() && <WeeklyBaleExpiryHealth userId={user.id} />}
      {weeklyMode && <div className="rounded-xl border border-surface-border bg-white p-3 text-xs text-ink-secondary">
        <p>Weekly decision status is checked against the server in bounded batches, not one transaction. Results can change immediately; decisions are checked again by the server. Existing list totals and filters reflect stored statuses, which may lag automatic expiry. Release is handled in the separate experimental panel.</p>
        {weeklyStatuses.loading && <p role="status">Checking weekly request status…</p>}
        {weeklyStatuses.error && <p role="alert">Weekly status unavailable: {weeklyStatuses.error}</p>}
        <Button type="button" size="sm" variant="secondary" disabled={weeklyStatuses.loading} onClick={() => void weeklyStatuses.refresh()}>Refresh weekly status</Button>
      </div>}
      <div
        className={`animate-mobile-lift flex flex-col gap-3 rounded-2xl border p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5 ${
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
            disabled={accessibleProjects.length === 0 || (weeklyMode && submissionGuard.status !== 'ready')}
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

      {isSupervisor && accessibleProjects.length === 0 && (
        <p className="rounded-lg border border-status-warning/20 bg-status-warning-bg/50 px-3 py-2 text-xs leading-relaxed text-ink-secondary">
          No assigned project is available for this account yet. Ask the Founder to assign a project before submitting a request.
        </p>
      )}

      {isFounder && (
        <p className="text-xs leading-relaxed text-ink-secondary">Summary covers loaded requests across all sites and is not affected by the filters below. Older requests may be missing from the loaded history.</p>
      )}
      {isFounder && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Card className="flex items-center justify-between gap-3 p-4">
            <div>
              <p className="text-xs font-medium text-ink-secondary">Awaiting approval</p>
              <p className="mt-1 text-xl font-semibold tabular-nums text-navy">{pendingApprovalCount}</p>
            </div>
            <p className="text-right text-xs font-medium tabular-nums text-ink-secondary">
              {formatPesoCompact(pendingApprovalTotal)} requested
            </p>
          </Card>
          <Card className="flex items-center justify-between gap-3 p-4">
            <div>
              <p className="text-xs font-medium text-ink-secondary">Approved · awaiting payment</p>
              <p className="mt-1 text-xl font-semibold tabular-nums text-navy">{approvedPendingPaymentCount}</p>
            </div>
            <p className="text-right text-xs font-medium tabular-nums text-ink-secondary">
              {formatPesoCompact(approvedPendingPaymentTotal)} to confirm
            </p>
          </Card>
        </div>
      )}

      {isFounder ? (
        <div className="grid gap-3 sm:grid-cols-2" aria-label="Advance request filters">
          <Select
            label="Project site"
            value={siteFilter}
            onChange={(event) => handleSiteFilterChange(event.target.value)}
            options={[
              { label: 'All sites', value: 'all' },
              ...projects.map((project) => ({ label: project.name, value: project.id })),
            ]}
          />
          <Select
            label="Request status"
            value={founderStatusFilter}
            onChange={(event) => handleFounderStatusChange(event.target.value as FounderStatusFilter)}
            options={[
              { label: 'Needs action', value: 'needs_action' },
              { label: 'Awaiting approval', value: 'pending_approval' },
              { label: 'Approved · awaiting payment', value: 'approved_pending_payment' },
              { label: 'Issued', value: 'issued' },
              { label: 'Rejected', value: 'rejected' },
              { label: 'All statuses', value: 'all' },
            ]}
          />
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2" aria-label="Advance request filters">
          <Button
            type="button"
            size="sm"
            variant={requestFilter === 'open' ? 'soft' : 'ghost'}
            aria-pressed={requestFilter === 'open'}
            onClick={() => {
              setRequestFilter('open');
              setRequestSelection({ siteId: null, ids: [] });
              clearRequestFocus();
            }}
          >
            Open requests
          </Button>
          <Button
            type="button"
            size="sm"
            variant={requestFilter === 'all' ? 'soft' : 'ghost'}
            aria-pressed={requestFilter === 'all'}
            onClick={() => {
              setRequestFilter('all');
              setRequestSelection({ siteId: null, ids: [] });
              clearRequestFocus();
            }}
          >
            All requests
          </Button>
        </div>
      )}

      <p className="text-xs leading-relaxed text-ink-secondary">The list shows loaded requests only; older requests may not appear and statuses can change. Check the records before retrying an unconfirmed action.</p>
      {baleRequestCoverage===null && <p role="status" className="rounded-lg bg-status-warning-bg p-3 text-xs text-ink-secondary">Bale list coverage needs a fresh sync after a change. The list and duplicate hints may be incomplete.</p>}
      {baleRequestCoverage && (baleRequestCoverage.openOmitted>0 || baleRequestCoverage.historyOmitted>0) && <p role="alert" className="rounded-lg bg-status-warning-bg p-3 text-xs text-ink-secondary">
        At the last sync, {baleRequestCoverage.openOmitted} open and {baleRequestCoverage.historyOmitted} historical requests were outside this loaded view. Open requests take priority. These counts may already have changed; filters and duplicate hints cannot find omitted records. Investigate separately before deciding or retrying.
      </p>}

      {focusedRequestId && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-surface-border bg-white px-3 py-2 text-xs text-ink-secondary">
          <span>Showing a linked request.</span>
          <Button type="button" size="sm" variant="ghost" onClick={clearRequestFocus}>Back to filtered requests</Button>
        </div>
      )}

      {visibleRequests.length === 0 ? (
        <Card className="p-8 text-center">
          <HandCoins className="mx-auto h-7 w-7 text-ink-muted" aria-hidden="true" />
          <p className="mt-2 text-sm font-semibold text-navy">
            {focusedRequestId
              ? 'This Bale request is not in the loaded list'
              : isFounder
                ? founderStatusFilter === 'needs_action'
                  ? 'No loaded requests need action'
                  : 'No loaded requests match these filters'
                : requestFilter === 'open'
                  ? 'No loaded open requests'
                  : 'No loaded Bale requests'}
          </p>
          <p className="mt-1 text-xs text-ink-secondary">
            {focusedRequestId
              ? 'This request may be outside the loaded history or unavailable to this account.'
              : isFounder
                ? siteFilter === 'all'
                  ? 'New Supervisor submissions appear here when loaded; check other records if a request is missing.'
                  : 'Try another site or request status.'
                : accessibleProjects.length === 0
                  ? 'Ask the Founder to assign a project before submitting a request.'
                  : 'Use “New Bale Request” to choose a site and its assigned worker.'}
          </p>
        </Card>
      ) : isFounder ? (
        <div className="space-y-3">
          {selectedRequests.length > 0 && (
            <div className="flex flex-col gap-3 rounded-xl border border-brand/15 bg-brand/[0.035] p-3 sm:flex-row sm:items-center sm:justify-between sm:p-4">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-navy">
                  {selectedRequests.length} pending request{selectedRequests.length === 1 ? '' : 's'} selected at {selectedSiteName}
                </p>
                <p className="mt-1 text-xs tabular-nums text-ink-secondary">
                  Selected total: {formatPeso(selectedRequestTotal)} · up to {MAX_BATCH_APPROVAL_SIZE} requests per batch
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setRequestSelection({ siteId: null, ids: [] })}
                >
                  Clear selection
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="primary"
                  disabled={selectedRequests.length === 0 || isApprovingBatch}
                  onClick={() => setIsBatchApprovalOpen(true)}
                  leftIcon={<Check className="h-3.5 w-3.5" />}
                >
                  Approve selected ({selectedRequests.length})
                </Button>
              </div>
            </div>
          )}

          {siteGroups.map((group) => {
            const pendingGroupRequests = group.requests.filter((request) => canReview(request));
            const approvedGroupCount = group.requests.filter(
              (request) => request.status === 'approved_pending_payment'
            ).length;
            const groupTotal = group.requests.reduce(
              (sum, request) => sum + request.requested_amount,
              0
            );
            const selectedInGroup = pendingGroupRequests.filter((request) =>
              selectedRequestIds.has(request.id)
            ).length;
            const groupIsDisabled =
              Boolean(requestSelection.siteId) && requestSelection.siteId !== group.siteId;
            const groupIsExpanded = !collapsedSiteIds.has(group.siteId);

            return (
              <section
                key={group.siteId}
                className="overflow-hidden rounded-xl border border-surface-border bg-white"
                aria-label={`${group.siteName} advance requests`}
              >
                <div className="bg-surface/50 p-3 sm:p-4">
                  <div className="flex items-start gap-2">
                    <button
                      type="button"
                      onClick={() => toggleSiteExpanded(group.siteId)}
                      aria-expanded={groupIsExpanded}
                      className="inline-flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-lg text-left text-sm font-semibold text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                    >
                      <ChevronDown
                        className={`h-4 w-4 shrink-0 text-ink-muted transition-transform ${
                          groupIsExpanded ? '' : '-rotate-90'
                        }`}
                        aria-hidden="true"
                      />
                      <span className="break-words">{group.siteName}</span>
                    </button>
                    <div className="shrink-0 pt-1 text-right">
                      <span className="block text-[10px] font-medium text-ink-muted">Shown requested total</span>
                      <p className="text-xs font-semibold tabular-nums text-navy">
                        {formatPesoCompact(groupTotal)}
                      </p>
                    </div>
                  </div>
                  <p className="ml-6 break-words text-[11px] leading-relaxed text-ink-secondary">
                    {group.requests.length} shown · {pendingGroupRequests.length} {weeklyMode ? 'verified for review' : 'awaiting approval'} · {approvedGroupCount} awaiting payment
                  </p>

                  <p className="ml-6 text-[11px] leading-relaxed text-ink-muted">Shown total adds requested amounts in this view, including any issued or rejected requests; it is not an amount due.</p>

                  {pendingGroupRequests.length > 0 && (
                    <label className={`mt-2 inline-flex min-h-11 items-center gap-2 rounded-lg px-2 text-xs font-medium ${
                      groupIsDisabled
                        ? 'cursor-not-allowed text-ink-muted'
                        : 'cursor-pointer text-brand hover:bg-white/80'
                    }`}>
                      <input
                        type="checkbox"
                        checked={pendingGroupRequests.length > 0 && selectedInGroup === pendingGroupRequests.length}
                        aria-checked={
                          selectedInGroup === 0
                            ? false
                            : selectedInGroup === pendingGroupRequests.length
                              ? true
                              : 'mixed'
                        }
                        disabled={groupIsDisabled}
                        onChange={(event) => toggleSiteRequestSelection(group, event.target.checked)}
                        className="h-4 w-4 rounded border-surface-border text-brand focus:ring-brand disabled:cursor-not-allowed"
                      />
                      <span>Select pending requests at this site ({pendingGroupRequests.length})</span>
                    </label>
                  )}
                  {groupIsDisabled && (
                    <p className="ml-2 text-[11px] text-ink-muted">
                      Clear the current selection from {selectedSiteName} to choose this site.
                    </p>
                  )}
                  {pendingGroupRequests.length > 0 && (
                    <p className="ml-2 text-[11px] text-ink-muted">
                      Batch approval is limited to {MAX_BATCH_APPROVAL_SIZE} requests at one site.
                    </p>
                  )}
                </div>
                {groupIsExpanded && (
                  <div className="divide-y divide-surface-border/70">
                    {group.requests.map((request) => renderRequestRow(request))}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-surface-border bg-white">
          <div className="divide-y divide-surface-border/70">
            {visibleRequests.map((request) => renderRequestRow(request))}
          </div>
        </div>
      )}

      <Modal
        isOpen={isBatchApprovalOpen}
        onClose={() => {
          if (!isApprovingBatch) setIsBatchApprovalOpen(false);
        }}
        dismissOnBackdrop={!isApprovingBatch}
        dismissOnEscape={!isApprovingBatch}
        showCloseButton={!isApprovingBatch}
        title="Approve selected Bale requests?"
        description="Review this same-site batch before approving. No payment will be recorded."
        maxWidth="md"
      >
        {isBatchApprovalOpen && (
          <div className="space-y-4 text-xs">
            <div className="rounded-xl border border-surface-border bg-surface-inset p-4">
              <dl className="grid grid-cols-2 gap-x-3 gap-y-4">
                <div className="col-span-2 min-w-0">
                  <dt className="text-[11px] font-medium text-ink-secondary">Project site</dt>
                  <dd className="mt-1 break-words text-sm font-semibold text-navy">{selectedSiteName}</dd>
                </div>
                <div>
                  <dt className="text-[11px] font-medium text-ink-secondary">Requests</dt>
                  <dd className="mt-1 text-base font-semibold tabular-nums text-navy">{selectedRequests.length}</dd>
                </div>
                <div>
                  <dt className="text-[11px] font-medium text-ink-secondary">Total requested</dt>
                  <dd className="mt-1 break-words text-base font-semibold tabular-nums text-navy">
                    {formatPeso(selectedRequestTotal)}
                  </dd>
                </div>
              </dl>
              <div className="mt-4 border-t border-surface-border pt-3">
                <p className="text-[11px] font-medium text-ink-secondary">Selected workers</p>
                <ul className="mt-1 space-y-1 text-xs text-navy">
                  {selectedRequests.slice(0, 5).map((request) => (
                    <li key={request.id} className="break-words">
                      {workers.find((worker) => worker.id === request.worker_id)?.name || 'Worker'} · {formatPeso(request.requested_amount)}
                    </li>
                  ))}
                </ul>
                {selectedRequests.length > 5 && (
                  <p className="mt-1 text-[11px] text-ink-secondary">
                    And {selectedRequests.length - 5} more request{selectedRequests.length - 5 === 1 ? '' : 's'}.
                  </p>
                )}
              </div>
            </div>
            {possibleDuplicates.length > 0 && (
              <div role="alert" className="rounded-lg border border-status-warning/30 bg-status-warning-bg/50 px-3 py-2.5 leading-relaxed text-ink-secondary">
                <p className="font-semibold text-navy">Check possible repeated requests before approval</p>
                <p>Multiple non-rejected requests are visible for the same worker and week. They may be intentional; check their details and status before approving.</p>
                <ul className="mt-1 list-inside list-disc">
                  {possibleDuplicates.slice(0, 5).map(signal => (
                    <li key={`${signal.workerId}:${signal.periodStart}`} className="break-words">
                      {workers.find(worker => worker.id === signal.workerId)?.name || 'Worker unavailable'} · week of {signal.periodStart} · {signal.requestCount} requests
                    </li>
                  ))}
                </ul>
                {possibleDuplicates.length > 5 && <p>And {possibleDuplicates.length - 5} more worker-week groups.</p>}
                <p className="mt-1">This hint only uses loaded, verified weekly statuses and cannot rule out other requests.</p>
              </div>
            )}
            <p className="rounded-lg border border-status-warning/20 bg-status-warning-bg/50 px-3 py-2.5 leading-relaxed text-ink-secondary">
              Approval is separate from payment. These requests will remain approved and awaiting payment; confirm payment later, one request at a time.
            </p>
            <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
              <Button
                type="button"
                variant="secondary"
                disabled={isApprovingBatch}
                onClick={() => setIsBatchApprovalOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="primary"
                isLoading={isApprovingBatch}
                disabled={selectedRequests.length === 0}
                onClick={handleApproveSelected}
                leftIcon={<Check className="h-3.5 w-3.5" />}
              >
                Approve {selectedRequests.length} request{selectedRequests.length === 1 ? '' : 's'}
              </Button>
            </div>
          </div>
        )}
      </Modal>

      <Modal
        isOpen={requestModalOpen}
        onClose={() => setRequestModalOpen(false)}
        dismissOnBackdrop={!isSubmitting}
        dismissOnEscape={!isSubmitting}
        showCloseButton={!isSubmitting}
        title="New Bale Request"
        description="Choose an assigned site and one of its active workers, then enter the amount requested."
        maxWidth="md"
      >
        <form onSubmit={handleSubmitRequest} className="space-y-4 text-xs">
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
              onChange={(event) => { setSelectedWorkerId(''); setSelectedProjectId(event.target.value); }}
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

          <Select
            label="Worker"
            disabled={team.status !== 'ready'}
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

          {selectedProjectId && team.status === 'loading' && <p role="status">Loading workers for the selected site…</p>}
          {selectedProjectId && team.status === 'error' && (
            <p role="alert">Could not load the site team. <button type="button" className="font-semibold text-brand underline" onClick={team.reload}>Try again</button></p>
          )}
          {selectedProjectId && missingWorkerDetails && <p role="status">Some assigned worker details are unavailable. They may be inactive or not visible to this account. Ask the Founder to check the site team if someone is missing.</p>}
          {selectedProjectId && team.status === 'ready' && !missingWorkerDetails && activeWorkers.length === 0 && <p>No active workers are assigned to this site. Ask the Founder to check the site team if someone is missing.</p>}

          {weeklyMode && isSupervisor && selectedWorkerId && (
            <div className="rounded-lg border border-status-warning/20 bg-status-warning-bg/50 px-3 py-2.5 text-ink-secondary">
              {ownSameWeekRequests.length > 0 && <>
                <p role="alert" className="font-semibold text-navy">Check earlier requests for this worker</p>
                <p>Your loaded list includes {ownSameWeekRequests.length} non-rejected request{ownSameWeekRequests.length === 1 ? '' : 's'} for the week starting {snapshotWeek}. Confirm whether another request is intended before sending.</p>
                <ul className="mt-1 list-inside list-disc">
                  {ownSameWeekRequests.slice(0, 3).map(request => <li key={request.id} className="break-words">{formatPeso(request.requested_amount)} · {requestStatusLabel(request.status)} · {projects.find(project => project.id === request.project_id)?.name || 'Site unavailable'}</li>)}
                </ul>
                {ownSameWeekRequests.length > 3 && <p>And {ownSameWeekRequests.length - 3} more in the loaded list.</p>}
              </>}
              {!snapshotWeek && <p>Weekly status is unavailable; this check is incomplete.</p>}
              <p className={ownSameWeekRequests.length > 0 ? 'mt-1' : ''}>Only your loaded requests with verified weekly status at the last check can be compared. Other Supervisors, old records or in-flight requests may not appear; an empty list does not prove there is no earlier request. Ask the Founder when unsure.</p>
            </div>
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

          {weeklyMode && submissionGuard.status !== 'ready' && <p role="alert">This request cannot be sent while the earlier submission or browser storage is unconfirmed. Close this form and investigate the warning.</p>}
          <p className="rounded-lg bg-surface-inset px-3 py-2 text-[11px] leading-relaxed text-ink-secondary">
            This submits a request only. It does not release money. An approved release must be separately recorded by an authorized person.
          </p>

          <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="secondary" onClick={() => setRequestModalOpen(false)} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" isLoading={isSubmitting} disabled={(cutoverMode && !weeklyMode) || (weeklyMode && submissionGuard.status !== 'ready') || team.status !== 'ready' || !activeWorkers.some((worker) => worker.id === selectedWorkerId)}>
              {isSubmitting ? 'Sending request…' : 'Send to Founder'}
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        isOpen={!cutoverMode && !weeklyMode && Boolean(requestToIssue)}
        onClose={() => setRequestToIssue(null)}
        dismissOnBackdrop={!actioningRequestId}
        dismissOnEscape={!actioningRequestId}
        showCloseButton={!actioningRequestId}
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
                  {formatPeso(request.requested_amount)} · {projects.find((project) => project.id === request.project_id)?.name || 'Project'}
                </div>
              </div>
              <p className="rounded-lg border border-status-warning/20 bg-status-warning-bg/50 px-3 py-2.5 leading-relaxed text-ink-secondary">
                This records an issued advance eligible for payroll deduction. It does not transfer money; confirm only after the worker has received it.
              </p>
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button type="button" variant="secondary" onClick={() => setRequestToIssue(null)} disabled={Boolean(actioningRequestId)}>
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
