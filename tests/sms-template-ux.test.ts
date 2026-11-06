// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { SmsTemplateCard } from '@/components/email/SmsTemplateCard';
import { DEFAULT_SMS_TEMPLATE } from '@/lib/sms/templates';
beforeEach(()=>{
  vi.stubGlobal('requestAnimationFrame',(callback:FrameRequestCallback)=>{callback(0);return 1;});
  vi.stubGlobal('fetch',vi.fn(async (_url:string, options?:RequestInit)=>{
    if (!options?.method) return {ok:true,json:async()=>({template:DEFAULT_SMS_TEMPLATE,revision:0})};
    const body=JSON.parse(String(options.body));return {ok:true,json:async()=>({template:body.template,revision:1})};
  }));
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
describe('SMS template in Settings',()=>{
  it('keeps the editor compact, previews sample data, preserves unsaved text and saves compatible fields',async()=>{
    render(React.createElement(SmsTemplateCard));fireEvent.click(screen.getByRole('button',{name:'Edit & preview SMS'}));
    const input=await screen.findByLabelText('SMS template') as HTMLTextAreaElement;
    await waitFor(()=>expect(input.value).toContain('‹Client Name›'));
    expect(screen.getByText(/Juan Dela Cruz/)).toBeTruthy();
    fireEvent.change(input,{target:{value:'Dear ‹Client Name›, invoice ‹Invoice Number›'}});
    fireEvent.click(screen.getByRole('button',{name:'Close editor'}));expect(input.closest('[hidden]')).not.toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'Edit & preview SMS'}));expect(input.value).toContain('‹Invoice Number›');
    fireEvent.click(screen.getByRole('button',{name:'Save SMS template'}));
    await waitFor(()=>expect(vi.mocked(fetch).mock.calls.some(([,opt])=>opt?.method==='PUT')).toBe(true));
    const put=vi.mocked(fetch).mock.calls.find(([,opt])=>opt?.method==='PUT')!;
    expect(JSON.parse(String(put[1]?.body)).template).toBe('Dear {{client_contact_name}}, invoice {{invoice_number}}');
  });
  it('rejects partly edited fields without saving',async()=>{
    render(React.createElement(SmsTemplateCard));fireEvent.click(screen.getByRole('button',{name:'Edit & preview SMS'}));
    const input=await screen.findByLabelText('SMS template');await waitFor(()=>expect((input as HTMLTextAreaElement).value).toContain('‹Client Name›'));
    fireEvent.change(input,{target:{value:'Hello ‹Client Nam›'}});fireEvent.click(screen.getByRole('button',{name:'Save SMS template'}));
    expect(screen.getAllByText(/A field was changed/).length).toBeGreaterThan(0);expect(vi.mocked(fetch).mock.calls.every(([,opt])=>!opt?.method)).toBe(true);
  });
});
