'use client';

import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Eye, FileText, RotateCcw, Save } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Input, Textarea } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Modal } from '@/components/ui/Modal';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/Card';
import { useDataStore } from '@/lib/data/store';
import { useToast } from '@/components/ui/Toast';
import { fieldLabel, friendlyField, fromFriendlyTemplate, toFriendlyTemplate } from '@/lib/email/friendlyFields';

type EditorField = 'subject' | 'body';

interface TemplateResponse {
  template: {
    template_type: string;
    subject_template: string;
    body_template: string;
    version: number;
  };
  defaults: { subject_template: string; body_template: string };
  supportedPlaceholders: string[];
  importantPlaceholders: string[];
  isSystemDefault: boolean;
}

interface PreviewState {
  subject: string;
  bodyText: string;
  bodyHtml: string;
  warnings: string[];
  sample: boolean;
}

/**
 * Founder-only editor for the Initial Request for Payment email template.
 * Templates are safe text with {{placeholders}} — never raw executable HTML.
 * Every save creates a new version; historical email snapshots never change.
 */
export const TemplateEditorCard: React.FC = () => {
  const { invoices, clients } = useDataStore();
  const { showToast } = useToast();

  const [data, setData] = useState<TemplateResponse | null>(null);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [previewTab, setPreviewTab] = useState<'html' | 'text'>('html');
  const [previewInvoiceId, setPreviewInvoiceId] = useState('');
  const [showRestoreConfirm, setShowRestoreConfirm] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);
  const [insertTarget, setInsertTarget] = useState<EditorField>('body');
  const [editorOpen, setEditorOpen] = useState(false);
  const [chosenField, setChosenField] = useState('client_contact_name');
  const editorId = useId();
  const subjectRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const selections = useRef<Record<EditorField, [number, number] | null>>({ subject: null, body: null });
  const previewRevision = useRef(0);
  const invalidatePreview = () => { previewRevision.current += 1; setPreview(null); setWarnings([]); setError(null); };
  const rememberSelection = (field: EditorField, input: HTMLInputElement | HTMLTextAreaElement) => {
    selections.current[field] = [input.selectionStart ?? input.value.length, input.selectionEnd ?? input.value.length];
  };
  const insertField = (placeholder: string) => {
    if (!data?.supportedPlaceholders.includes(placeholder)) return;
    const field = insertTarget;
    const value = field === 'subject' ? subject : body;
    const selection = selections.current[field] || [value.length, value.length];
    const start = Math.min(selection[0], value.length);
    const end = Math.min(selection[1], value.length);
    const token = friendlyField(placeholder);
    const next = value.slice(0, start) + token + value.slice(end);
    const position = start + token.length;
    selections.current[field] = [position, position];
    if (field === 'subject') setSubject(next); else setBody(next);
    invalidatePreview();
    requestAnimationFrame(() => {
      const input = field === 'subject' ? subjectRef.current : bodyRef.current;
      input?.focus(); input?.setSelectionRange(position, position);
      selections.current[field] = [position, position];
    });
  };

  const loadTemplate = useCallback(async () => {
    try {
      const res = await fetch('/api/email/templates?type=initial_request', { cache: 'no-store' });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        setError(payload?.error || 'Failed to load the email template');
        return;
      }
      previewRevision.current += 1; setPreview(null);
      selections.current = { subject: null, body: null };
      setData(payload as TemplateResponse);
      setSubject(toFriendlyTemplate(payload.template.subject_template, payload.supportedPlaceholders));
      setBody(toFriendlyTemplate(payload.template.body_template, payload.supportedPlaceholders));
    } catch {
      setError('Network error while loading the template');
    }
  }, []);

  useEffect(() => {
    loadTemplate();
  }, [loadTemplate]);

  const parseEditor = () => {
    if (!data) return null;
    const parsedSubject = fromFriendlyTemplate(subject, data.supportedPlaceholders);
    const parsedBody = fromFriendlyTemplate(body, data.supportedPlaceholders);
    if (!parsedSubject.ok || !parsedBody.ok) {
      setError(!parsedSubject.ok ? parsedSubject.error : !parsedBody.ok ? parsedBody.error : 'Check the fields.');
      return null;
    }
    return { subject: parsedSubject.value, body: parsedBody.value };
  };
  const handlePreview = async () => {
    const parsed = parseEditor();
    if (!parsed) return;
    const revision = previewRevision.current;
    setIsPreviewing(true);
    setError(null);
    try {
      const res = await fetch('/api/email/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          invoiceId: previewInvoiceId || undefined,
          subjectTemplate: parsed.subject,
          bodyTemplate: parsed.body,
        }),
      });
      const payload = await res.json().catch(() => null);
      if (revision !== previewRevision.current) return;
      if (!res.ok) {
        setError(payload?.error || 'Failed to render the preview');
        setPreview(null);
        return;
      }
      setPreview({
        subject: payload.subject,
        bodyText: payload.bodyText,
        bodyHtml: payload.bodyHtml,
        warnings: payload.warnings || [],
        sample: Boolean(payload.sample),
      });
      setWarnings(payload.warnings || []);
    } catch {
      if (revision === previewRevision.current) setError('Network error while rendering the preview');
    } finally {
      setIsPreviewing(false);
    }
  };

  const handleSave = async () => {
    const parsed = parseEditor();
    if (!parsed) return;
    setIsSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/email/templates', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          template_type: 'initial_request',
          subject_template: parsed.subject,
          body_template: parsed.body,
        }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        setError(payload?.error || 'Failed to save the template');
        return;
      }
      setWarnings(payload.warnings || []);
      showToast('success', `Template saved as version ${payload.version}. Historical emails are unchanged.`);
      await loadTemplate();
    } catch {
      setError('Network error while saving the template');
    } finally {
      setIsSaving(false);
    }
  };

  const handleRestoreDefault = async () => {
    setIsRestoring(true);
    setError(null);
    try {
      const res = await fetch('/api/email/templates', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ template_type: 'initial_request', restore_default: true }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        setError(payload?.error || 'Failed to restore the default template');
        return;
      }
      showToast('success', `System default restored as version ${payload.version}.`);
      setShowRestoreConfirm(false);
      await loadTemplate();
    } catch {
      setError('Network error while restoring the default');
    } finally {
      setIsRestoring(false);
    }
  };

  return (
    <Card>
      <CardHeader className={editorOpen ? undefined : 'pb-0'}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center space-x-2.5">
            <FileText className="w-5 h-5 text-navy" />
            <CardTitle>Email Templates — Request for Payment</CardTitle>
          </div>
          <div className="flex items-center gap-2">
            {data && <Badge variant={data.isSystemDefault ? 'neutral' : 'navy'} size="sm">{data.isSystemDefault ? 'Default' : 'Customized'}</Badge>}
            <Button type="button" variant="secondary" size="sm" aria-expanded={editorOpen} aria-controls={editorId} onClick={() => setEditorOpen(!editorOpen)}>{editorOpen ? 'Close editor' : 'Edit & preview'}</Button>
          </div>
        </div>
        <CardDescription>
          Personalize the first request-for-payment email. Insert fields by name and preview the result before saving.
          Each message uses the invoice&apos;s current details; previously sent emails stay unchanged.
        </CardDescription>
      </CardHeader>
      <CardContent id={editorId} hidden={!editorOpen} className="space-y-4 text-xs">
        {!data && !error && <div className="text-ink-secondary p-2">Loading template…</div>}

        {error && (
          <div className="p-3 rounded-xl bg-status-danger-bg border border-status-danger/20 text-status-danger flex items-center space-x-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {data && (
          <>
            <div className="rounded-xl border border-surface-border bg-surface-inset/60 p-4 space-y-3">
              <div><p className="text-sm font-bold text-navy">Insert a field</p><p className="mt-1 text-xs text-ink-secondary">Choose where to insert, place your cursor in the text, then select a field. Its value is filled in when the email is prepared.</p></div>
              <div className="flex flex-wrap items-center gap-2" aria-label="Field destination">
                <span className="text-xs font-semibold text-ink-secondary">Insert into:</span>
                {(['body', 'subject'] as const).map(field => <button key={field} type="button" aria-pressed={insertTarget === field} disabled={isSaving || isRestoring} onClick={() => setInsertTarget(field)} className={`min-h-11 sm:min-h-10 rounded-lg border px-3 text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${insertTarget === field ? 'border-navy bg-navy text-white' : 'border-surface-border bg-white text-navy'}`}>{field === 'body' ? 'Message' : 'Subject'}</button>)}
              </div>
              <div className="flex flex-wrap items-end gap-2">
                <div className="min-w-0 flex-1 sm:max-w-xs"><Select label="Choose field" value={chosenField} onChange={event => setChosenField(event.target.value)} disabled={isSaving || isRestoring}>
                  {data.supportedPlaceholders.map(placeholder => <option key={placeholder} value={placeholder}>{fieldLabel(placeholder)}</option>)}
                </Select></div>
                <Button type="button" variant="secondary" size="sm" disabled={isSaving || isRestoring} onClick={() => insertField(chosenField)}>Insert field</Button>
              </div>
              <p className="text-xs text-ink-secondary">Fields appear as names in brackets, such as ‹Client Name›. Preview to see them filled in. To remove a field, delete its whole name and brackets. Project, invoice number, balance and due date are important billing details.</p>
            </div>

            {warnings.length > 0 && (
              <div className="p-3 rounded-xl bg-status-warning-bg border border-status-warning/20 text-status-warning">
                Important billing fields missing from the template:{' '}
                <span className="font-semibold">{warnings.map(fieldLabel).join(', ')}</span>
              </div>
            )}

            <Input
              label="Email subject"
              ref={subjectRef}
              value={subject}
              disabled={isSaving || isRestoring}
              onFocus={e => { setInsertTarget('subject'); rememberSelection('subject', e.currentTarget); }}
              onSelect={e => rememberSelection('subject', e.currentTarget)}
              onChange={e => { setSubject(e.target.value); rememberSelection('subject', e.currentTarget); invalidatePreview(); }}
            />
            <Textarea
              label="Email message"
              ref={bodyRef}
              rows={8}
              value={body}
              disabled={isSaving || isRestoring}
              onFocus={e => { setInsertTarget('body'); rememberSelection('body', e.currentTarget); }}
              onSelect={e => rememberSelection('body', e.currentTarget)}
              onChange={e => { setBody(e.target.value); rememberSelection('body', e.currentTarget); invalidatePreview(); }}
              className="leading-relaxed"
            />

            <div className="flex flex-col sm:flex-row sm:items-end gap-3">
              <div className="flex-1">
                <Select
                  label="Preview Data Source"
                  value={previewInvoiceId}
                  onChange={(e) => { setPreviewInvoiceId(e.target.value); invalidatePreview(); }}
                >
                  <option value="">Safe sample data</option>
                  {invoices
                    .filter((inv) => inv.status !== 'cancelled')
                    .map((inv) => {
                      const client = clients.find((c) => c.id === inv.client_id);
                      return (
                        <option key={inv.id} value={inv.id}>
                          {inv.invoice_number} — {client?.name || 'Unknown client'}
                        </option>
                      );
                    })}
                </Select>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handlePreview}
                  isLoading={isPreviewing}
                  disabled={isSaving || isRestoring}
                  leftIcon={<Eye className="w-3.5 h-3.5" />}
                >
                  Preview
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleSave}
                  isLoading={isSaving}
                  disabled={isRestoring}
                  leftIcon={<Save className="w-3.5 h-3.5" />}
                >
                  Save New Version
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowRestoreConfirm(true)}
                  disabled={isSaving || isRestoring}
                  leftIcon={<RotateCcw className="w-3.5 h-3.5" />}
                >
                  Restore Default
                </Button>
              </div>
            </div>

            {preview && (
              <div className="space-y-2 pt-2 border-t border-surface-border/60">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-navy uppercase text-[11px] tracking-wider">
                    Rendered Preview {preview.sample ? '(sample data)' : '(real invoice data)'}
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
                <div className="p-3 rounded-xl bg-white border border-surface-border">
                  <span className="text-ink-secondary">Subject: </span>
                  <span className="font-semibold text-navy">{preview.subject}</span>
                </div>
                {previewTab === 'html' ? (
                  <iframe
                    title="Template HTML preview"
                    sandbox=""
                    srcDoc={preview.bodyHtml}
                    className="w-full h-72 rounded-xl border border-surface-border bg-white"
                  />
                ) : (
                  <pre className="w-full h-72 overflow-auto rounded-xl border border-surface-border bg-slate-50 p-4 text-[11px] leading-relaxed whitespace-pre-wrap font-mono text-ink-primary">
                    {preview.bodyText}
                  </pre>
                )}
              </div>
            )}
          </>
        )}
      </CardContent>

      {/* RESTORE DEFAULT CONFIRMATION */}
      <Modal
        isOpen={showRestoreConfirm}
        onClose={() => setShowRestoreConfirm(false)}
        title="Restore System Default Template?"
        description="Your customized wording will be replaced by the BALE system default."
      >
        <div className="space-y-4 text-xs">
          <p className="text-ink-secondary leading-relaxed">
            This saves the system default as a <span className="font-semibold text-navy">new
            version</span> of the Initial Request for Payment template. Emails that were already
            sent keep their exact stored content and are not affected.
          </p>
          <div className="flex justify-end space-x-2">
            <Button variant="secondary" size="sm" onClick={() => setShowRestoreConfirm(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={handleRestoreDefault}
              isLoading={isRestoring}
              leftIcon={<CheckCircle2 className="w-3.5 h-3.5" />}
            >
              Yes, Restore Default
            </Button>
          </div>
        </div>
      </Modal>
    </Card>
  );
};
