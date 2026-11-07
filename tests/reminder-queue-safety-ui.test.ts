// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
const mock = vi.hoisted(()=>({store:{} as any,query:vi.fn(),toast:vi.fn(),template:vi.fn()}));
vi.mock('@/components/layout/AppShell',()=>({AppShell:({children}:{children:React.ReactNode})=>React.createElement('main',null,children)}));
vi.mock('@/lib/data/store',()=>({useDataStore:()=>mock.store}));
vi.mock('@/components/ui/Toast',()=>({useToast:()=>({showToast:mock.toast})}));
vi.mock('@/lib/sms/loadTemplate',()=>({loadSMSTemplate:()=>mock.template()}));
vi.mock('@/lib/supabase/client',()=>({createClient:()=>({from:()=>{
  const query:any={select:()=>query,in:()=>query,eq:()=>query,order:()=>query,then:(...args:any[])=>mock.query().then(...args)};return query;
}})}));
import RemindersPage from '@/app/reminders/page';
import { DEFAULT_SMS_TEMPLATE } from '@/lib/sms/templates';
const invoice={id:'invoice',invoice_number:'INV-1',client_id:'client',project_id:'project',amount:100,amount_paid:0,status:'pending',due_date:'2020-01-01',automatic_reminders_enabled:false,reminders_paused_until:null};
beforeEach(()=>{
  mock.store={invoices:[invoice],clients:[{id:'client',name:'Client',phone:'09123456789'}],projects:[{id:'project',name:'Site'}],smsLogs:[],sendSMS:vi.fn(),updateInvoice:vi.fn(async()=>({...invoice,automatic_reminders_enabled:true})),loadError:null,refresh:vi.fn()};
  mock.query.mockReset().mockResolvedValue({data:[],error:null}); mock.template.mockReset().mockResolvedValue(DEFAULT_SMS_TEMPLATE);mock.toast.mockReset();
  vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>({settings:{master_enabled:false,email_enabled:true,sms_enabled:false,revision:1},rolloutReady:false})})));
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
describe('reminder queue safety and states',()=>{
  it('shows the saved preference without implying that automatic messages are active',async()=>{
    render(React.createElement(RemindersPage));await screen.findByText('Automatic reminders: OFF');
    expect(screen.getByText(/Invoice preferences do not turn on automatic reminders/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'Allow automatic reminders for this invoice'}));
    await waitFor(()=>expect(mock.toast).toHaveBeenCalledWith('success',expect.stringContaining('Check Settings')));
    expect(mock.store.updateInvoice).toHaveBeenCalledWith('invoice',{automatic_reminders_enabled:true});
    expect(mock.store.sendSMS).not.toHaveBeenCalled();
  });
  it('reports history loading and failed history rather than claiming no email was sent',async()=>{
    let resolve!: (value:unknown)=>void; mock.query.mockImplementation(()=>new Promise(r=>{resolve=r;}));
    render(React.createElement(RemindersPage));expect(screen.getByText(/checking…/)).toBeTruthy();
    expect(screen.queryByText(/none on record/i)).toBeNull();
    await act(async()=>resolve({data:null,error:{message:'offline'}}));
    expect(screen.getByText(/could not verify/)).toBeTruthy();
    mock.query.mockResolvedValue({data:[],error:null});
    fireEvent.click(screen.getByRole('button',{name:'Retry email history'}));
    await waitFor(()=>expect(screen.getByText(/none in loaded history/)).toBeTruthy());
    expect(screen.queryByText(/Could not check the latest payment-request emails/)).toBeNull();
  });
  it('ignores an older email-history response after a refresh',async()=>{
    let resolveOld!: (value:unknown)=>void;
    mock.query.mockImplementationOnce(()=>new Promise(r=>{resolveOld=r;})).mockResolvedValueOnce({data:[],error:null});
    render(React.createElement(RemindersPage));fireEvent(window,new Event('focus'));
    await waitFor(()=>expect(screen.getByText(/none in loaded history/)).toBeTruthy());
    await act(async()=>resolveOld({data:[{invoice_id:'invoice',sent_at:'2026-02-01T00:00:00Z'}],error:null}));
    expect(screen.getByText(/none in loaded history/)).toBeTruthy();
  });
  it('does not present an incomplete ledger as an empty queue',async()=>{
    mock.store.invoices=[];mock.store.loadError='offline';render(React.createElement(RemindersPage));
    expect(screen.getByText(/reminder queue may be incomplete/)).toBeTruthy();
    expect(screen.queryByText('No reminders to show')).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'Retry loading'}));expect(mock.store.refresh).toHaveBeenCalled();
  });
  it('does not put a draft invoice in the paused reminder list',()=>{
    mock.store.invoices=[{...invoice,status:'draft',reminders_paused_until:'2999-01-01T00:00:00Z'}];
    render(React.createElement(RemindersPage));expect(screen.queryByText('Paused Reminders')).toBeNull();
  });
});
