'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { useDataStore } from '@/lib/data/store';
import {
  BellRing,
  CheckCircle2,
  PauseCircle,
  PlayCircle,
  Send,
  XCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Textarea } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { WorkspaceHeader } from '@/components/ui/WorkspaceHeader';
import { EmptyState } from '@/components/ui/EmptyState';
import { ReminderQueueStatus } from '@/components/reminders/ReminderQueueStatus';
import { ReminderDeliveryReview } from '@/components/reminders/ReminderDeliveryReview';
import { useToast } from '@/components/ui/Toast';
import { createClient } from '@/lib/supabase/client';
import { buildReminderSMS, estimateSMSSegments } from '@/lib/sms/templates';
import { loadSMSTemplate } from '@/lib/sms/loadTemplate';
import { formatPeso, formatDatePH } from '@/lib/email/format';
import {
  REMINDER_LEAD_DAYS,
  classifyReminderStage,
  daysBetween,
  getManilaClock,
  nextEligibleReminder,
  type ScheduledReminderType,
} from '@/lib/reminders/scheduler';
import type { Invoice } from '@/types';

const TYPE_LABELS: Record<ScheduledReminderType, string> = {
  upcoming: 'Upcoming',
  due_today: 'Due today',
  overdue: 'Overdue',
  follow_up: 'Follow-up',
};

const TYPE_VARIANTS: Record<ScheduledReminderType, 'info' | 'warning' | 'danger' | 'neutral'> = {
  upcoming: 'info',
  due_today: 'warning',
  overdue: 'danger',
  follow_up: 'danger',
};

// Stage boundaries now come from the scheduler so the queue label can never
// disagree with the reminder cadence that actually fires.

export default function RemindersPage() {
  const { invoices, clients, projects, smsLogs, sendSMS, updateInvoice, loadError, refresh } = useDataStore();
  const supabase = useMemo(() => createClient(), []);
  const { showToast } = useToast();
  const sendLock = useRef(false);
  const toggleLock = useRef(false);

  const todayIso = getManilaClock().dateIso;
  const [emailLookup, setEmailLookup] = useState<{ key: string; state: 'loading' | 'ready' | 'error'; dates: Record<string, string> }>({ key: '', state: 'ready', dates: {} });
  const [emailLookupRevision, setEmailLookupRevision] = useState(0);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [smsTemplate, setSmsTemplate] = useState<string | null>(null);
  const [smsTemplateError, setSmsTemplateError] = useState(false);
  const [preparingId, setPreparingId] = useState<string | null>(null);
  const prepareLock = useRef(false);

  // Edit-and-approve modal
  const [editInvoice, setEditInvoice] = useState<Invoice | null>(null);
  const [editMessage, setEditMessage] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [sentNotice, setSentNotice] = useState(false);

  useEffect(() => {
    let active = true;
    const refresh = () => { loadSMSTemplate().then(template => { if (active) { setSmsTemplate(template); setSmsTemplateError(false); } }).catch(() => { if (active) { setSmsTemplate(null); setSmsTemplateError(true); } }); };
    refresh(); window.addEventListener('focus', refresh);
    return () => { active = false; window.removeEventListener('focus', refresh); };
  }, []);

  const now = Date.now();

  const isPaused = (inv: Invoice) =>
    Boolean(inv.reminders_paused_until && new Date(inv.reminders_paused_until).getTime() > now);

  // Queue: unpaid, not cancelled/draft, positive balance, approaching (≤3 days),
  // due today, or overdue. Paused invoices are listed separately below.
  const queue = invoices
    .filter((inv) => {
      if (inv.status === 'paid' || inv.status === 'cancelled' || inv.status === 'draft') return false;
      if (inv.amount - inv.amount_paid <= 0) return false;
      if (dismissed.has(inv.id)) return false;
      if (isPaused(inv)) return false;
      return daysBetween(inv.due_date, todayIso) >= -REMINDER_LEAD_DAYS;
    })
    .sort((a, b) => (a.due_date < b.due_date ? -1 : 1));

  const pausedInvoices = invoices.filter(
    (inv) =>
      isPaused(inv) &&
      inv.status !== 'paid' &&
      inv.status !== 'cancelled' &&
      inv.status !== 'draft' &&
      inv.amount - inv.amount_paid > 0
  );

  // Track the actual queue membership, not merely the invoice count.
  const queueIds = queue.map((inv) => inv.id).sort().join(',');
  const emailLookupKey = `${emailLookupRevision}:${queueIds}`;
  const emailLookupCurrent = emailLookup.key === emailLookupKey;
  const emailDates = emailLookupCurrent && emailLookup.state === 'ready' ? emailLookup.dates : {};
  useEffect(() => {
    const onFocus = () => setEmailLookupRevision(revision => revision + 1);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);
  useEffect(() => {
    const ids = queueIds ? queueIds.split(',') : [];
    if (ids.length === 0) { setEmailLookup({key: emailLookupKey, state:'ready', dates:{}}); return; }
    let active = true;
    setEmailLookup({key: emailLookupKey, state:'loading', dates:{}});

    supabase
      .from('email_logs')
      .select('invoice_id, sent_at')
      .in('invoice_id', ids)
      .eq('template_type', 'initial_request')
      .in('status', ['accepted', 'delivered'])
      .order('sent_at', { ascending: false })
      .then(({ data, error }: { data: Array<{ invoice_id: string; sent_at: string | null }> | null; error: unknown }) => {
        if (!active) return;
        if (error || !Array.isArray(data)) { setEmailLookup({key:emailLookupKey,state:'error',dates:{}}); return; }
        const latest: Record<string, string> = {};
        for (const row of data) {
          if (row.sent_at && !latest[row.invoice_id]) latest[row.invoice_id] = row.sent_at;
        }
        setEmailLookup({key:emailLookupKey,state:'ready',dates:latest});
      }, () => { if (active) setEmailLookup({key:emailLookupKey,state:'error',dates:{}}); });

    return () => {
      active = false;
    };
  }, [queueIds, emailLookupKey, supabase]);

  const latestSmsDate = (invoiceId: string): string | null => {
    const log = smsLogs.find(
      (l) => l.invoice_id === invoiceId && !l.simulated && (l.status === 'sent' || l.status === 'delivered')
    );
    return log?.sent_at || null;
  };

  const buildMessageFor = (inv: Invoice, template: string): string => {
    const client = clients.find((c) => c.id === inv.client_id);
    const project = projects.find((p) => p.id === inv.project_id);
    return buildReminderSMS({
      contactPerson: client?.contact_person,
      companyName: client?.name,
      invoiceNumber: inv.invoice_number,
      projectName: project?.name || 'your project',
      outstandingBalance: inv.amount - inv.amount_paid,
      dueDate: inv.due_date,
      paymentRequestSentDate: emailDates[inv.id] || null,
    }, template);
  };

  const prepareMessage = async (inv: Invoice) => {
    if (prepareLock.current) return;
    prepareLock.current = true; setPreparingId(inv.id);
    try {
      const template = await loadSMSTemplate();
      setSmsTemplate(template); setSmsTemplateError(false); setEditInvoice(inv); setEditMessage(buildMessageFor(inv, template)); setConfirmed(false); setSentNotice(false);
    } catch { setSmsTemplate(null); setSmsTemplateError(true); showToast('error', 'Could not load the saved SMS template. Try again.'); }
    finally { prepareLock.current = false; setPreparingId(null); }
  };

  const handleApproveAndSend = async (inv: Invoice, message: string) => {
    if (sendLock.current || !confirmed || !message.trim() || message.length > 1000) return;
    sendLock.current = true;
    setSendingId(inv.id);
    try {
      if (await sendSMS({ invoiceId: inv.id, message })) setSentNotice(true);
      else setConfirmed(false);
    } finally {
      sendLock.current = false;
      setSendingId(null);
    }
  };

  const changeReminderSetting = async (inv: Invoice, patch: Partial<Invoice>, successMessage: string) => {
    if (toggleLock.current) return;
    toggleLock.current = true;
    setTogglingId(inv.id);
    try {
      if (await updateInvoice(inv.id, patch)) showToast('success', successMessage);
      else showToast('error', 'Change not confirmed. Refresh the invoice before retrying.');
    } finally {
      toggleLock.current = false;
      setTogglingId(null);
    }
  };
  const handlePause = (inv: Invoice, days: number) => changeReminderSetting(inv, {
    reminders_paused_until: new Date(Date.now() + days * 86_400_000).toISOString(),
  }, 'Reminders paused for 7 days.');
  const handleResume = (inv: Invoice) => changeReminderSetting(inv, { reminders_paused_until: null }, 'Reminder pause removed.');
  const handleToggleAutomatic = (inv: Invoice) => changeReminderSetting(inv, {
    automatic_reminders_enabled: !inv.automatic_reminders_enabled,
  }, inv.automatic_reminders_enabled ? 'Automatic reminder preference turned off for this invoice. A message already in progress may still be sent.' : 'Invoice preference saved. Check Settings for the overall automatic reminder status.');

  return (
    <AppShell requireFounder={true}>
      <div className="space-y-6">
        <WorkspaceHeader eyebrow="Client communications" title="Reminder Queue"
          description="Review upcoming, due and overdue invoices before contacting clients."
          action={<ReminderQueueStatus />}
        />
        <p className="text-xs text-ink-secondary">Invoice preferences do not turn on automatic reminders. Status is checked when this page opens or returns to focus. Manual sends remain separate.</p>
        {loadError && <div role="alert" className="rounded-xl border border-status-warning/30 bg-status-warning-bg p-4 text-xs text-navy flex flex-wrap items-center justify-between gap-3"><span>Some records could not be loaded. The reminder queue may be incomplete.</span><Button type="button" variant="secondary" size="sm" onClick={() => void refresh()}>Retry loading</Button></div>}
        {emailLookupCurrent && emailLookup.state === 'error' && <div role="alert" className="rounded-xl border border-status-warning/30 bg-status-warning-bg p-4 text-xs text-navy flex flex-wrap items-center justify-between gap-3"><span>Could not check the latest payment-request emails.</span><Button type="button" variant="secondary" size="sm" onClick={() => setEmailLookupRevision(revision => revision + 1)}>Retry email history</Button></div>}
        {dismissed.size > 0 && <div className="text-xs text-ink-secondary">{dismissed.size} reminder(s) hidden in this session. <button type="button" className="font-semibold text-navy underline" onClick={() => setDismissed(new Set())}>Restore hidden reminders</button></div>}

        <ReminderDeliveryReview />

        {/* Queue */}
        <div className="space-y-4">
          {queue.length === 0 && !loadError && (
            <div className="bg-white rounded-xl border border-surface-border">
              <EmptyState title="No reminders to show" description="No reminders in this view. Eligible invoices appear here unless paused or hidden in this session." icon={<BellRing className="relative h-7 w-7" />} />
            </div>
          )}

          {queue.map((inv) => {
            const client = clients.find((c) => c.id === inv.client_id);
            const project = projects.find((p) => p.id === inv.project_id);
            const balance = inv.amount - inv.amount_paid;
            const type = classifyReminderStage(inv.due_date, todayIso);
            const preview = smsTemplate ? buildMessageFor(inv, smsTemplate) : '';
            const estimate = estimateSMSSegments(preview);
            const next = nextEligibleReminder(inv.due_date, todayIso);
            const lastSms = latestSmsDate(inv.id);

            return (
              <div
                key={inv.id}
                className="bg-white rounded-xl border border-surface-border p-5 space-y-4"
              >
                <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4">
                  <div className="space-y-1 min-w-0">
                    <div className="flex items-center flex-wrap gap-2">
                      <span className="font-mono font-bold text-sm text-navy">{inv.invoice_number}</span>
                      <Badge variant={TYPE_VARIANTS[type]} size="sm">
                        {TYPE_LABELS[type]}
                      </Badge>
                      {inv.automatic_reminders_enabled && (
                        <Badge variant="info" size="sm">Automatic reminder preference on</Badge>
                      )}
                    </div>
                    <div className="text-xs text-ink-secondary">
                      <span className="font-semibold text-navy">{client?.name || 'Client unavailable'}</span>
                      {client?.contact_person ? ` · ${client.contact_person}` : ''} ·{' '}
                      {project?.name || 'Project unavailable'}
                    </div>
                    <div className="text-xs text-ink-secondary">
                      Balance{' '}
                      <span className="font-bold text-status-danger">{formatPeso(balance)}</span> ·
                      Due <span className="font-semibold text-navy">{formatDatePH(inv.due_date)}</span>
                    </div>
                    <div className="text-[11px] text-ink-muted">
                      Latest accepted payment-request email:{' '}
                      {!emailLookupCurrent || emailLookup.state === 'loading' ? 'checking…' : emailLookup.state === 'error' ? 'could not verify' : emailDates[inv.id] ? formatDatePH(emailDates[inv.id]) : 'none in loaded history'} ·
                      Latest accepted SMS: {lastSms ? formatDatePH(lastSms) : 'none in loaded history'} · Planned schedule
                      date (when available): {formatDatePH(next.dateIso)} ({TYPE_LABELS[next.type]})
                    </div>
                  </div>

                  <div className="flex items-center flex-wrap gap-2 shrink-0">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => void prepareMessage(inv)}
                      disabled={Boolean(preparingId)}
                    >
                      Edit
                    </Button>
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => void prepareMessage(inv)}
                      disabled={Boolean(preparingId)}
                      leftIcon={<Send className="w-3.5 h-3.5" />}
                    >
                      Approve &amp; Send
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setDismissed((prev) => new Set([...prev, inv.id]))}
                      leftIcon={<XCircle className="w-3.5 h-3.5" />}
                    >
                      Hide for now
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handlePause(inv, 7)}
                      isLoading={togglingId === inv.id}
                      disabled={Boolean(togglingId)}
                      leftIcon={<PauseCircle className="w-3.5 h-3.5" />}
                    >
                      Pause 7 days
                    </Button>
                  </div>
                </div>

                <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 text-xs text-ink-primary leading-relaxed">
                  {preview || (smsTemplateError ? 'SMS template unavailable. Select Edit or Approve & Send to retry.' : 'Loading SMS template…')}
                </div>
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-[11px] text-ink-secondary">
                  <span>
                    {estimate.characterCount} characters · {estimate.encoding} · est.{' '}
                    {estimate.segments} segment{estimate.segments === 1 ? '' : 's'}
                  </span>
                  <button
                    type="button"
                    onClick={() => handleToggleAutomatic(inv)}
                    className="text-navy font-semibold hover:underline text-left"
                    disabled={Boolean(togglingId)}
                  >
                    {inv.automatic_reminders_enabled
                      ? 'Disable automatic reminders for this invoice'
                      : 'Allow automatic reminders for this invoice'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        <p className="text-[11px] text-ink-muted">Planned dates are not guaranteed send times; pauses, business hours, missed dates and other safety checks can change them. Message history may not include older records.</p>

        {/* Paused invoices */}
        {pausedInvoices.length > 0 && (
          <div className="bg-white rounded-xl border border-surface-border overflow-hidden">
            <div className="p-4 border-b border-surface-border/60">
              <h3 className="font-bold text-navy text-sm">Paused Reminders</h3>
            </div>
            <div className="divide-y divide-surface-border/70">
              {pausedInvoices.map((inv) => {
                const client = clients.find((c) => c.id === inv.client_id);
                return (
                  <div key={inv.id} className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
                    <div>
                      <span className="font-mono font-bold text-navy">{inv.invoice_number}</span>
                      <span className="text-ink-secondary"> · {client?.name} · </span>
                      <Badge variant="warning" size="sm">Paused</Badge>
                      <span className="text-ink-muted">
                        {' '}until {formatDatePH(inv.reminders_paused_until || undefined)}
                      </span>
                    </div>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => handleResume(inv)}
                      isLoading={togglingId === inv.id}
                      disabled={Boolean(togglingId)}
                      leftIcon={<PlayCircle className="w-3.5 h-3.5" />}
                    >
                      Resume Reminders
                    </Button>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* EDIT / APPROVE MODAL */}
      <Modal
        isOpen={Boolean(editInvoice)}
        onClose={() => setEditInvoice(null)}
        dismissOnBackdrop={!sendingId}
        dismissOnEscape={!sendingId}
        showCloseButton={!sendingId}
        title="Approve Payment Reminder SMS"
        description="Review and edit the reminder before Founder-approved dispatch."
        maxWidth="xl"
      >
        {editInvoice && (
          <div className="space-y-4 text-xs">
            {sentNotice ? (
              <div className="p-4 rounded-xl bg-status-success-bg border border-status-success/20 text-status-success text-center font-bold flex items-center justify-center space-x-2">
                <CheckCircle2 className="w-5 h-5 text-status-success" />
                <span>Reminder handed to the gateway — check the SMS log for its status.</span>
                <Button type="button" variant="secondary" size="sm" onClick={() => { setEditInvoice(null); setSentNotice(false); }}>Done</Button>
              </div>
            ) : (
              <>
                <div className="p-3 rounded-xl bg-surface-inset/60 border border-surface-border space-y-1">
                  <div className="flex justify-between">
                    <span className="text-ink-secondary">Recipient:</span>
                    <span className="font-bold text-navy">
                      {clients.find((c) => c.id === editInvoice.client_id)?.contact_person ||
                        clients.find((c) => c.id === editInvoice.client_id)?.name}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-ink-secondary">Outstanding Balance:</span>
                    <span className="font-bold text-status-danger">
                      {formatPeso(editInvoice.amount - editInvoice.amount_paid)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-ink-secondary">Due Date:</span>
                    <span className="font-semibold text-navy">{formatDatePH(editInvoice.due_date)}</span>
                  </div>
                </div>

                <Textarea
                  label="Message"
                  rows={5}
                  value={editMessage}
                  onChange={(e) => { setEditMessage(e.target.value); setConfirmed(false); }}
                  maxLength={1000}
                  disabled={Boolean(sendingId)}
                />

                {editMessage.length > 1000 && <p role="alert" className="text-status-danger">This message is longer than 1,000 characters. Edit it before sending.</p>}
                {(() => {
                  const estimate = estimateSMSSegments(editMessage);
                  return (
                    <div className="text-[11px] text-ink-secondary">
                      {estimate.characterCount} characters · {estimate.encoding} · est.{' '}
                      {estimate.segments} segment{estimate.segments === 1 ? '' : 's'}
                    </div>
                  );
                })()}

                <p className="text-ink-secondary">If a send is unconfirmed, check the dispatch log and provider before retrying; it may already have been sent.</p>
                <label className="flex items-start space-x-2.5 cursor-pointer p-3 rounded-xl bg-surface-inset/50 border border-surface-border">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    disabled={Boolean(sendingId)}
                    onChange={(e) => setConfirmed(e.target.checked)}
                    className="mt-0.5 w-4 h-4 rounded border-surface-border text-navy focus:ring-navy/30"
                  />
                  <span className="leading-relaxed">
                    I approve sending this reminder for{' '}
                    <span className="font-mono font-semibold">{editInvoice.invoice_number}</span>.
                  </span>
                </label>

                <div className="flex justify-end space-x-2 pt-2">
                  <Button
                    variant="secondary"
                    onClick={() => setEditInvoice(null)}
                    disabled={sendingId === editInvoice.id}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="primary"
                    onClick={() => handleApproveAndSend(editInvoice, editMessage.trim())}
                    isLoading={sendingId === editInvoice.id}
                    disabled={!confirmed || !editMessage.trim() || editMessage.length > 1000 || sendingId === editInvoice.id}
                    leftIcon={sendingId !== editInvoice.id ? <Send className="w-3.5 h-3.5" /> : undefined}
                  >
                    Approve &amp; Send Now
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
