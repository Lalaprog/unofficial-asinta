// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderEmail, SAMPLE_TEMPLATE_DATA } from '@/lib/email/templates';
const toast = vi.hoisted(() => vi.fn());
vi.mock('@/lib/data/store', () => ({ useDataStore: () => ({ invoices: [], clients: [] }) }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ showToast: toast }) }));
import { TemplateEditorCard } from '@/components/email/TemplateEditorCard';
const template = { template:{template_type:'initial_request',subject_template:'Subject',body_template:'Dear client,',version:2}, defaults:{subject_template:'Subject',body_template:'Dear client,'}, supportedPlaceholders:['client_contact_name','invoice_number','project_name','outstanding_balance','due_date'], importantPlaceholders:['invoice_number','project_name','outstanding_balance','due_date'], isSystemDefault:false };
beforeEach(() => { toast.mockReset(); vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
  if (url.startsWith('/api/email/templates') && !options?.method) return {ok:true,json:async()=>template};
  if (url === '/api/email/preview') { const input=JSON.parse(String(options?.body)); const rendered=renderEmail(input.subjectTemplate,input.bodyTemplate,SAMPLE_TEMPLATE_DATA); return {ok:true,json:async()=>({sample:true,...rendered,warnings:rendered.validation.missingImportantPlaceholders})}; }
  return {ok:true,json:async()=>({version:3,warnings:[]})};
})); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe('friendly email template editor', () => {
  it('inserts named fields at the selection, previews rendered values, and clears stale previews after edits', async () => {
    render(React.createElement(TemplateEditorCard));
    const body=await screen.findByLabelText('Email message') as HTMLTextAreaElement;
    body.focus(); body.setSelectionRange(5,11); fireEvent.select(body);
    fireEvent.click(screen.getByRole('button',{name:'Insert Client Name into message'}));
    await waitFor(()=>expect(body.value).toBe('Dear {{client_contact_name}},'));
    fireEvent.click(screen.getByRole('button',{name:'Preview'}));
    expect(await screen.findByText(/Rendered Preview/)).toBeTruthy();
    expect((screen.getByTitle('Template HTML preview') as HTMLIFrameElement).srcdoc).toContain('Juan Dela Cruz');
    fireEvent.change(body,{target:{value:'Changed'}});
    expect(screen.queryByText(/Rendered Preview/)).toBeNull();
  });
  it('inserts into the subject when selected, preserves existing message and sends no email', async () => {
    render(React.createElement(TemplateEditorCard));
    const subject=await screen.findByLabelText('Email subject') as HTMLInputElement;
    fireEvent.click(screen.getByRole('button',{name:'Subject'}));
    fireEvent.click(screen.getByRole('button',{name:'Insert Invoice Number into subject'}));
    expect(subject.value).toBe('Subject{{invoice_number}}');
    expect((screen.getByLabelText('Email message') as HTMLTextAreaElement).value).toBe('Dear client,');
    expect(vi.mocked(fetch).mock.calls.every(([url])=>String(url).startsWith('/api/email/templates'))).toBe(true);
  });
  it('ignores an out-of-date preview response after the message changes', async () => {
    let resolvePreview!: (value: Response) => void;
    vi.mocked(fetch).mockImplementation(async (url: string | URL | Request) => {
      if (String(url).startsWith('/api/email/templates')) return {ok:true,json:async()=>template} as Response;
      return new Promise(resolve => { resolvePreview = resolve; }) as Promise<Response>;
    });
    render(React.createElement(TemplateEditorCard));
    const body=await screen.findByLabelText('Email message');
    fireEvent.click(screen.getByRole('button',{name:'Preview'}));
    fireEvent.change(body,{target:{value:'A newer message'}});
    resolvePreview({ok:true,json:async()=>({sample:true,subject:'stale',bodyText:'old',bodyHtml:'old',warnings:[]})} as Response);
    await waitFor(()=>expect(screen.getByRole('button',{name:'Preview'})).toBeTruthy());
    expect(screen.queryByText('stale')).toBeNull();
  });
});
