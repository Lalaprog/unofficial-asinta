// @vitest-environment jsdom
import React from 'react';
import {cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const mock=vi.hoisted(()=>({record:vi.fn(),toast:vi.fn(),invoice:{id:'inv',invoice_number:'INV-1',status:'pending',project_id:'p',client_id:'c',amount:100,amount_paid:0,issue_date:'2026-01-01',due_date:'2026-02-01'}}));
vi.mock('@/components/layout/AppShell',()=>({AppShell:({children}:{children:React.ReactNode})=>children}));
vi.mock('@/components/ui/Toast',()=>({useToast:()=>({showToast:mock.toast})}));
vi.mock('@/lib/data/store',()=>({useDataStore:()=>({invoices:[mock.invoice],projects:[{id:'p',name:'Site'}],clients:[{id:'c',name:'Client'}],createInvoice:vi.fn(),recordInvoicePayment:mock.record,sendSMS:vi.fn()})}));
vi.mock('@/lib/supabase/client',()=>({createClient:()=>({})}));
vi.mock('@/components/email/RequestPaymentModal',()=>({RequestPaymentModal:()=>null}));
vi.mock('@/components/email/EmailHistoryModal',()=>({EmailHistoryModal:()=>null}));
import InvoicesPage from '@/app/invoices/page';
beforeEach(()=>{vi.clearAllMocks();Object.assign(mock.invoice,{status:'pending',amount_paid:0})});
afterEach(()=>cleanup());
const dialog=()=>screen.getByRole('dialog',{name:'Record Client Payment'});
const submit=()=>fireEvent.click(within(dialog()).getByRole('button',{name:'Confirm Payment Receipt'}));
function open(){render(React.createElement(InvoicesPage));fireEvent.click(screen.getByRole('button',{name:'Record payment'}))}
describe('invoice payment review',()=>{
  it('submits the invoice shown in the dialog and the amount, once',async()=>{
    mock.record.mockResolvedValue('recorded');open();fireEvent.change(within(dialog()).getByLabelText('Payment Amount Received (PHP ₱)'),{target:{value:'35.25'}});submit();
    await waitFor(()=>expect(mock.record).toHaveBeenCalledWith(expect.objectContaining({id:'inv',amount:100,amount_paid:0,status:'pending'}),'35.25'));
    expect(mock.toast).toHaveBeenCalledWith('success','Payment recorded.');
  });
  it.each([
    ['unconfirmed','payment result could not be confirmed'],
    ['stale','invoice changed or is unavailable'],
    ['audit_unconfirmed','payment was saved, but its audit entry could not be confirmed'],
  ])('stops retries and shows persistent guidance for %s',async(result,notice)=>{
    mock.record.mockResolvedValue(result);open();submit();
    await screen.findByText(new RegExp(notice));
    expect((within(dialog()).getByRole('button',{name:'Confirm Payment Receipt'}) as HTMLButtonElement).disabled).toBe(true);
    expect((within(dialog()).getByLabelText('Payment Amount Received (PHP ₱)') as HTMLInputElement).disabled).toBe(true);
    expect(within(dialog()).getByRole('button',{name:'Close'})).toBeTruthy();
    expect(mock.record).toHaveBeenCalledTimes(1);expect(mock.toast).not.toHaveBeenCalledWith('success','Payment recorded.');
  });
  it('keeps invalid input editable instead of marking payment saved',async()=>{
    mock.record.mockResolvedValue('invalid');open();submit();await screen.findByText(/Enter a valid payment/);
    expect((within(dialog()).getByRole('button',{name:'Confirm Payment Receipt'}) as HTMLButtonElement).disabled).toBe(false);
  });
});
