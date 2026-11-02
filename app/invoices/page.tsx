'use client';

import React, { useMemo, useState } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { useDataStore } from '@/lib/data/store';
import { Invoice, InvoiceStatus } from '@/types';
import {
  Plus,
  Search,
  CheckCircle2,
  Send,
  Eye,
  DollarSign,
  Printer,
  Mail,
  History,
  MoreHorizontal,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { FilterSummary } from '@/components/ui/FilterSummary';
import { WorkspaceHeader } from '@/components/ui/WorkspaceHeader';
import { WorkspaceFilters } from '@/components/ui/WorkspaceFilters';
import { Badge } from '@/components/ui/Badge';
import { Input, Textarea } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { AsintaEmblem, AsintaWordmark } from '@/components/ui/AsintaLogo';
import { RequestPaymentModal } from '@/components/email/RequestPaymentModal';
import { EmailHistoryModal } from '@/components/email/EmailHistoryModal';
import { buildReminderSMS, estimateSMSSegments } from '@/lib/sms/templates';
import { createClient as createSupabaseBrowserClient } from '@/lib/supabase/client';
import { formatPeso } from '@/lib/email/format';

function getNextInvoiceNumber(invoices: Invoice[], year: number): string {
  const prefix = `ASINTA-${year}-`;
  const maxSequence = invoices.reduce((maximum, invoice) => {
    if (!invoice.invoice_number.startsWith(prefix)) return maximum;
    const sequence = Number.parseInt(invoice.invoice_number.slice(prefix.length), 10);
    return Number.isNaN(sequence) ? maximum : Math.max(maximum, sequence);
  }, 0);

  return `${prefix}${String(maxSequence + 1).padStart(3, '0')}`;
}

const today = () => new Date().toISOString().split('T')[0];
const defaultDueDate = () => new Date(Date.now() + 15 * 86400000).toISOString().split('T')[0];

export default function InvoicesPage() {
  const { showToast } = useToast();
  const [isCreating, setIsCreating] = useState(false);
  const [isRecordingPayment, setIsRecordingPayment] = useState(false);
  const createLock = React.useRef(false);
  const paymentLock = React.useRef(false);
  const {
    invoices,
    projects,
    clients,
    createInvoice,
    recordInvoicePayment,
    sendSMS,
  } = useDataStore();

  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');

  // Modals state
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [isPaymentModalOpen, setIsPaymentModalOpen] = useState(false);
  const [isPreviewModalOpen, setIsPreviewModalOpen] = useState(false);
  const [isSmsModalOpen, setIsSmsModalOpen] = useState(false);
  const [isEmailModalOpen, setIsEmailModalOpen] = useState(false);
  const [isEmailHistoryOpen, setIsEmailHistoryOpen] = useState(false);
  const [expandedInvoiceActions, setExpandedInvoiceActions] = useState<string | null>(null);

  const [selectedInvoice, setSelectedInvoice] = useState<Invoice | null>(null);
  const [paymentAmount, setPaymentAmount] = useState('');
  const [smsSending, setSmsSending] = useState(false);
  const smsSendLock = React.useRef(false);
  const smsPrepareVersion = React.useRef(0);
  const [smsSuccess, setSmsSuccess] = useState<string | null>(null);
  const [smsMessage, setSmsMessage] = useState('');
  const supabaseBrowser = useMemo(() => createSupabaseBrowserClient(), []);

  /**
   * Prepares the SMS reminder for an invoice: looks up the latest SUCCESSFUL
   * (accepted/delivered) Request for Payment email so the SMS only claims
   * "emailed on …" when a real email log exists.
   */
  const openSmsModal = async (inv: Invoice) => {
    const version = ++smsPrepareVersion.current;
    setSmsSuccess(null);

    const client = clients.find((c) => c.id === inv.client_id);
    const proj = projects.find((p) => p.id === inv.project_id);

    let emailedOn: string | null = null;
    try {
      const { data } = await supabaseBrowser
        .from('email_logs')
        .select('sent_at')
        .eq('invoice_id', inv.id)
        .eq('template_type', 'initial_request')
        .in('status', ['accepted', 'delivered'])
        .order('sent_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      emailedOn = (data as { sent_at: string | null } | null)?.sent_at ?? null;
    } catch {
      emailedOn = null;
    }

    if (version !== smsPrepareVersion.current) return;
    setSelectedInvoice(inv);
    setSmsMessage(
      buildReminderSMS({
        contactPerson: client?.contact_person,
        companyName: client?.name,
        invoiceNumber: inv.invoice_number,
        projectName: proj?.name || 'your project',
        outstandingBalance: inv.amount - inv.amount_paid,
        dueDate: inv.due_date,
        paymentRequestSentDate: emailedOn,
      })
    );
    setIsSmsModalOpen(true);
  };

  // New Invoice Form
  const initialIssueDate = today();
  const [formData, setFormData] = useState({
    invoice_number: getNextInvoiceNumber(invoices, Number(initialIssueDate.slice(0, 4))),
    project_id: '',
    client_id: '',
    amount: '',
    issue_date: initialIssueDate,
    due_date: defaultDueDate(),
    notes: '',
    status: 'pending' as InvoiceStatus,
  });

  const formatPHP = formatPeso;

  const filteredInvoices = invoices.filter((inv) => {
    const proj = projects.find((p) => p.id === inv.project_id);
    const client = clients.find((c) => c.id === inv.client_id);
    const matchesSearch =
      inv.invoice_number.toLowerCase().includes(searchQuery.toLowerCase()) ||
      proj?.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      client?.name.toLowerCase().includes(searchQuery.toLowerCase());

    const matchesStatus = statusFilter === 'all' || inv.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const handleProjectSelectInForm = (projId: string) => {
    const proj = projects.find((p) => p.id === projId);
    setFormData({
      ...formData,
      project_id: projId,
      client_id: proj ? proj.client_id : '',
    });
  };

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (createLock.current || !formData.project_id || !formData.amount) return;
    createLock.current = true;
    setIsCreating(true);
    try {
      const issueYear = Number(formData.issue_date.slice(0, 4)) || new Date().getFullYear();
      const invoiceNumber = getNextInvoiceNumber(invoices, issueYear);
      const created = await createInvoice({
        invoice_number: invoiceNumber,
        project_id: formData.project_id,
        client_id: formData.client_id,
        amount: parseFloat(formData.amount),
        amount_paid: 0,
        issue_date: formData.issue_date,
        due_date: formData.due_date,
        status: formData.status,
        notes: formData.notes,
        automatic_reminders_enabled: false,
        reminders_paused_until: null,
      });

      if (created) {
        showToast('success', 'Invoice created.');
        setIsCreateModalOpen(false);
        const nextIssueDate = today();
        const nextYear = Number(nextIssueDate.slice(0, 4));
        setFormData({
          invoice_number: getNextInvoiceNumber([...invoices, created], nextYear),
          project_id: '',
          client_id: '',
          amount: '',
          issue_date: nextIssueDate,
          due_date: defaultDueDate(),
          notes: '',
          status: 'pending',
        });
      }
    } catch {
      showToast('error', 'Could not confirm whether the invoice was created. Refresh and check the invoice list before trying again.');
    } finally {
      createLock.current = false;
      setIsCreating(false);
    }
  };

  const handleRecordPayment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (paymentLock.current || !selectedInvoice || !paymentAmount) return;
    paymentLock.current = true;
    setIsRecordingPayment(true);
    try {
      const success = await recordInvoicePayment(selectedInvoice.id, parseFloat(paymentAmount));
      if (success) {
        showToast('success', 'Payment recorded.');
        setIsPaymentModalOpen(false);
        setPaymentAmount('');
      }
    } catch {
      showToast('error', 'Could not confirm whether the payment was recorded. Refresh and check the invoice before trying again.');
    } finally {
      paymentLock.current = false;
      setIsRecordingPayment(false);
    }
  };

  const handleSendPhilSMS = async () => {
    if (!selectedInvoice || !smsMessage.trim() || smsSendLock.current) return;
    smsSendLock.current = true;
    setSmsSending(true);
    try {
      const sent = await sendSMS({ invoiceId: selectedInvoice.id, message: smsMessage.trim() });
      if (sent) setSmsSuccess('The SMS was handed to the PhilSMS gateway. Check the SMS log for its status.');
    } finally {
      smsSendLock.current = false;
      setSmsSending(false);
    }
  };

  return (
    <AppShell requireFounder={true}>
      <div className="space-y-6">
        <WorkspaceHeader
          eyebrow="Client billing"
          title="Invoices & Billing"
          description="Review progress billing, outstanding balances and client follow-ups."
          action={
            <Button
              variant="primary"
              size="md"
              onClick={() => {
                const issueYear = Number(formData.issue_date.slice(0, 4)) || new Date().getFullYear();
                setFormData((current) => ({ ...current, invoice_number: getNextInvoiceNumber(invoices, issueYear) }));
                setIsCreateModalOpen(true);
              }}
              leftIcon={<Plus className="w-4 h-4" />}
            >
              New Invoice
            </Button>
          }
        />

        <WorkspaceFilters
          title="Find an invoice"
          summary={<FilterSummary count={filteredInvoices.length} itemName="invoice" active={Boolean(searchQuery) || statusFilter !== 'all'} onClear={() => { setSearchQuery(''); setStatusFilter('all'); }} />}
        >
          <div className="flex flex-col sm:flex-row sm:items-end gap-3">
            <div className="w-full sm:w-80">
              <Input
                label="Search invoices"
                placeholder="Search invoice number, client, project..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                leftIcon={<Search className="w-4 h-4" />}
              />
            </div>

            <div className="w-full sm:w-48">
              <Select
                label="Status"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                options={[
                  { label: 'All Statuses', value: 'all' },
                  { label: 'Pending', value: 'pending' },
                  { label: 'Partially Paid', value: 'partially_paid' },
                  { label: 'Paid', value: 'paid' },
                  { label: 'Overdue', value: 'overdue' },
                  { label: 'Draft', value: 'draft' },
                  { label: 'Cancelled', value: 'cancelled' },
                ]}
              />
            </div>
          </div>
        </WorkspaceFilters>

        {/* Invoices List / Table */}
        <div className="bg-white rounded-xl border border-surface-border overflow-hidden">
          <div className="divide-y divide-surface-border/70">
            {filteredInvoices.map((inv) => {
              const proj = projects.find((p) => p.id === inv.project_id);
              const client = clients.find((c) => c.id === inv.client_id);
              const balance = inv.amount - inv.amount_paid;

              const statusBadgeVariant =
                inv.status === 'paid'
                  ? 'success'
                  : inv.status === 'overdue'
                  ? 'danger'
                  : inv.status === 'partially_paid'
                  ? 'warning'
                  : 'neutral';

              return (
                <div
                  key={inv.id}
                  className="p-4 sm:p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4 hover:bg-surface transition-colors"
                >
                  {/* Left: Invoice info */}
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-center space-x-2">
                      <span className="font-mono font-bold text-sm text-navy">{inv.invoice_number}</span>
                      <Badge variant={statusBadgeVariant} size="sm">
                        {inv.status.replace('_', ' ')}
                      </Badge>
                    </div>
                    <div className="break-words font-semibold text-sm text-ink-primary">{proj?.name}</div>
                    <div className="break-words text-xs text-ink-secondary">
                      Client: <span className="font-medium text-navy">{client?.name}</span> ({client?.contact_person})
                    </div>
                    {inv.notes && (
                      <div className="break-words text-xs text-ink-muted italic pt-0.5">{inv.notes}</div>
                    )}
                  </div>

                  {/* Middle: Dates & Amounts */}
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 text-xs py-2 lg:py-0 border-y lg:border-none border-surface-border/50">
                    <div>
                      <div className="text-ink-secondary">Issue Date</div>
                      <div className="font-semibold text-navy mt-0.5">{inv.issue_date}</div>
                    </div>

                    <div>
                      <div className="text-ink-secondary">Due Date</div>
                      <div className={`font-semibold mt-0.5 ${inv.status === 'overdue' ? 'text-status-danger' : 'text-navy'}`}>
                        {inv.due_date}
                      </div>
                    </div>

                    <div className="col-span-2 sm:col-span-1">
                      <div className="text-ink-secondary">Invoice total</div>
                      <div className="font-bold tabular-nums text-navy mt-0.5">{formatPHP(inv.amount)}</div>
                      <div className="text-[11px] font-medium text-ink-secondary">Balance: {formatPHP(Math.max(0, balance))}</div>
                    </div>
                  </div>

                  {/* Primary invoice actions, with communication/history actions tucked away. */}
                  <div className="flex min-w-0 flex-col items-start gap-2 lg:items-end">
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => {
                          setSelectedInvoice(inv);
                          setIsPreviewModalOpen(true);
                        }}
                        leftIcon={<Eye className="w-3.5 h-3.5" />}
                      >
                        View invoice
                      </Button>

                      {inv.status !== 'paid' && (
                        <Button
                          variant="primary"
                          size="sm"
                          onClick={() => {
                            setSelectedInvoice(inv);
                            setPaymentAmount(String(balance));
                            setIsPaymentModalOpen(true);
                          }}
                          leftIcon={<DollarSign className="w-3.5 h-3.5" />}
                        >
                          Record payment
                        </Button>
                      )}

                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label={`More actions for ${inv.invoice_number}`}
                        aria-expanded={expandedInvoiceActions === inv.id}
                        aria-controls={
                          expandedInvoiceActions === inv.id ? `invoice-actions-${inv.id}` : undefined
                        }
                        onClick={() =>
                          setExpandedInvoiceActions((current) =>
                            current === inv.id ? null : inv.id
                          )
                        }
                        leftIcon={<MoreHorizontal className="w-4 h-4" />}
                      >
                        More
                      </Button>
                    </div>

                    {expandedInvoiceActions === inv.id && (
                      <div
                        id={`invoice-actions-${inv.id}`}
                        role="group"
                        aria-label={`More actions for ${inv.invoice_number}`}
                        className="flex w-full flex-wrap gap-2 rounded-lg border border-surface-border bg-surface p-2 lg:w-auto lg:justify-end"
                      >
                        {inv.status !== 'paid' && inv.status !== 'cancelled' && (
                          <>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                setSelectedInvoice(inv);
                                setIsEmailModalOpen(true);
                                setExpandedInvoiceActions(null);
                              }}
                              leftIcon={<Mail className="w-3.5 h-3.5" />}
                            >
                              Send payment request
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                setExpandedInvoiceActions(null);
                                void openSmsModal(inv);
                              }}
                              leftIcon={<Send className="w-3.5 h-3.5" />}
                            >
                              Send SMS reminder
                            </Button>
                          </>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setSelectedInvoice(inv);
                            setIsEmailHistoryOpen(true);
                            setExpandedInvoiceActions(null);
                          }}
                          leftIcon={<History className="w-3.5 h-3.5" />}
                        >
                          Email history
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}

            {filteredInvoices.length === 0 && (
              <div className="p-12 text-center text-xs text-ink-secondary">
                {invoices.length === 0 ? 'No invoices have been recorded yet.' : 'No invoices match the current search or filters. Clear filters to see all invoices.'}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* CREATE INVOICE MODAL */}
      <Modal
        isOpen={isCreateModalOpen}
        onClose={() => setIsCreateModalOpen(false)}
        dismissOnBackdrop={!isCreating}
        dismissOnEscape={!isCreating}
        showCloseButton={!isCreating}
        title="Create Milestone Progress Invoice"
        description="Generate a new progress billing statement for Asinta Architects."
        maxWidth="lg"
      >
        <form onSubmit={handleCreateSubmit} className="space-y-4 text-xs">
          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Invoice Number"
              value={formData.invoice_number}
              readOnly
              required
            />
            <Select
              label="Associated Project"
              value={formData.project_id}
              onChange={(e) => handleProjectSelectInForm(e.target.value)}
              required
            >
              <option value="">Select Project Site...</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </div>

          <Input
            label="Billing Milestone Description"
            placeholder="e.g. 25% 2nd Floor Slab & Structural Framing Progress Billing"
            value={formData.notes}
            onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
            required
          />

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <Input
              label="Invoice Amount (PHP ₱)"
              type="number"
              min="0.01"
              step="0.01"
              placeholder="1500000"
              value={formData.amount}
              onChange={(e) => setFormData({ ...formData, amount: e.target.value })}
              required
            />
            <Input
              label="Issue Date"
              type="date"
              value={formData.issue_date}
              onChange={(e) => {
                const issueDate = e.target.value;
                const year = Number(issueDate.slice(0, 4)) || new Date().getFullYear();
                setFormData({
                  ...formData,
                  issue_date: issueDate,
                  invoice_number: getNextInvoiceNumber(invoices, year),
                });
              }}
              required
            />
            <Input
              label="Due Date"
              type="date"
              value={formData.due_date}
              onChange={(e) => setFormData({ ...formData, due_date: e.target.value })}
              required
            />
          </div>

          <div className="pt-4 flex justify-end space-x-2">
            <Button type="button" variant="secondary" onClick={() => setIsCreateModalOpen(false)} disabled={isCreating}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" isLoading={isCreating}>
              {isCreating ? 'Creating invoice…' : 'Generate Invoice'}
            </Button>
          </div>
        </form>
      </Modal>

      {/* RECORD PAYMENT MODAL */}
      <Modal
        isOpen={isPaymentModalOpen}
        onClose={() => setIsPaymentModalOpen(false)}
        dismissOnBackdrop={!isRecordingPayment}
        dismissOnEscape={!isRecordingPayment}
        showCloseButton={!isRecordingPayment}
        title="Record Client Payment"
        description="Log partial or full settlement for progress billing."
      >
        {selectedInvoice && (
          <form onSubmit={handleRecordPayment} className="space-y-4 text-xs">
            <div className="p-3 rounded-xl bg-surface-inset border border-surface-border space-y-1">
              <div className="font-bold text-navy font-mono">{selectedInvoice.invoice_number}</div>
              <div className="break-words text-ink-secondary">
                {projects.find((project) => project.id === selectedInvoice.project_id)?.name || 'Project unavailable'} · {clients.find((client) => client.id === selectedInvoice.client_id)?.name || 'Client unavailable'}
              </div>
              <div className="text-ink-secondary">
                Total: {formatPHP(selectedInvoice.amount)} · Currently Paid: {formatPHP(selectedInvoice.amount_paid)}
              </div>
              <div className="font-semibold text-status-warning">
                Remaining Balance: {formatPHP(selectedInvoice.amount - selectedInvoice.amount_paid)}
              </div>
            </div>

            <Input
              label="Payment Amount Received (PHP ₱)"
              type="number"
              value={paymentAmount}
              onChange={(e) => setPaymentAmount(e.target.value)}
              required
              min="0.01"
              step="0.01"
              max={selectedInvoice.amount - selectedInvoice.amount_paid}
            />

            <div className="pt-2 flex justify-end space-x-2">
              <Button type="button" variant="secondary" onClick={() => setIsPaymentModalOpen(false)} disabled={isRecordingPayment}>
                Cancel
              </Button>
              <Button variant="primary" type="submit" isLoading={isRecordingPayment}>
                {isRecordingPayment ? 'Recording payment…' : 'Confirm Payment Receipt'}
              </Button>
            </div>
          </form>
        )}
      </Modal>

      {/* ARCHITECTURAL INVOICE PREVIEW & PRINT MODAL */}
      <Modal
        isOpen={isPreviewModalOpen}
        onClose={() => setIsPreviewModalOpen(false)}
        title="Asinta Architects — Official Billing Document"
        description="Printable client invoice & progress billing certificate."
        maxWidth="2xl"
      >
        {selectedInvoice && (() => {
          const proj = projects.find((p) => p.id === selectedInvoice.project_id);
          const client = clients.find((c) => c.id === selectedInvoice.client_id);
          const balance = selectedInvoice.amount - selectedInvoice.amount_paid;

          return (
            <div className="space-y-6">
              {/* Printable Invoice Board */}
              <div className="p-6 sm:p-8 rounded-2xl bg-white border border-slate-300 shadow-sm font-sans space-y-6 text-ink-primary">
                {/* Header */}
                <div className="flex items-start justify-between pb-6 border-b-2 border-navy">
                  <div>
                    <div className="flex items-center gap-3">
                      <AsintaEmblem size={34} />
                      <div>
                        <AsintaWordmark height={22} />
                        <div className="text-[11px] font-medium text-ink-secondary mt-1">
                          Design · Build · Management
                        </div>
                      </div>
                    </div>
                    <div className="text-[11px] text-ink-muted mt-2.5">
                      Ayala Greenfield Estates / Batangas Studio · Philippines<br />
                      Principal Architects: Ar. Junel Buyagon · Ar. Rei Viviene Buyagon<br />
                      Contact: +63 917 800 2026 | info@asinta.ph
                    </div>
                  </div>

                  <div className="text-right">
                    <div className="text-xs font-medium text-ink-secondary">Progress Billing</div>
                    <div className="text-lg font-mono font-black text-navy">{selectedInvoice.invoice_number}</div>
                    <div className="mt-2 text-xs">
                      <span className="text-ink-secondary">Issue Date:</span> <span className="font-semibold">{selectedInvoice.issue_date}</span><br />
                      <span className="text-ink-secondary">Due Date:</span> <span className="font-bold text-navy">{selectedInvoice.due_date}</span>
                    </div>
                  </div>
                </div>

                {/* Bill To */}
                <div className="grid grid-cols-2 gap-6 text-xs">
                  <div>
                    <div className="text-[11px] font-medium text-ink-secondary">Billed To</div>
                    <div className="font-bold text-navy text-sm mt-1">{client?.name}</div>
                    <div className="text-ink-secondary mt-0.5">Attn: {client?.contact_person}</div>
                    <div className="text-ink-secondary">{client?.address}</div>
                    <div className="text-ink-secondary">{client?.phone}</div>
                  </div>

                  <div>
                    <div className="text-[11px] font-medium text-ink-secondary">Project Site</div>
                    <div className="font-bold text-navy text-sm mt-1">{proj?.name}</div>
                    <div className="text-ink-secondary mt-0.5">Location: {proj?.location}</div>
                    <div className="text-ink-secondary">Contract Budget: {formatPHP(proj?.budget_estimate || 0)}</div>
                  </div>
                </div>

                {/* Milestone Table */}
                <div className="border border-slate-200 rounded-xl overflow-x-auto">
                  <table className="w-full text-xs text-left">
                    <thead className="bg-slate-100 text-navy font-bold uppercase text-[11px] border-b border-slate-200">
                      <tr>
                        <th className="p-3">Milestone Scope / Description</th>
                        <th className="p-3 text-right">Amount (PHP)</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr className="border-b border-slate-100">
                        <td className="p-3">
                          <div className="font-semibold text-navy">{selectedInvoice.notes || 'Progress Milestone Billing'}</div>
                          <div className="text-[11px] text-ink-secondary mt-0.5">
                            Verified on site by Asinta Architects project team.
                          </div>
                        </td>
                        <td className="p-3 text-right font-mono font-bold text-navy">
                          {formatPHP(selectedInvoice.amount)}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                {/* Settlement Calculation */}
                <div className="flex justify-end text-xs">
                  <div className="w-64 space-y-1.5">
                    <div className="flex justify-between">
                      <span className="text-ink-secondary">Total Invoiced:</span>
                      <span className="font-bold font-mono text-navy">{formatPHP(selectedInvoice.amount)}</span>
                    </div>
                    <div className="flex justify-between text-status-success">
                      <span>Amount Received:</span>
                      <span className="font-bold font-mono">({formatPHP(selectedInvoice.amount_paid)})</span>
                    </div>
                    <div className="flex justify-between pt-2 border-t border-slate-300 text-sm font-black text-navy">
                      <span>Balance Due:</span>
                      <span className="font-mono">{formatPHP(balance)}</span>
                    </div>
                  </div>
                </div>

                {/* Bank Payment Instructions & Signature */}
                <div className="pt-4 border-t border-slate-200 grid grid-cols-2 gap-4 text-[11px]">
                  <div className="p-3 rounded-xl bg-slate-50 border border-slate-200">
                    <div className="font-bold text-navy uppercase text-[10px]">Bank Settlement Details</div>
                    <div className="mt-1 space-y-0.5 text-ink-secondary">
                      <div>Bank: BDO Unibank Batangas Branch</div>
                      <div>Account Name: Asinta Architects Design & Build</div>
                      <div>Account No: 0048-1890-2211</div>
                    </div>
                  </div>

                  <div className="text-right flex flex-col justify-end">
                    <div className="font-serif italic text-navy font-bold text-sm">Ar. Junel Buyagon</div>
                    <div className="text-[10px] uppercase tracking-wider text-ink-secondary">
                      Principal Architect / Founder
                    </div>
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
                  Print Billing Certificate
                </Button>
                <Button variant="primary" size="sm" onClick={() => setIsPreviewModalOpen(false)}>
                  Close
                </Button>
              </div>
            </div>
          );
        })()}
      </Modal>

      {/* PHILSMS REMINDER MODAL */}
      <Modal
        isOpen={isSmsModalOpen}
        onClose={() => setIsSmsModalOpen(false)}
        dismissOnBackdrop={!smsSending}
        dismissOnEscape={!smsSending}
        showCloseButton={!smsSending}
        title="Send PhilSMS Payment Notification"
        description="Review the reminder before sending it to the client."
      >
        {selectedInvoice && (
          <div className="space-y-4 text-xs">
            {smsSuccess ? (
              <div className="p-4 rounded-xl bg-status-success-bg border border-status-success/20 text-status-success text-center font-semibold">
                <CheckCircle2 className="w-8 h-8 mx-auto mb-2 text-status-success" />
                {smsSuccess}
                <div className="mt-3"><Button type="button" variant="secondary" size="sm" onClick={() => setIsSmsModalOpen(false)}>Done</Button></div>
              </div>
            ) : (
              <>
                <div className="p-3 rounded-xl bg-surface-inset border border-surface-border space-y-1.5">
                  <div className="flex justify-between">
                    <span className="text-ink-secondary">Recipient:</span>
                    <span className="font-bold text-navy">
                      {clients.find((c) => c.id === selectedInvoice.client_id)?.name}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-ink-secondary">Mobile Number:</span>
                    <span className="font-mono text-navy">
                      {clients.find((c) => c.id === selectedInvoice.client_id)?.phone ||
                        'No number on file'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-ink-secondary">Invoice Balance:</span>
                    <span className="font-bold text-status-danger">
                      {formatPHP(selectedInvoice.amount - selectedInvoice.amount_paid)}
                    </span>
                  </div>
                </div>

                <Textarea
                  label="Reminder Message (editable before sending)"
                  rows={5}
                  value={smsMessage}
                  onChange={(e) => setSmsMessage(e.target.value)}
                  maxLength={1000}
                />

                {(() => {
                  const estimate = estimateSMSSegments(smsMessage);
                  return (
                    <div className="text-[11px] text-ink-secondary">
                      {estimate.characterCount} characters · {estimate.encoding} · est.{' '}
                      {estimate.segments} SMS segment{estimate.segments === 1 ? '' : 's'}
                    </div>
                  );
                })()}

                <p className="text-ink-secondary">If sending is unconfirmed, check the dispatch log and provider before retrying; it may have been sent.</p>
                <div className="pt-2 flex justify-end space-x-2">
                  <Button type="button" variant="secondary" onClick={() => setIsSmsModalOpen(false)} disabled={smsSending}>
                    Cancel
                  </Button>
                  <Button
                    variant="primary"
                    onClick={handleSendPhilSMS}
                    isLoading={smsSending}
                    disabled={smsSending || !smsMessage.trim()}
                    leftIcon={!smsSending ? <Send className="w-3.5 h-3.5" /> : undefined}
                  >
                    Confirm &amp; Send SMS
                  </Button>
                </div>
              </>
            )}
          </div>
        )}
      </Modal>

      {/* SEND REQUEST FOR PAYMENT (EMAIL) MODAL */}
      <RequestPaymentModal
        isOpen={isEmailModalOpen}
        onClose={() => setIsEmailModalOpen(false)}
        invoiceId={selectedInvoice?.id || null}
      />

      {/* EMAIL HISTORY MODAL */}
      <EmailHistoryModal
        isOpen={isEmailHistoryOpen}
        onClose={() => setIsEmailHistoryOpen(false)}
        invoiceId={selectedInvoice?.id || null}
        invoiceNumber={selectedInvoice?.invoice_number}
      />
    </AppShell>
  );
}
