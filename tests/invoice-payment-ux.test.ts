// @vitest-environment jsdom
import React from 'react';
import {cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
const mock = vi.hoisted(() => ({ record:vi.fn(), toast:vi.fn(), invoice:{id:'inv',invoice_number:'INV-1',status:'pending',project_id:'p',client_id:'c',amount:100,amount_paid:0,issue_date:'2026-01-01',due_date:'2026-02-01'} }));
vi.mock('@/components/layout/AppShell',()=>({AppShell:({children}:{children:React.ReactNode})=>children}));
vi.mock('@/components/ui/Toast',()=>({useToast:()=>({showToast:mock.toast})}));
vi.mock('@/lib/data/store',()=>({useDataStore:()=>({invoices:[mock.invoice],projects:[{id:'p',name:'Site'}],clients:[{id:'c',name:'Client'}],createInvoice:vi.fn(),recordInvoicePayment:mock.record,sendSMS:vi.fn()})}));
vi.mock('@/lib/supabase/client',()=>({createClient:()=>({})}));
vi.mock('@/components/email/RequestPaymentModal',()=>({RequestPaymentModal:()=>null}));
vi.mock('@/components/email/EmailHistoryModal',()=>({EmailHistoryModal:()=>null}));
import InvoicesPage from '@/app/invoices/page';
import { PAYMENT_STORAGE_PREFIX, paymentStorageKey } from '@/lib/invoices/payment';
beforeEach(()=>{localStorage.clear(); vi.clearAllMocks(); Object.assign(mock.invoice,{status:'pending',amount_paid:0});});
afterEach(()=>{cleanup();vi.restoreAllMocks()});
const dialog = () => screen.getByRole('dialog',{name:'Record Client Payment'});
const submit = () => fireEvent.click(within(dialog()).getByRole('button',{name:/Confirm Payment Receipt|Retry same payment attempt/}));

describe('invoice payment recovery UI',()=>{
  it('persists an unconfirmed request and retries the same details even after reload and a paid invoice', async()=>{
    mock.record.mockResolvedValueOnce({outcome:'unconfirmed'}).mockResolvedValueOnce({outcome:'already_recorded'});
    render(React.createElement(InvoicesPage)); fireEvent.click(screen.getByRole('button',{name:'Record payment'}));
    fireEvent.change(within(dialog()).getByLabelText('Payment Amount Received (PHP ₱)'),{target:{value:'35.25'}}); submit();
    await screen.findByText(/result is not confirmed/);
    const original = mock.record.mock.calls[0][0];
    expect(JSON.parse(localStorage.getItem(paymentStorageKey('inv',original.requestId))!)).toEqual(original);
    expect((within(dialog()).getByLabelText('Payment Amount Received (PHP ₱)') as HTMLInputElement).disabled).toBe(true);
    cleanup(); Object.assign(mock.invoice,{status:'paid',amount_paid:100});
    render(React.createElement(InvoicesPage)); fireEvent.click(await screen.findByRole('button',{name:'Resolve payment'}));
    expect((within(dialog()).getByLabelText('Payment Amount Received (PHP ₱)') as HTMLInputElement).value).toBe('35.25');
    submit(); await waitFor(()=>expect(mock.record).toHaveBeenCalledTimes(2));
    expect(mock.record.mock.calls[1][0]).toEqual(original);
    await waitFor(()=>expect(localStorage.getItem(paymentStorageKey('inv',original.requestId))).toBeNull());
    expect(mock.toast).toHaveBeenCalledWith('success',expect.stringContaining('already recorded'));
  });
  it('requires the user to review a changed invoice instead of automatically re-recording',async()=>{
    mock.record.mockResolvedValue({outcome:'stale',invoice:{...mock.invoice,status:'partially_paid',amount_paid:40}});
    render(React.createElement(InvoicesPage));fireEvent.click(screen.getByRole('button',{name:'Record payment'}));
    fireEvent.change(within(dialog()).getByLabelText('Payment Amount Received (PHP ₱)'),{target:{value:'20'}});submit();
    await screen.findByText(/invoice changed since you opened it/);
    expect((within(dialog()).getByLabelText('Payment Amount Received (PHP ₱)') as HTMLInputElement).value).toBe('');
    expect(mock.record).toHaveBeenCalledTimes(1);expect(localStorage.length).toBe(0);
  });
  it('fails closed before sending if browser storage cannot save recovery information',async()=>{
    render(React.createElement(InvoicesPage));fireEvent.click(screen.getByRole('button',{name:'Record payment'}));
    vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw new Error('storage blocked')});
    submit();await screen.findByText(/could not be safely saved/);expect(mock.record).not.toHaveBeenCalled();
  });
  it('requires a separate confirmation when another tab creates an attempt while this dialog is open', async()=>{
    render(React.createElement(InvoicesPage));fireEvent.click(screen.getByRole('button',{name:'Record payment'}));
    fireEvent.change(within(dialog()).getByLabelText('Payment Amount Received (PHP ₱)'),{target:{value:'20'}});
    const attempt = {requestId:'00000000-0000-4000-8000-000000000010',invoiceId:'inv',amount:'35.00',expectedTotal:100,expectedPaid:0,expectedStatus:'pending'};
    localStorage.setItem(paymentStorageKey('inv',attempt.requestId),JSON.stringify(attempt));
    submit(); await screen.findByText(/Another tab saved a payment attempt/);
    expect(mock.record).not.toHaveBeenCalled();
    expect((within(dialog()).getByLabelText('Payment Amount Received (PHP ₱)') as HTMLInputElement).value).toBe('35.00');
    mock.record.mockResolvedValue({outcome:'already_recorded'}); submit();
    await waitFor(()=>expect(mock.record).toHaveBeenCalledWith(attempt));
  });
  it('does not turn an attempt resolved by another tab into a new payment',async()=>{
    const attempt = {requestId:'00000000-0000-4000-8000-000000000010',invoiceId:'inv',amount:'35.00',expectedTotal:100,expectedPaid:0,expectedStatus:'pending'};
    localStorage.setItem(paymentStorageKey('inv',attempt.requestId),JSON.stringify(attempt));
    render(React.createElement(InvoicesPage));fireEvent.click(await screen.findByRole('button',{name:'Resolve payment'}));
    localStorage.removeItem(paymentStorageKey('inv',attempt.requestId)); submit();
    await screen.findByText(/resolved in another tab/);expect(mock.record).not.toHaveBeenCalled();
  });
  it('preserves a different tab’s saved operation after a successful retry',async()=>{
    const first = {requestId:'00000000-0000-4000-8000-000000000010',invoiceId:'inv',amount:'35.00',expectedTotal:100,expectedPaid:0,expectedStatus:'pending'};
    const second = {...first,requestId:'00000000-0000-4000-8000-000000000011',amount:'20.00'};
    localStorage.setItem(paymentStorageKey('inv',first.requestId),JSON.stringify(first));
    localStorage.setItem(paymentStorageKey('inv',second.requestId),JSON.stringify(second));
    mock.record.mockResolvedValue({outcome:'already_recorded'});
    render(React.createElement(InvoicesPage));fireEvent.click(await screen.findByRole('button',{name:'Resolve payment'}));submit();
    await waitFor(()=>expect(localStorage.getItem(paymentStorageKey('inv',first.requestId))).toBeNull());
    expect(JSON.parse(localStorage.getItem(paymentStorageKey('inv',second.requestId))!)).toEqual(second);
    expect(screen.getByRole('button',{name:'Resolve payment'})).toBeTruthy();
  });
  it('does not replace an unreadable saved attempt',async()=>{
    localStorage.setItem(PAYMENT_STORAGE_PREFIX+'inv:broken','{bad');render(React.createElement(InvoicesPage));
    fireEvent.click(await screen.findByRole('button',{name:'Resolve payment'}));
    expect(screen.getByText(/saved payment attempt cannot be read/)).toBeTruthy();
    expect(mock.record).not.toHaveBeenCalled();expect(localStorage.getItem(PAYMENT_STORAGE_PREFIX+'inv:broken')).toBe('{bad');
  });
});
