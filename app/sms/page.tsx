'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { useDataStore } from '@/lib/data/store';
import { Send, Search, CheckCircle2, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Input, Textarea } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Modal } from '@/components/ui/Modal';
import { createClient } from '@/lib/supabase/client';
import { buildReminderSMS, detectReminderType, estimateSMSSegments } from '@/lib/sms/templates';
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
      return { label: 'Queued', variant: 'warning' };
    case 'failed':
    default:
      return { label: 'Failed', variant: 'danger' };
  }
}

export default function SMSPage() {
  const { smsLogs, invoices, clients, projects, sendSMS } = useDataStore();
  const supabase = useMemo(() => createClient(), []);

  const [searchQuery, setSearchQuery] = useState('');
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

  useEffect(() => {
    let active = true;
    fetch('/api/integrations/status', { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : null))
      .then((status) => {
        if (active) setGatewayStatus(status);
      })
      .catch(() => {
        if (active) setGatewayStatus({ philsmsConfigured: false });
      });
    return () => {
      active = false;
    };
  }, []);

  const filteredLogs = smsLogs.filter(
    (log) =>
      log.recipient.toLowerCase().includes(searchQuery.toLowerCase()) ||
      log.message.toLowerCase().includes(searchQuery.toLowerCase()) ||
      log.phone.includes(searchQuery)
  );

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
    setSelectedInvoiceId(invoiceId);
    setConfirmed(false);
    setLatestEmailDate(null);
    if (!invoiceId) {
      setMessage('');
      return;
    }

    const invoice = invoices.find((i) => i.id === invoiceId);
    if (!invoice) return;
    const client = clients.find((c) => c.id === invoice.client_id);
    const project = projects.find((p) => p.id === invoice.project_id);

    setIsPreparing(true);
    let emailedOn: string | null = null;
    try {
      // Only a genuinely successful (accepted/delivered) initial-request
      // email may be referenced with an "emailed on" date.
      const { data } = await supabase
        .from('email_logs')
        .select('sent_at')
        .eq('invoice_id', invoiceId)
        .eq('template_type', 'initial_request')
        .in('status', ['accepted', 'delivered'])
        .order('sent_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      emailedOn = (data as { sent_at: string | null } | null)?.sent_at ?? null;
    } catch {
      emailedOn = null;
    }

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
      })
    );
    setIsPreparing(false);
  };

  const handleComposeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedInvoiceId || !message.trim() || !confirmed || isSending) return;

    setIsSending(true);
    const sent = await sendSMS({ invoiceId: selectedInvoiceId, message: message.trim() });
    setIsSending(false);
    if (!sent) return;
    setSuccessNotice(true);
    setTimeout(() => {
      setIsComposeModalOpen(false);
      setSuccessNotice(false);
      setSelectedInvoiceId('');
      setMessage('');
      setConfirmed(false);
    }, 1500);
  };

  const segmentEstimate = estimateSMSSegments(message);

  return (
    <AppShell requireFounder={true}>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-surface-border/60">
          <div>
            <h1 className="text-xl sm:text-2xl font-semibold text-navy tracking-tight">
              PhilSMS Dispatch Log
            </h1>
            <p className="text-xs text-ink-secondary mt-0.5">
              Client SMS reminders and gateway delivery history
            </p>
          </div>

          <Button
            variant="primary"
            size="sm"
            onClick={() => setIsComposeModalOpen(true)}
            leftIcon={<Send className="w-4 h-4" />}
          >
            Compose SMS
          </Button>
        </div>

        {/* SMS Status Cards — honest statuses only */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="p-4 sm:p-5 rounded-xl bg-white border border-surface-border">
            <div className="text-xs font-medium text-ink-secondary">PhilSMS Gateway Status</div>
            <div className="text-xl font-bold text-navy mt-1 flex items-center gap-2">
              {!gatewayStatus ? (
                'Checking…'
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
              {gatewayStatus?.philsmsConfigured
                ? 'An API key is present. Sends are handed to PhilSMS.'
                : 'No API key — messages are logged only and never leave the server.'}
            </div>
          </div>

          <div className="p-4 sm:p-5 rounded-xl bg-white border border-surface-border">
            <div className="text-xs font-medium text-ink-secondary">Total Dispatch Attempts</div>
            <div className="text-2xl font-bold text-navy mt-1">{smsLogs.length} Messages</div>
            <div className="text-[11px] text-ink-muted mt-0.5">Manual and automated reminder attempts</div>
          </div>

          <div className="p-4 sm:p-5 rounded-xl bg-white border border-surface-border">
            <div className="text-xs font-medium text-ink-secondary">Delivery Confirmations</div>
            <div className="text-2xl font-bold text-navy mt-1">
              {smsLogs.filter((log) => log.status === 'delivered').length} Delivered
            </div>
            <div className="text-[11px] text-ink-muted mt-0.5">
              Counted only when the provider reports a delivery receipt.
            </div>
          </div>
        </div>

        {/* Search */}
        <div className="max-w-md">
          <Input
            placeholder="Search recipient, mobile number, or message..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            leftIcon={<Search className="w-4 h-4" />}
          />
        </div>

        {/* Logs List */}
        <div className="bg-white rounded-xl border border-surface-border overflow-hidden">
          <div className="p-4 border-b border-surface-border/60">
            <h3 className="font-bold text-navy text-sm">SMS Dispatch History</h3>
          </div>

          <div className="divide-y divide-surface-border/70">
            {filteredLogs.map((log) => {
              const inv = invoices.find((i) => i.id === log.invoice_id);
              const badge = smsStatusBadge(log);

              return (
                <div
                  key={log.id}
                  className="p-5 flex flex-col sm:flex-row sm:items-start justify-between gap-4 hover:bg-slate-50/60 transition-colors"
                >
                  <div className="space-y-1.5 max-w-2xl">
                    <div className="flex items-center flex-wrap gap-2">
                      <span className="font-bold text-sm text-navy">{log.recipient}</span>
                      <span className="text-xs font-mono text-ink-secondary">{log.phone}</span>
                      <Badge variant={badge.variant} size="sm">
                        {badge.label}
                      </Badge>
                    </div>

                    <p className="text-xs text-ink-primary bg-surface-inset/50 p-3 rounded-xl border border-surface-border/60 font-sans leading-relaxed">
                      &ldquo;{log.message}&rdquo;
                    </p>

                    {log.error_message && (
                      <div className="text-[11px] text-status-danger flex items-center gap-1.5">
                        <AlertCircle className="w-3.5 h-3.5" />
                        {log.error_message}
                      </div>
                    )}

                    {inv && (
                      <div className="text-[11px] text-ink-muted">
                        Associated Milestone:{' '}
                        <span className="font-mono text-navy font-semibold">{inv.invoice_number}</span>
                      </div>
                    )}
                  </div>

                  <div className="text-left sm:text-right text-xs text-ink-secondary shrink-0">
                    <div className="font-semibold text-navy">
                      {new Date(log.sent_at).toLocaleDateString('en-PH', {
                        month: 'short',
                        day: 'numeric',
                        year: 'numeric',
                      })}
                    </div>
                    <div className="text-[11px] text-ink-muted mt-0.5">
                      {new Date(log.sent_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </div>
                  </div>
                </div>
              );
            })}

            {filteredLogs.length === 0 && (
              <div className="p-12 text-center text-xs text-ink-secondary">
                No SMS dispatch logs found.
              </div>
            )}
          </div>
        </div>
      </div>

      {/* COMPOSE SMS MODAL */}
      <Modal
        isOpen={isComposeModalOpen}
        onClose={() => setIsComposeModalOpen(false)}
        title="Compose SMS Payment Reminder"
        description="Select an invoice — the recipient, balance, and wording auto-populate and can be edited before sending."
        maxWidth="xl"
      >
        <form onSubmit={handleComposeSubmit} className="space-y-4 text-xs">
          {successNotice ? (
            <div className="p-4 rounded-xl bg-status-success-bg border border-status-success/20 text-status-success text-center font-bold flex items-center justify-center space-x-2">
              <CheckCircle2 className="w-5 h-5 text-status-success" />
              <span>SMS handed to the gateway — see the dispatch log for its honest status.</span>
            </div>
          ) : (
            <>
              <Select
                label="Invoice (recipient is resolved from the invoice's client)"
                value={selectedInvoiceId}
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
                  Preparing reminder — checking the latest successful Request for Payment email…
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
                    <div className="text-ink-secondary">Latest Successful Email</div>
                    <div className="font-semibold text-navy mt-0.5">
                      {latestEmailDate ? formatDatePH(latestEmailDate) : 'None on record'}
                    </div>
                  </div>
                </div>
              )}

              <Textarea
                label="Message (plain text — edit before sending)"
                rows={5}
                placeholder="Select an invoice to auto-populate the reminder message…"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                required
              />

              <div className="text-[11px] text-ink-secondary">
                {segmentEstimate.characterCount} characters · {segmentEstimate.encoding} · est.{' '}
                {segmentEstimate.segments} SMS segment{segmentEstimate.segments === 1 ? '' : 's'}
              </div>

              <label className="flex items-start space-x-2.5 cursor-pointer p-3 rounded-xl bg-surface-inset/50 border border-surface-border">
                <input
                  type="checkbox"
                  checked={confirmed}
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
                  onClick={() => setIsComposeModalOpen(false)}
                  type="button"
                  disabled={isSending}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  isLoading={isSending}
                  disabled={!selectedInvoiceId || !message.trim() || !confirmed || isSending}
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
