'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { useDataStore } from '@/lib/data/store';
import { useAuth } from '@/lib/auth/authContext';
import { useSMSHistory, useSMSHistorySummary } from '@/lib/sms/useSMSHistory';
import { Send, Search, CheckCircle2, AlertCircle, ChevronDown, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Input, Textarea } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Modal } from '@/components/ui/Modal';
import { WorkspaceHeader } from '@/components/ui/WorkspaceHeader';
import { EmptyState } from '@/components/ui/EmptyState';
import { WorkspaceFilters } from '@/components/ui/WorkspaceFilters';
import { createClient } from '@/lib/supabase/client';
import { buildReminderSMS, detectReminderType, estimateSMSSegments } from '@/lib/sms/templates';
import { loadSMSTemplate } from '@/lib/sms/loadTemplate';
import { formatPeso, formatDatePH } from '@/lib/email/format';
import { getManilaClock } from '@/lib/reminders/scheduler';
import type { SMSLog } from '@/types';

interface IntegrationStatus {
  philsmsConfigured: boolean;
}

const REMINDER_TYPE_LABELS: Record<string, string> = {
  upcoming: 'Upcoming due date',
  due_today: 'Due today',
  overdue: 'Overdue',
  follow_up: 'Follow-up',
};

function smsStatusBadge(log: SMSLog): { label: string; variant: 'success' | 'warning' | 'danger' | 'neutral' | 'info' } {
  if (log.simulated) return { label: 'Simulation mode', variant: 'info' };
  switch (log.status) {
    case 'delivered':
      return { label: 'Delivered', variant: 'success' };
    case 'sent':
      return { label: 'Sent', variant: 'success' };
    case 'pending':
      return { label: 'Pending / unconfirmed', variant: 'warning' };
    case 'failed':
    default:
      return { label: 'Failed', variant: 'danger' };
  }
}

export default function SMSPage() {
  const { invoices, clients, projects, sendSMS } = useDataStore();
  const { user, isFounder } = useAuth();
  const supabase = useMemo(() => createClient(), []);

  const [searchQuery, setSearchQuery] = useState('');
  const [settledSearch, setSettledSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [historyRevision, setHistoryRevision] = useState(0);
  useEffect(() => { const timer = setTimeout(() => setSettledSearch(searchQuery), 300); return () => clearTimeout(timer); }, [searchQuery]);
  const invalidDates = Boolean(fromDate && toDate && fromDate > toDate);
  const searchSettling = searchQuery !== settledSearch;
  const history = useSMSHistory(isFounder && !invalidDates && !searchSettling, user?.id, {search:settledSearch,status:statusFilter,from:fromDate,to:toDate}, historyRevision);
  const summary = useSMSHistorySummary(isFounder, user?.id, historyRevision);
  const refreshHistory = () => setHistoryRevision(value => value + 1);
  const clearFilters = () => { setSearchQuery(''); setStatusFilter('all'); setFromDate(''); setToDate(''); };
  const hasFilters = Boolean(searchQuery || statusFilter !== 'all' || fromDate || toDate);
  const [isComposeModalOpen, setIsComposeModalOpen] = useState(false);
  const [gatewayStatus, setGatewayStatus] = useState<IntegrationStatus | null>(null);

  // Compose state — the recipient is always a registered invoice client;
  // the server re-resolves and validates it before any send.
  const [selectedInvoiceId, setSelectedInvoiceId] = useState('');
  const [message, setMessage] = useState('');
  const [reminderType, setReminderType] = useState<string>('upcoming');
  const [latestEmailDate, setLatestEmailDate] = useState<string | null>(null);
  const [isPreparing, setIsPreparing] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [successNotice, setSuccessNotice] = useState(false);
  const [emailLookupFailed, setEmailLookupFailed] = useState(false);
  const [templateError, setTemplateError] = useState(false);
  const prepareVersion = useRef(0);
  const sendLock = useRef(false);
  const closeComposer = () => {
    prepareVersion.current += 1;
    setIsComposeModalOpen(false);
    setSelectedInvoiceId('');
    setMessage('');
    setConfirmed(false);
    setSuccessNotice(false);
    setIsPreparing(false);
    setEmailLookupFailed(false);
  };

  useEffect(() => {
    let active = true;
    fetch('/api/integrations/status', { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : null))
      .then((status) => {
        if (active) setGatewayStatus(status);
      })
      .catch(() => {
        if (active) setGatewayStatus(null);
      });
    return () => {
      active = false;
    };
  }, []);

  const selectedInvoice = invoices.find((i) => i.id === selectedInvoiceId) || null;
  const selectedClient = selectedInvoice
    ? clients.find((c) => c.id === selectedInvoice.client_id)
    : null;
  const selectedProject = selectedInvoice
    ? projects.find((p) => p.id === selectedInvoice.project_id)
    : null;
  const outstandingBalance = selectedInvoice
    ? selectedInvoice.amount - selectedInvoice.amount_paid
    : 0;

  const eligibleInvoices = invoices.filter(
    (inv) => inv.status !== 'paid' && inv.status !== 'cancelled' && inv.status !== 'draft' && inv.amount - inv.amount_paid > 0
  );

  /** Auto-populates the composer from the selected invoice. */
  const handleInvoiceSelect = async (invoiceId: string) => {
    const version = ++prepareVersion.current;
    setSelectedInvoiceId(invoiceId);
    setMessage('');
    setEmailLookupFailed(false);
    setTemplateError(false);
    setConfirmed(false);
    setLatestEmailDate(null);
    if (!invoiceId) {
      setIsPreparing(false);
      return;
    }

    const invoice = invoices.find((i) => i.id === invoiceId);
    if (!invoice) { setIsPreparing(false); return; }
    const client = clients.find((c) => c.id === invoice.client_id);
    const project = projects.find((p) => p.id === invoice.project_id);

    setIsPreparing(true);
    let template: string;
    try { template = await loadSMSTemplate(); }
    catch { if (version === prepareVersion.current) { setTemplateError(true); setIsPreparing(false); } return; }
    let emailedOn: string | null = null;
    try {
      // Only a genuinely successful (accepted/delivered) initial-request
      // email may be referenced with an "emailed on" date.
      const { data, error } = await supabase
        .from('email_logs')
        .select('sent_at')
        .eq('invoice_id', invoiceId)
        .eq('template_type', 'initial_request')
        .in('status', ['accepted', 'delivered'])
        .order('sent_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      emailedOn = (data as { sent_at: string | null } | null)?.sent_at ?? null;
    } catch {
      if (version === prepareVersion.current) setEmailLookupFailed(true);
    }
    if (version !== prepareVersion.current) return;

    const todayIso = getManilaClock().dateIso;
    const type = detectReminderType(invoice.due_date, todayIso);
    setReminderType(type);
    setLatestEmailDate(emailedOn);
    setMessage(
      buildReminderSMS({
        contactPerson: client?.contact_person,
        companyName: client?.name,
        invoiceNumber: invoice.invoice_number,
        projectName: project?.name || 'your project',
        outstandingBalance: invoice.amount - invoice.amount_paid,
        dueDate: invoice.due_date,
        paymentRequestSentDate: emailedOn,
      }, template)
    );
    setIsPreparing(false);
  };

  const handleComposeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedInvoiceId || !message.trim() || message.length > 1000 || !confirmed || isPreparing || sendLock.current) return;
    sendLock.current = true;
    setIsSending(true);
    try {
      const sent = await sendSMS({ invoiceId: selectedInvoiceId, message: message.trim() });
      if (sent) setSuccessNotice(true);
      else setConfirmed(false);
    } finally {
      refreshHistory();
      sendLock.current = false;
      setIsSending(false);
    }
  };

  const segmentEstimate = estimateSMSSegments(message);

  return (
    <AppShell requireFounder={true}>
      <div className="space-y-6">
        <WorkspaceHeader eyebrow="Client communications" title="PhilSMS Dispatch Log"
          description="Review reminder attempts and provider statuses before sending another message."
          action={<Button variant="primary" size="sm" onClick={() => setIsComposeModalOpen(true)} leftIcon={<Send className="w-4 h-4" />}>Compose SMS</Button>}
        />

        {/* SMS Status Cards — honest statuses only */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="p-4 sm:p-5 rounded-xl bg-white border border-surface-border">
            <div className="text-xs font-medium text-ink-secondary">PhilSMS Gateway Status</div>
            <div className="text-xl font-bold text-navy mt-1 flex items-center gap-2">
              {!gatewayStatus ? (
                'Status unavailable'
              ) : gatewayStatus.philsmsConfigured ? (
                <>
                  <span className="w-2.5 h-2.5 rounded-full bg-status-success" />
                  Configured
                </>
              ) : (
                <>
                  <span className="w-2.5 h-2.5 rounded-full bg-status-warning" />
                  Simulation mode
                </>
              )}
            </div>
            <div className="text-[11px] text-ink-muted mt-0.5">
              {gatewayStatus === null ? 'Could not confirm gateway configuration.' : gatewayStatus.philsmsConfigured
                ? 'An API key is present. Acceptance and delivery are separate.'
                : 'No API key — messages are logged only and never leave the server.'}
            </div>
          </div>

          <div className="p-4 sm:p-5 rounded-xl bg-white border border-surface-border">
            <div className="text-xs font-medium text-ink-secondary">Total Dispatch Attempts</div>
            <div className="text-2xl font-bold text-navy mt-1">{summary.value ? summary.value.total.toLocaleString() : '—'} Messages</div>
            <div className="text-[11px] text-ink-muted mt-0.5">{summary.error ? 'Counts unavailable — refresh to try again.' : 'Manual and automated attempts, including simulations.'}</div>
          </div>

          <div className="p-4 sm:p-5 rounded-xl bg-white border border-surface-border">
            <div className="text-xs font-medium text-ink-secondary">Delivery Confirmations</div>
            <div className="text-2xl font-bold text-navy mt-1">
              {summary.value ? summary.value.delivered.toLocaleString() : '—'} Delivered
            </div>
            <div className="text-[11px] text-ink-muted mt-0.5">
              Counted only when the provider reports a delivery receipt.
            </div>
          </div>
        </div>

        <WorkspaceFilters title="Find messages" summary={<div className="flex flex-wrap items-center justify-between gap-2 pt-1"><span>{invalidDates ? 'End date must be on or after start date.' : searchSettling ? 'Searching…' : history.loading && !history.items.length ? 'Loading history…' : history.error && !history.items.length ? 'History unavailable' : `${history.items.length} loaded${history.hasMore ? ' · more available' : ''}`}</span>{hasFilters && <button type="button" onClick={clearFilters} className="font-semibold text-navy underline underline-offset-2">Clear filters</button>}</div>}>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <Input label="Search messages" placeholder="Recipient, phone, message or invoice" maxLength={200} value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} leftIcon={<Search className="w-4 h-4" />} />
            <Select label="Status" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="all">All statuses</option><option value="delivered">Delivered</option><option value="sent">Sent / accepted</option><option value="pending">Pending / unconfirmed</option><option value="failed">Failed (not simulated)</option><option value="simulated">Simulation mode</option>
            </Select>
            <Input label="From date (Manila)" type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
            <Input label="To date (Manila)" type="date" aria-invalid={invalidDates} aria-describedby={invalidDates ? "sms-date-error" : undefined} value={toDate} onChange={(e) => setToDate(e.target.value)} />
          </div>
        </WorkspaceFilters>

        <div data-page-guide="list" className="bg-white rounded-xl border border-surface-border overflow-hidden">
          <div className="p-4 border-b border-surface-border/60 flex flex-wrap justify-between items-center gap-3">
            <div><h3 className="font-bold text-navy text-sm">SMS Dispatch History</h3><p className="text-xs text-ink-secondary mt-1">Newest first · times in Manila · sent means accepted, not delivered</p></div>
            <Button variant="secondary" size="sm" onClick={refreshHistory} leftIcon={<RefreshCw className="w-4 h-4" />}>Refresh</Button>
          </div>
          <div className="divide-y divide-surface-border/70" aria-busy={history.loading || searchSettling}>
            {history.items.map((log) => {
              const badge = smsStatusBadge(log);
              return <details key={log.id} className="group">
                <summary className="list-none cursor-pointer p-4 flex items-start gap-3 hover:bg-slate-50/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-navy [&::-webkit-details-marker]:hidden">
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2"><span className="font-bold text-sm text-navy break-words">{log.recipient}</span><Badge variant={badge.variant} size="sm">{badge.label}</Badge></div>
                    <div className="text-xs text-ink-secondary break-words">{log.phone} {log.invoice_number && <>· {log.invoice_number}</>}</div>
                    <div className="text-xs text-ink-muted">{new Date(log.sent_at).toLocaleString('en-PH', {timeZone:'Asia/Manila',year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}</div>
                  </div><ChevronDown aria-hidden="true" className="w-4 h-4 shrink-0 text-ink-secondary mt-1 transition-transform group-open:rotate-180" />
                </summary>
                <div className="px-4 pb-4 space-y-2 text-xs break-words">
                  <p className="text-ink-primary bg-surface-inset/50 p-3 rounded-xl border border-surface-border/60 leading-relaxed whitespace-pre-wrap">{log.message}</p>
                  {log.error_message && <div className="text-status-danger flex items-start gap-1.5"><AlertCircle aria-hidden="true" className="w-3.5 h-3.5 shrink-0" /><span>{log.error_message}</span></div>}
                  {log.invoice_number && <div className="text-ink-muted">Associated milestone: <span className="font-mono text-navy">{log.invoice_number}</span></div>}
                  {log.provider_status && <div className="text-ink-muted">Provider status: {log.provider_status}</div>}
                  {log.provider_message_id && <div className="text-ink-muted">Provider message ID: <span className="font-mono">{log.provider_message_id}</span></div>}
                </div>
              </details>;
            })}
          </div>
          {invalidDates ? <p id="sms-date-error" role="alert" className="p-6 text-sm text-status-danger">Choose an end date on or after the start date.</p> : searchSettling || (history.loading && !history.items.length) ? <p className="p-6 text-sm text-ink-secondary" role="status">Loading SMS history…</p> : history.error ? <div className="p-6 text-sm text-status-danger" role="alert"><p>{history.error}</p><Button variant="secondary" size="sm" onClick={history.retry} className="mt-2">Try again</Button></div> : !history.items.length ? <EmptyState title="No SMS messages to show" description="No SMS dispatch logs match these filters." /> : null}
          {history.hasMore && !history.error && <div className="p-4 border-t border-surface-border/60"><Button variant="secondary" size="sm" onClick={history.loadMore} isLoading={history.loading} disabled={history.loading}>Load more</Button></div>}
          <p className="px-4 pb-4 text-[11px] text-ink-muted">Pages reflect the history at the time each is loaded. Refresh to see new or changed attempts.</p>
        </div>
      </div>

      {/* COMPOSE SMS MODAL */}
      <Modal
        isOpen={isComposeModalOpen}
        onClose={closeComposer}
        dismissOnBackdrop={!isSending}
        dismissOnEscape={!isSending}
        showCloseButton={!isSending}
        title="Compose SMS Payment Reminder"
        description="Select an invoice — the recipient, balance, and wording auto-populate and can be edited before sending."
        maxWidth="xl"
      >
        <form onSubmit={handleComposeSubmit} className="space-y-4 text-xs">
          {successNotice ? (
            <div className="p-4 rounded-xl bg-status-success-bg border border-status-success/20 text-status-success text-center font-bold flex items-center justify-center space-x-2">
              <CheckCircle2 className="w-5 h-5 text-status-success" />
              <span>SMS handed to the gateway — see the dispatch log for its status.</span>
              <Button type="button" variant="secondary" size="sm" onClick={closeComposer}>Done</Button>
            </div>
          ) : (
            <>
              <Select
                label="Invoice (recipient is resolved from the invoice's client)"
                value={selectedInvoiceId}
                disabled={isSending}
                onChange={(e) => handleInvoiceSelect(e.target.value)}
                required
              >
                <option value="">Select an unpaid invoice…</option>
                {eligibleInvoices.map((inv) => {
                  const client = clients.find((c) => c.id === inv.client_id);
                  return (
                    <option key={inv.id} value={inv.id}>
                      {inv.invoice_number} — {client?.name || 'Unknown client'} (
                      {formatPeso(inv.amount - inv.amount_paid)} due {inv.due_date})
                    </option>
                  );
                })}
              </Select>

              {isPreparing && (
                <div className="p-3 rounded-xl bg-surface-inset/60 border border-surface-border text-ink-secondary">
                  Preparing reminder — checking the latest accepted Request for Payment email…
                </div>
              )}

              {selectedInvoice && !isPreparing && (
                <div className="p-4 rounded-2xl bg-surface-inset/60 border border-surface-border grid grid-cols-2 sm:grid-cols-3 gap-3">
                  <div>
                    <div className="text-ink-secondary">Recipient / Contact</div>
                    <div className="font-bold text-navy mt-0.5">
                      {selectedClient?.contact_person || selectedClient?.name || '—'}
                    </div>
                    <div className="font-mono text-[11px] text-ink-secondary">
                      {selectedClient?.phone || 'No number on file'}
                    </div>
                  </div>
                  <div>
                    <div className="text-ink-secondary">Client / Project</div>
                    <div className="font-semibold text-navy mt-0.5">{selectedClient?.name}</div>
                    <div className="text-[11px] text-ink-secondary">{selectedProject?.name}</div>
                  </div>
                  <div>
                    <div className="text-ink-secondary">Invoice</div>
                    <div className="font-mono font-semibold text-navy mt-0.5">
                      {selectedInvoice.invoice_number}
                    </div>
                    <div className="text-[11px] text-ink-secondary">
                      Due {formatDatePH(selectedInvoice.due_date)}
                    </div>
                  </div>
                  <div>
                    <div className="text-ink-secondary">Outstanding Balance</div>
                    <div className="font-bold text-status-danger mt-0.5">
                      {formatPeso(outstandingBalance)}
                    </div>
                  </div>
                  <div>
                    <div className="text-ink-secondary">Reminder Type</div>
                    <div className="font-semibold text-navy mt-0.5">
                      {REMINDER_TYPE_LABELS[reminderType] || reminderType}
                    </div>
                  </div>
                  <div>
                    <div className="text-ink-secondary">Latest Email Accepted by Server</div>
                    <div className="font-semibold text-navy mt-0.5">
                      {emailLookupFailed ? 'Could not verify' : latestEmailDate ? formatDatePH(latestEmailDate) : 'None on record'}
                    </div>
                  </div>
                </div>
              )}

              {templateError && <p role="alert" className="text-status-danger">Could not load the saved SMS template. Choose the invoice again to retry.</p>}
              <Textarea
                label="Message (plain text — edit before sending)"
                rows={5}
                placeholder="Select an invoice to auto-populate the reminder message…"
                value={message}
                onChange={(e) => { setMessage(e.target.value); setConfirmed(false); }}
                maxLength={1000}
                disabled={isPreparing || isSending}
                required
              />

              {message.length > 1000 && <p role="alert" className="text-status-danger">This message is longer than 1,000 characters. Edit it before sending.</p>}
              <div className="text-[11px] text-ink-secondary">
                {segmentEstimate.characterCount} characters · {segmentEstimate.encoding} · est.{' '}
                {segmentEstimate.segments} SMS segment{segmentEstimate.segments === 1 ? '' : 's'}
              </div>

              <p className="text-ink-secondary">If a send is unconfirmed, check the dispatch log and provider before retrying; it may already have been sent.</p>
              <label className="flex items-start space-x-2.5 cursor-pointer p-3 rounded-xl bg-surface-inset/50 border border-surface-border">
                <input
                  type="checkbox"
                  checked={confirmed}
                  disabled={isPreparing || isSending}
                  onChange={(e) => setConfirmed(e.target.checked)}
                  className="mt-0.5 w-4 h-4 rounded border-surface-border text-navy focus:ring-navy/30"
                />
                <span className="text-ink-primary leading-relaxed">
                  I confirm sending this reminder to{' '}
                  <span className="font-bold text-navy">
                    {selectedClient?.contact_person || selectedClient?.name || 'the selected client'}
                  </span>{' '}
                  regarding{' '}
                  <span className="font-mono font-semibold">
                    {selectedInvoice?.invoice_number || 'the selected invoice'}
                  </span>
                  . The phone number is validated and normalized on the server.
                </span>
              </label>

              <div className="pt-3 flex justify-end space-x-2">
                <Button
                  variant="secondary"
                  onClick={closeComposer}
                  type="button"
                  disabled={isSending}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  isLoading={isSending}
                  disabled={!selectedInvoiceId || !message.trim() || message.length > 1000 || !confirmed || isSending || isPreparing}
                  leftIcon={!isSending ? <Send className="w-3.5 h-3.5" /> : undefined}
                >
                  Confirm &amp; Send SMS
                </Button>
              </div>
            </>
          )}
        </form>
      </Modal>
    </AppShell>
  );
}
