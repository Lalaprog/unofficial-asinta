'use client';

import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Mail, RefreshCw, Send } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Input, Textarea } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { formatDatePH, formatPeso } from '@/lib/email/format';
import { SUPPORTED_PLACEHOLDERS } from '@/lib/email/templates';
import { fieldLabel, friendlyField, fromFriendlyTemplate, toFriendlyTemplate } from '@/lib/email/friendlyFields';

interface PreviewResponse {
  subject: string;
  previewFingerprint: string;
  bodyText: string;
  bodyHtml: string;
  warnings: string[];
  invoice: {
    id: string;
    invoiceNumber: string;
    issueDate: string;
    dueDate: string;
    amount: number;
    amountPaid: number;
    outstandingBalance: number;
    status: string;
  };
  client: { name: string; contactPerson: string | null; email: string };
  project: { name: string };
  template: { subjectTemplate: string; bodyTemplate: string; version: number };
}

interface SendResponse {
  status: 'accepted' | 'failed' | 'unconfirmed';
  logUpdateFailed?: boolean;
  statusLabel: string;
  duplicate: boolean;
  providerMessageId: string | null;
  error: string | null;
}

interface RequestPaymentModalProps {
  isOpen: boolean;
  onClose: () => void;
  invoiceId: string | null;
}

/**
 * Founder-only "Send Request for Payment" workflow.
 *
 * The preview, both render formats, and every financial figure come from the
 * server (/api/email/preview) — the browser only submits the Founder-edited
 * wording, the invoice ID, and a fresh idempotency key per confirmed send.
 */
export const RequestPaymentModal: React.FC<RequestPaymentModalProps> = ({
  isOpen,
  onClose,
  invoiceId,
}) => {
  const [isLoading, setIsLoading] = useState(false);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [subjectTemplate, setSubjectTemplate] = useState('');
  const [bodyTemplate, setBodyTemplate] = useState('');
  const [reviewed, setReviewed] = useState<{ subject: string; body: string } | null>(null);
  const [insertTarget, setInsertTarget] = useState<'subject' | 'body'>('body');
  const [editing, setEditing] = useState(false);
  const editorId = useId();
  const [chosenField, setChosenField] = useState<string>(SUPPORTED_PLACEHOLDERS[0]);
  const subjectRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const previewRevision = useRef(0);
  const [previewTab, setPreviewTab] = useState<'html' | 'text'>('html');
  const [error, setError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [recipientConfirmed, setRecipientConfirmed] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [sendResult, setSendResult] = useState<SendResponse | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState('');

  const newIdempotencyKey = () =>
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `key-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const loadPreview = useCallback(
    async (subject?: string, body?: string) => {
      if (!invoiceId) return;
      const isInitial = subject === undefined;
      let rawSubject: string | undefined;
      let rawBody: string | undefined;
      if (!isInitial) {
        const parsedSubject = fromFriendlyTemplate(subject, [...SUPPORTED_PLACEHOLDERS]);
        const parsedBody = fromFriendlyTemplate(body ?? '', [...SUPPORTED_PLACEHOLDERS]);
        if (!parsedSubject.ok || !parsedBody.ok) {
          setError(!parsedSubject.ok ? parsedSubject.error : !parsedBody.ok ? parsedBody.error : 'Check the fields.');
          return;
        }
        rawSubject = parsedSubject.value;
        rawBody = parsedBody.value;
      }
      const revision = ++previewRevision.current;
      if (isInitial) setIsLoading(true);
      else setIsRefreshing(true);
      setRecipientConfirmed(false);
      setError(null);

      try {
        const res = await fetch('/api/email/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ invoiceId, subjectTemplate: rawSubject, bodyTemplate: rawBody }),
        });
        const data = await res.json().catch(() => null);
        if (revision !== previewRevision.current) return;
        if (!res.ok) {
          setError(data?.error || 'Failed to build the email preview');
          if (isInitial) setPreview(null);
          return;
        }
        const friendlySubject = isInitial ? toFriendlyTemplate(data.template.subjectTemplate, [...SUPPORTED_PLACEHOLDERS]) : subject;
        const friendlyBody = isInitial ? toFriendlyTemplate(data.template.bodyTemplate, [...SUPPORTED_PLACEHOLDERS]) : body ?? '';
        setPreview(data as PreviewResponse);
        if (isInitial) {
          setSubjectTemplate(friendlySubject);
          setBodyTemplate(friendlyBody);
        }
        setReviewed({ subject: friendlySubject, body: friendlyBody });
      } catch {
        if (revision === previewRevision.current) setError('Network error while building the preview');
      } finally {
        if (revision === previewRevision.current) {
          setIsLoading(false);
          setIsRefreshing(false);
        }
      }
    },
    [invoiceId]
  );

  useEffect(() => {
    if (isOpen && invoiceId) {
      setPreview(null);
      setReviewed(null);
      setEditing(false);
      setIsRefreshing(false);
      setSendResult(null);
      setRecipientConfirmed(false);
      setError(null);
      setIdempotencyKey(newIdempotencyKey());
      loadPreview();
    }
    return () => { previewRevision.current += 1; };
  }, [isOpen, invoiceId, loadPreview]);

  const previewIsCurrent = Boolean(reviewed && reviewed.subject === subjectTemplate && reviewed.body === bodyTemplate);
  const editWording = (field: 'subject' | 'body', value: string) => {
    if (field === 'subject') setSubjectTemplate(value);
    else setBodyTemplate(value);
    setRecipientConfirmed(false);
    setError(null);
  };
  const insertField = () => {
    const element = insertTarget === 'subject' ? subjectRef.current : bodyRef.current;
    if (!element) return;
    const value = insertTarget === 'subject' ? subjectTemplate : bodyTemplate;
    const start = element.selectionStart ?? value.length;
    const end = element.selectionEnd ?? start;
    const token = friendlyField(chosenField);
    editWording(insertTarget, value.slice(0, start) + token + value.slice(end));
    requestAnimationFrame(() => { element.focus(); element.setSelectionRange(start + token.length, start + token.length); });
  };

  const handleSend = async () => {
    if (!invoiceId || !preview || !preview.previewFingerprint || !recipientConfirmed || !previewIsCurrent || isSending || isRefreshing) return;
    const subject = fromFriendlyTemplate(subjectTemplate, [...SUPPORTED_PLACEHOLDERS]);
    const body = fromFriendlyTemplate(bodyTemplate, [...SUPPORTED_PLACEHOLDERS]);
    if (!subject.ok || !body.ok) {
      setError(!subject.ok ? subject.error : !body.ok ? body.error : 'Check the fields.');
      return;
    }
    setIsSending(true);
    setError(null);

    try {
      const res = await fetch('/api/email/request-payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          invoiceId,
          subjectTemplate: subject.value,
          bodyTemplate: body.value,
          previewFingerprint: preview.previewFingerprint,
          idempotencyKey,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error || 'Failed to send the email');
        if (res.status === 409) { setReviewed(null); setRecipientConfirmed(false); }
        return;
      }
      setSendResult(data as SendResponse);
    } catch {
      setError('Email outcome not confirmed. Check email history and your mail server before retrying; the message may have been sent.');
    } finally {
      setIsSending(false);
    }
  };

  const handlePrepareResend = () => {
    // A deliberate resend needs a fresh confirmation AND a fresh key.
    setSendResult(null);
    setRecipientConfirmed(false);
    setIdempotencyKey(newIdempotencyKey());
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Send Request for Payment"
      description="Preview and email the official Request for Payment. Financial details are loaded server-side and remain authoritative."
      maxWidth="full"
      dismissOnBackdrop={!isSending}
      dismissOnEscape={!isSending}
      showCloseButton={!isSending}
    >
      {isLoading && (
        <div className="p-10 text-center text-xs text-ink-secondary">
          Preparing email preview from the live ledger…
        </div>
      )}

      {!isLoading && error && !preview && (
        <div className="p-4 rounded-xl bg-status-danger-bg border border-status-danger/20 text-status-danger text-xs flex items-center space-x-2">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {!isLoading && preview && sendResult && (
        <div className="space-y-4 text-xs">
          {sendResult.status === 'accepted' ? (
            <div className="p-5 rounded-2xl bg-status-success-bg border border-status-success/20 text-status-success space-y-2">
              <div className="flex items-center space-x-2 font-bold text-sm">
                <CheckCircle2 className="w-5 h-5 text-status-success" />
                <span>Accepted by mail server</span>
              </div>
              <p>
                The SMTP server accepted the Request for Payment addressed to{' '}
                <span className="font-semibold">{preview.client.email}</span>.
                {sendResult.duplicate &&
                  ' (This confirmation key was already processed — no duplicate email was sent.)'}
              </p>
              {sendResult.providerMessageId && (
                <p className="font-mono text-[11px] text-status-success">
                  SMTP Message ID: {sendResult.providerMessageId}
                </p>
              )}
              <p className="text-[11px] text-status-success">
                Acceptance by the mail server is not proof of inbox delivery. {sendResult.logUpdateFailed ? 'The email history status could not be updated; check it before sending again.' : 'The exact email content is stored in the invoice email history.'}
              </p>
            </div>
          ) : (
            <div className="p-5 rounded-2xl bg-status-danger-bg border border-status-danger/20 text-status-danger space-y-2">
              <div className="flex items-center space-x-2 font-bold text-sm">
                <AlertCircle className="w-5 h-5" />
                <span>{sendResult.status === 'unconfirmed' ? 'Email outcome not confirmed' : 'Sending failed'}</span>
              </div>
              {sendResult.status === 'unconfirmed' ? (
                <p>The mail server may have accepted this email. Check email history and your sent mail before sending again.</p>
              ) : <p>{sendResult.error || 'The mail server rejected the message.'}</p>}
              {sendResult.logUpdateFailed && <p>The email history status could not be updated. Check it before trying again.</p>}
            </div>
          )}

          <div className="flex justify-end space-x-2">
            <Button variant="secondary" size="sm" onClick={onClose}>
              Close
            </Button>
            {sendResult.status !== 'unconfirmed' && !sendResult.logUpdateFailed && <Button variant="primary" size="sm" onClick={handlePrepareResend}>
              Prepare Another Send
            </Button>}
          </div>
        </div>
      )}

      {!isLoading && preview && !sendResult && (
        <div className="space-y-5 text-xs">
          {/* Authoritative billing summary */}
          <div className="p-4 rounded-2xl bg-surface-inset/60 border border-surface-border">
            <div className="flex items-center justify-between mb-3">
              <span className="font-bold text-navy uppercase text-[11px] tracking-wider">
                Invoice details
              </span>
              <Badge variant="navy" size="sm">
                Saved template
              </Badge>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div>
                <div className="text-ink-secondary">Client / Contact</div>
                <div className="font-bold text-navy mt-0.5">{preview.client.name}</div>
                <div className="text-[11px] text-ink-secondary">
                  {preview.client.contactPerson || '—'}
                </div>
              </div>
              <div>
                <div className="text-ink-secondary">Recipient Email</div>
                <div className="font-mono font-semibold text-navy mt-0.5 break-all">
                  {preview.client.email}
                </div>
              </div>
              <div>
                <div className="text-ink-secondary">Project</div>
                <div className="font-semibold text-navy mt-0.5">{preview.project.name}</div>
                <div className="font-mono text-[11px] text-ink-secondary">
                  {preview.invoice.invoiceNumber}
                </div>
              </div>
              <div>
                <div className="text-ink-secondary">Issue / Due Date</div>
                <div className="font-semibold text-navy mt-0.5">
                  {formatDatePH(preview.invoice.issueDate)}
                </div>
                <div className="font-semibold text-status-danger text-[11px]">
                  Due {formatDatePH(preview.invoice.dueDate)}
                </div>
              </div>
              <div>
                <div className="text-ink-secondary">Invoice Amount</div>
                <div className="font-bold text-navy mt-0.5">{formatPeso(preview.invoice.amount)}</div>
              </div>
              <div>
                <div className="text-ink-secondary">Amount Paid</div>
                <div className="font-bold text-status-success mt-0.5">
                  {formatPeso(preview.invoice.amountPaid)}
                </div>
              </div>
              <div className="col-span-2">
                <div className="text-ink-secondary">Outstanding Balance</div>
                <div className="font-black text-status-danger text-sm mt-0.5">
                  {formatPeso(preview.invoice.outstandingBalance)}
                </div>
              </div>
            </div>
          </div>

          {error && (
            <div className="p-3 rounded-xl bg-status-danger-bg border border-status-danger/20 text-status-danger flex items-center space-x-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {preview.warnings?.length > 0 && (
            <div className="p-3 rounded-xl bg-status-warning-bg border border-status-warning/20 text-status-warning">
              The message is missing these important billing fields:{' '}
              <span className="font-mono font-semibold">{preview.warnings.map(fieldLabel).join(', ')}</span>
            </div>
          )}

          {/* Rendered previews */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="font-bold text-navy uppercase text-[11px] tracking-wider">
                Final Email Preview
              </span>
              <div className="flex items-center space-x-1">
                <button
                  type="button"
                  onClick={() => setPreviewTab('html')}
                  className={`px-3 py-1 rounded-lg text-[11px] font-semibold transition-colors ${
                    previewTab === 'html'
                      ? 'bg-navy text-white'
                      : 'bg-surface-inset text-ink-secondary hover:text-navy'
                  }`}
                >
                  HTML
                </button>
                <button
                  type="button"
                  onClick={() => setPreviewTab('text')}
                  className={`px-3 py-1 rounded-lg text-[11px] font-semibold transition-colors ${
                    previewTab === 'text'
                      ? 'bg-navy text-white'
                      : 'bg-surface-inset text-ink-secondary hover:text-navy'
                  }`}
                >
                  Plain Text
                </button>
              </div>
            </div>

            <div className="p-3 rounded-xl bg-white border border-surface-border mb-2">
              <span className="text-ink-secondary">Subject: </span>
              <span className="font-semibold text-navy">{preview.subject}</span>
            </div>

            {previewTab === 'html' ? (
              <iframe
                title="Email HTML preview"
                sandbox=""
                srcDoc={preview.bodyHtml}
                className="w-full h-80 rounded-xl border border-surface-border bg-white"
              />
            ) : (
              <pre className="w-full h-80 overflow-auto rounded-xl border border-surface-border bg-slate-50 p-4 text-[11px] leading-relaxed whitespace-pre-wrap font-mono text-ink-primary">
                {preview.bodyText}
              </pre>
            )}
          </div>

          {/* One-time edits do not change the saved Settings template. */}
          <div className="space-y-3">
            <Button type="button" variant="secondary" size="sm" aria-expanded={editing} aria-controls={editorId} onClick={() => setEditing(!editing)}>{editing ? 'Close editor' : 'Edit message'}</Button>
            {!previewIsCurrent && <div className="flex flex-wrap items-center gap-2"><p role="status" className="text-status-warning">Your message has changed. Update the preview before confirming.</p><Button type="button" variant="secondary" size="sm" onClick={() => loadPreview(subjectTemplate, bodyTemplate)} isLoading={isRefreshing} disabled={isSending}>Update Preview</Button></div>}
            <div id={editorId} hidden={!editing} className="space-y-3">
            <p className="text-ink-secondary">You can adjust this email for this invoice. Your saved template in Settings will not change.</p>
            <Input
              ref={subjectRef}
              label="Email subject"
              value={subjectTemplate}
              disabled={isRefreshing || isSending}
              onFocus={() => setInsertTarget('subject')}
              onChange={(e) => editWording('subject', e.target.value)}
            />
            <Textarea
              ref={bodyRef}
              label="Email message"
              rows={10}
              value={bodyTemplate}
              disabled={isRefreshing || isSending}
              onFocus={() => setInsertTarget('body')}
              onChange={(e) => editWording('body', e.target.value)}
            />
            <div className="flex flex-wrap items-end gap-2">
              <label className="text-xs font-semibold text-ink-secondary">Insert a field into {insertTarget === 'body' ? 'message' : 'subject'}
                <select aria-label="Choose email field" value={chosenField} onChange={(e) => setChosenField(e.target.value)} disabled={isRefreshing || isSending} className="block min-h-11 sm:min-h-9 rounded-lg border border-surface-border bg-white px-3 text-ink-primary mt-1">
                  {SUPPORTED_PLACEHOLDERS.map((field) => <option key={field} value={field}>{fieldLabel(field)}</option>)}
                </select>
              </label>
              <Button type="button" variant="secondary" size="sm" onClick={insertField} disabled={isRefreshing || isSending}>Insert field</Button>
              {previewIsCurrent && <Button type="button" variant="secondary" size="sm" onClick={() => loadPreview(subjectTemplate, bodyTemplate)} isLoading={isRefreshing} disabled={isSending} leftIcon={<RefreshCw className="w-3.5 h-3.5" />}>Update Preview</Button>}
            </div>
            <p className="text-ink-secondary">Fields appear as names in brackets, such as ‹Client Name›. To remove a field, delete its whole name and brackets.</p>
            </div>
          </div>

          {/* Confirmation */}
          <div className="p-4 rounded-2xl bg-surface-inset/60 border border-surface-border space-y-3">
            <label className="flex items-start space-x-2.5 cursor-pointer">
              <input
                type="checkbox"
                checked={recipientConfirmed}
                disabled={!previewIsCurrent || isRefreshing || isSending || !preview.previewFingerprint}
                onChange={(e) => setRecipientConfirmed(e.target.checked)}
                className="mt-0.5 w-4 h-4 rounded border-surface-border text-navy focus:ring-navy/30"
              />
              <span className="text-ink-primary leading-relaxed">
                I confirm sending this Request for Payment to{' '}
                <span className="font-mono font-bold text-navy">{preview.client.email}</span> for{' '}
                <span className="font-semibold">{preview.invoice.invoiceNumber}</span> with an
                outstanding balance of{' '}
                <span className="font-bold text-status-danger">
                  {formatPeso(preview.invoice.outstandingBalance)}
                </span>
                .
              </span>
            </label>

            <div className="flex justify-end space-x-2">
              <Button variant="secondary" size="sm" onClick={onClose} disabled={isSending}>
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={handleSend}
                disabled={!recipientConfirmed || !previewIsCurrent || !preview.previewFingerprint || isSending || isRefreshing}
                isLoading={isSending}
                leftIcon={!isSending ? <Send className="w-3.5 h-3.5" /> : undefined}
              >
                {isSending ? 'Sending…' : 'Confirm & Send Email'}
              </Button>
            </div>
            <p className="text-[11px] text-ink-muted flex items-center space-x-1.5">
              <Mail className="w-3 h-3" />
              <span>
                A successful send is reported as &ldquo;Accepted by mail server&rdquo; — delivery is
                confirmed only by the recipient&rsquo;s mail provider.
              </span>
            </p>
          </div>
        </div>
      )}
    </Modal>
  );
};
