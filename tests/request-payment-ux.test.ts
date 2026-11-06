// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RequestPaymentModal } from '@/components/email/RequestPaymentModal';
import { renderEmail, SAMPLE_TEMPLATE_DATA } from '@/lib/email/templates';

const saved = { subjectTemplate: 'Invoice {{invoice_number}}', bodyTemplate: 'Dear {{client_contact_name}}, please pay {{outstanding_balance}}.', version: 2 };
function preview(subject = saved.subjectTemplate, body = saved.bodyTemplate) {
  const rendered = renderEmail(subject, body, SAMPLE_TEMPLATE_DATA);
  return { ...rendered, warnings: rendered.validation.missingImportantPlaceholders, previewFingerprint: 'review-fingerprint', template: saved,
    invoice: { id:'inv-1', invoiceNumber:'INV-001', issueDate:'2026-01-01',dueDate:'2026-02-01',amount:1000,amountPaid:0,outstandingBalance:1000,status:'pending' },
    client:{ name:'Example',contactPerson:'Juan',email:'client@example.com'},project:{name:'Sample'} };
}
let sendConflict = false;
beforeEach(() => {
  sendConflict = false;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; });
  vi.stubGlobal('fetch',vi.fn(async (url:string, options:RequestInit) => {
    const body=JSON.parse(String(options.body));
    if (url==='/api/email/preview') return {ok:true,json:async()=>preview(body.subjectTemplate,body.bodyTemplate)};
    if (url==='/api/email/request-payment') return sendConflict
      ? {ok:false,status:409,json:async()=>({error:'The invoice, recipient, or message has changed. Update the preview.'})}
      : {ok:true,json:async()=>({status:'accepted',statusLabel:'Accepted',duplicate:false,providerMessageId:null,error:null})};
    throw new Error('Unexpected fetch: '+url);
  }));
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});

describe('one-time invoice email editing',()=>{
  it('shows friendly fields, inserts at the caret, requires an updated preview, and submits only the one-time text',async()=>{
    render(React.createElement(RequestPaymentModal,{isOpen:true,onClose:vi.fn(),invoiceId:'inv-1'}));
    await screen.findByText('Final Email Preview');fireEvent.click(screen.getByRole('button',{name:'Edit message'}));
    const message=await screen.findByLabelText('Email message') as HTMLTextAreaElement;
    expect(message.value).toBe('Dear ‹Client Name›, please pay ‹Outstanding Balance›.');
    const confirm=screen.getByRole('checkbox') as HTMLInputElement;fireEvent.click(confirm);expect(confirm.checked).toBe(true);
    message.focus();message.setSelectionRange(0,0);fireEvent.select(message);
    fireEvent.change(screen.getByLabelText('Choose email field'),{target:{value:'invoice_number'}});
    fireEvent.click(screen.getByRole('button',{name:'Insert field'}));
    expect(message.value.startsWith('‹Invoice Number›')).toBe(true);expect(confirm.checked).toBe(false);expect(confirm.disabled).toBe(true);
    expect((screen.getByRole('button',{name:'Confirm & Send Email'}) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button',{name:'Update Preview'}));
    await waitFor(()=>expect(confirm.disabled).toBe(false));
    const previewCalls=vi.mocked(fetch).mock.calls.filter(([url])=>url==='/api/email/preview');
    expect(JSON.parse(String(previewCalls[1][1]!.body)).bodyTemplate).toContain('{{invoice_number}}Dear {{client_contact_name}}');
    fireEvent.click(confirm);fireEvent.click(screen.getByRole('button',{name:'Confirm & Send Email'}));
    await screen.findByText('Accepted by mail server');
    const sent=vi.mocked(fetch).mock.calls.find(([url])=>url==='/api/email/request-payment');
    expect(sent).toBeTruthy();expect(JSON.parse(String(sent![1]!.body))).toMatchObject({invoiceId:'inv-1',previewFingerprint:'review-fingerprint',bodyTemplate:expect.stringContaining('{{invoice_number}}Dear {{client_contact_name}}')});
    expect(vi.mocked(fetch).mock.calls.some(([url])=>url==='/api/email/templates')).toBe(false);
  });
  it('blocks an incomplete field and never submits an unreviewed message',async()=>{
    render(React.createElement(RequestPaymentModal,{isOpen:true,onClose:vi.fn(),invoiceId:'inv-1'}));
    await screen.findByText('Final Email Preview');fireEvent.click(screen.getByRole('button',{name:'Edit message'}));
    const message=await screen.findByLabelText('Email message');fireEvent.change(message,{target:{value:'Dear ‹Client Nam›'}});
    fireEvent.click(screen.getByRole('button',{name:'Update Preview'}));expect(screen.getByText(/A field was changed/)).toBeTruthy();
    expect((screen.getByRole('button',{name:'Confirm & Send Email'}) as HTMLButtonElement).disabled).toBe(true);
    expect(vi.mocked(fetch).mock.calls).toHaveLength(1);
  });
  it('requires a fresh preview and confirmation after the server detects a changed invoice',async()=>{
    sendConflict=true;render(React.createElement(RequestPaymentModal,{isOpen:true,onClose:vi.fn(),invoiceId:'inv-1'}));
    await screen.findByText('Final Email Preview');const confirm=screen.getByRole('checkbox') as HTMLInputElement;
    fireEvent.click(confirm);fireEvent.click(screen.getByRole('button',{name:'Confirm & Send Email'}));
    await screen.findByText(/invoice, recipient, or message has changed/);expect(confirm.checked).toBe(false);expect(confirm.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button',{name:'Update Preview'}));await waitFor(()=>expect(confirm.disabled).toBe(false));expect(confirm.checked).toBe(false);
  });
  it('does not allow an old preview response to replace a newer invoice', async () => {
    let resolveOld!: (response: Response) => void;
    vi.mocked(fetch).mockImplementation(async (_url, options) => {
      const input=JSON.parse(String(options?.body));
      if (input.invoiceId === 'inv-old') return new Promise<Response>(resolve => { resolveOld=resolve; });
      return {ok:true,json:async()=>({...preview(),invoice:{...preview().invoice,invoiceNumber:'INV-NEW'}})} as Response;
    });
    const rendered=render(React.createElement(RequestPaymentModal,{isOpen:true,onClose:vi.fn(),invoiceId:'inv-old'}));
    rendered.rerender(React.createElement(RequestPaymentModal,{isOpen:true,onClose:vi.fn(),invoiceId:'inv-new'}));
    expect((await screen.findAllByText('INV-NEW')).length).toBeGreaterThan(0);
    await act(async () => { resolveOld({ok:true,json:async()=>({...preview(),invoice:{...preview().invoice,invoiceNumber:'INV-OLD'}})} as Response); });
    await waitFor(()=>expect(screen.queryByText('INV-OLD')).toBeNull());
    expect(screen.getAllByText('INV-NEW').length).toBeGreaterThan(0);
  });

  it('shows the preview first and preserves unfinished edits when the editor is collapsed', async () => {
    render(React.createElement(RequestPaymentModal,{isOpen:true,onClose:vi.fn(),invoiceId:'inv-1'}));
    await screen.findByText('Final Email Preview');expect(screen.getByLabelText('Email message').closest('[hidden]')).not.toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'Edit message'}));const message=screen.getByLabelText('Email message') as HTMLTextAreaElement;
    fireEvent.change(message,{target:{value:'One-time wording'}});
    fireEvent.click(screen.getByRole('button',{name:'Close editor'}));expect(screen.getByLabelText('Email message').closest('[hidden]')).not.toBeNull();
    expect(screen.getByText(/Your message has changed/)).toBeTruthy();expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button',{name:'Edit message'}));expect((screen.getByLabelText('Email message') as HTMLTextAreaElement).value).toBe('One-time wording');
  });

});
