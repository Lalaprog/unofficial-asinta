'use client';

import React, { useEffect, useId, useRef, useState } from 'react';
import { MessageSquare } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/Card';
import { Textarea } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Modal } from '@/components/ui/Modal';
import { fieldLabel, friendlyField, fromFriendlyTemplate, toFriendlyTemplate } from '@/lib/email/friendlyFields';
import { buildReminderSMS, estimateSMSSegments, SMS_FIELDS, validateSMSTemplate } from '@/lib/sms/templates';

const fields = [...SMS_FIELDS];
const sample = { contactPerson: 'Juan Dela Cruz', companyName: 'Sample Client', invoiceNumber: 'INV-001', projectName: 'Sample Project', outstandingBalance: 12500, dueDate: '2026-12-15', paymentRequestSentDate: null };

export function SmsTemplateCard() {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [saved, setSaved] = useState('');
  const [revision, setRevision] = useState<number | null>(null);
  const [field, setField] = useState<string>(SMS_FIELDS[0]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [restore, setRestore] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const selection = useRef<[number, number] | null>(null);
  const lock = useRef(false);
  const id = useId();
  useEffect(() => {
    let active = true;
    fetch('/api/sms/template', {cache:'no-store'}).then(async res => {
      const value = await res.json().catch(() => null);
      if (!res.ok || typeof value?.template !== 'string' || !Number.isSafeInteger(value?.revision)) throw new Error('Could not load the SMS template. Refresh the page to try again.');
      if (active) { const text = toFriendlyTemplate(value.template, fields); setDraft(text); setSaved(text); setRevision(value.revision); }
    }).catch(() => { if (active) setError('Could not load the SMS template. Refresh the page to try again.'); });
    return () => { active = false; };
  }, []);
  const parsed = fromFriendlyTemplate(draft, fields);
  const valid = parsed.ok && validateSMSTemplate(parsed.value).valid;
  const preview = parsed.ok && valid ? buildReminderSMS(sample, parsed.value) : '';
  const warnings = parsed.ok ? validateSMSTemplate(parsed.value).missing : [];
  const estimate = estimateSMSSegments(preview);
  const insertField = () => {
    const [start, end] = selection.current ?? [draft.length, draft.length];
    const token = friendlyField(field); const next = draft.slice(0,start) + token + draft.slice(end);
    const caret = start + token.length; selection.current = [caret,caret]; setDraft(next); setError(null);
    requestAnimationFrame(() => { textarea.current?.focus(); textarea.current?.setSelectionRange(caret,caret); });
  };
  const save = async (restoreDefault = false) => {
    if (lock.current || revision === null) return;
    if (!restoreDefault && (!parsed.ok || !valid)) { setError(!parsed.ok ? parsed.error : 'Check the message and its fields before saving.'); return; }
    lock.current = true; setSaving(true); setError(null);
    try {
      const response = await fetch('/api/sms/template', {method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision, template:parsed.ok ? parsed.value : '', restoreDefault})});
      const result = await response.json().catch(()=>null);
      if (!response.ok) {setError(result?.error || 'Could not save the SMS template.');return;}
      const text = toFriendlyTemplate(result.template,fields); setDraft(text); setSaved(text); setRevision(result.revision); setRestore(false);
    } catch {setError('Save was not confirmed. Refresh Settings before trying again.');}
    finally {lock.current = false;setSaving(false);}
  };
  return <Card>
    <CardHeader className={open ? undefined : 'pb-0'}>
      <div className="flex flex-wrap items-center justify-between gap-2"><div className="flex items-center gap-2.5"><MessageSquare className="h-5 w-5 text-navy"/><CardTitle>SMS reminder template</CardTitle></div><Button type="button" variant="secondary" size="sm" aria-expanded={open} aria-controls={id} onClick={()=>setOpen(!open)}>{open ? 'Close editor' : 'Edit & preview SMS'}</Button></div>
      <CardDescription>Edit the standard reminder and preview it with sample details. Changes to one message before sending do not change this template.</CardDescription>
      {draft !== saved && revision !== null && <p className="text-xs text-status-warning">Unsaved changes</p>}
    </CardHeader>
    <CardContent id={id} hidden={!open} className="space-y-3 text-xs">
      {error && <div role="alert" className="rounded-lg border border-status-danger/20 bg-status-danger-bg p-3 text-status-danger">{error}</div>}
      {revision === null ? <p>Loading template…</p> : <>
        <Textarea ref={textarea} label="SMS template" rows={5} value={draft} disabled={saving} onChange={e=>{setDraft(e.target.value);setError(null);selection.current=[e.currentTarget.selectionStart,e.currentTarget.selectionEnd];}} onSelect={e=>{selection.current=[e.currentTarget.selectionStart,e.currentTarget.selectionEnd];}} />
        <div className="flex flex-wrap items-end gap-2"><div className="min-w-0 flex-1 sm:max-w-xs"><Select label="Choose field" value={field} disabled={saving} onChange={e=>setField(e.target.value)}>{fields.map(item=><option key={item} value={item}>{fieldLabel(item)}</option>)}</Select></div><Button type="button" variant="secondary" size="sm" disabled={saving} onClick={insertField}>Insert field</Button></div>
        <p className="text-ink-secondary">Fields appear as names in brackets. To remove one, delete its whole name and brackets. Previous Email Note only mentions an email when there is a successful record.</p>
        {warnings.length > 0 && <p className="text-status-warning">Important fields missing: {warnings.map(fieldLabel).join(', ')}.</p>}
        {!parsed.ok && <p className="text-status-danger">{parsed.error}</p>}
        <div className="rounded-xl border border-surface-border bg-surface-inset p-3"><p className="mb-2 font-semibold text-navy">Sample preview</p><p className="whitespace-pre-wrap break-words">{preview || 'Complete the message and its fields to see a preview.'}</p>{preview && <p className="mt-2 text-ink-secondary">Estimated {estimate.segments} SMS segment{estimate.segments === 1 ? '' : 's'}; actual costs depend on your provider.</p>}</div>
        <div className="flex flex-wrap gap-2"><Button type="button" size="sm" onClick={()=>void save()} disabled={saving || draft===saved} isLoading={saving}>Save SMS template</Button><Button type="button" size="sm" variant="ghost" disabled={saving} onClick={()=>setRestore(true)}>Restore default</Button></div>
      </>}
    </CardContent>
    <Modal isOpen={restore} onClose={()=>setRestore(false)} title="Restore default SMS template?" description="This replaces the saved template. Previously sent messages are unchanged."><div className="flex flex-wrap justify-end gap-2"><Button type="button" variant="secondary" onClick={()=>setRestore(false)} disabled={saving}>Cancel</Button><Button type="button" variant="danger" onClick={()=>void save(true)} isLoading={saving}>Restore default</Button></div></Modal>
  </Card>;
}
