// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ create: vi.fn(), send: vi.fn() }));
vi.mock('@/components/layout/AppShell', () => ({ AppShell: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('@/lib/auth/authContext', () => ({ useAuth: () => ({ isFounder: true, assurance: 'ready', isLoading: false }) }));
vi.mock('@/lib/data/store', () => ({ useDataStore: () => ({ invoices: [], projects: [{ id:'p', name:'Site', client_id:'c' }], clients: [{ id:'c', name:'Client' }], isLoaded:true, createInvoice:state.create, recordInvoicePayment:vi.fn(), sendSMS:state.send }) }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({}) }));
vi.mock('@/components/email/RequestPaymentModal', () => ({ RequestPaymentModal: () => null }));
vi.mock('@/components/email/EmailHistoryModal', () => ({ EmailHistoryModal: () => null }));
import InvoicesPage from '@/app/invoices/page';
afterEach(() => { cleanup(); vi.useRealTimers(); state.create.mockReset(); state.send.mockReset(); });
const value = (label:string) => (screen.getByLabelText(label) as HTMLInputElement).value;
describe('Manila invoice date defaults', () => {
  it('refreshes untouched dates at Manila midnight and preserves edited dates and other draft fields', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-12-31T15:59:00Z'));
    render(React.createElement(InvoicesPage));
    vi.setSystemTime(new Date('2026-12-31T16:01:00Z'));
    fireEvent.click(screen.getByRole('button', { name:'New Invoice' }));
    expect(value('Issue Date')).toBe('2027-01-01'); expect(value('Due Date')).toBe('2027-01-16');
    expect(value('Invoice Number')).toBe('ASINTA-2027-001');
    fireEvent.change(screen.getByLabelText('Issue Date'), { target:{ value:'2026-12-01' } });
    fireEvent.change(screen.getByLabelText('Due Date'), { target:{ value:'2026-12-20' } });
    fireEvent.change(screen.getByLabelText('Billing Milestone Description'), { target:{ value:'Saved draft text' } });
    fireEvent.click(screen.getByRole('button', { name:'Cancel' }));
    vi.setSystemTime(new Date('2027-01-01T16:01:00Z'));
    fireEvent.click(screen.getByRole('button', { name:'New Invoice' }));
    expect(value('Issue Date')).toBe('2026-12-01'); expect(value('Due Date')).toBe('2026-12-20');
    expect(value('Invoice Number')).toBe('ASINTA-2026-001');
    expect(value('Billing Milestone Description')).toBe('Saved draft text');
    expect(state.create).not.toHaveBeenCalled(); expect(state.send).not.toHaveBeenCalled();
  });
  it('preserves the untouched due date when an edited issue-date draft is reopened', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-12-31T15:59:00Z'));
    render(React.createElement(InvoicesPage));
    fireEvent.click(screen.getByRole('button', { name:'New Invoice' }));
    fireEvent.change(screen.getByLabelText('Issue Date'), { target:{ value:'2026-12-10' } });
    fireEvent.click(screen.getByRole('button', { name:'Cancel' }));
    vi.setSystemTime(new Date('2027-01-01T16:01:00Z'));
    fireEvent.click(screen.getByRole('button', { name:'New Invoice' }));
    expect(value('Issue Date')).toBe('2026-12-10'); expect(value('Due Date')).toBe('2027-01-15');
  });
  it('resets edited dates after a mocked successful create', async () => {
    vi.useFakeTimers({ toFake:['Date'] }); vi.setSystemTime(new Date('2026-12-31T16:01:00Z'));
    state.create.mockImplementation(async input => ({ ...input, id:'mock-invoice' }));
    render(React.createElement(InvoicesPage));
    fireEvent.click(screen.getByRole('button', { name:'New Invoice' }));
    fireEvent.change(screen.getByLabelText('Associated Project'), { target:{ value:'p' } });
    fireEvent.change(screen.getByLabelText('Billing Milestone Description'), { target:{ value:'Mock milestone' } });
    fireEvent.change(screen.getByLabelText('Invoice Amount (PHP ₱)'), { target:{ value:'100' } });
    fireEvent.change(screen.getByLabelText('Issue Date'), { target:{ value:'2026-12-10' } });
    fireEvent.change(screen.getByLabelText('Due Date'), { target:{ value:'2026-12-20' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name:'Generate Invoice' })); });
    expect(state.create).toHaveBeenCalledOnce(); expect(state.send).not.toHaveBeenCalled();
    vi.setSystemTime(new Date('2027-01-01T16:01:00Z'));
    fireEvent.click(screen.getByRole('button', { name:'New Invoice' }));
    expect(value('Issue Date')).toBe('2027-01-02'); expect(value('Due Date')).toBe('2027-01-17');
    expect(value('Billing Milestone Description')).toBe('');
  });
  it('uses the Manila date from the mobile quick action without creating or sending', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-12-31T16:01:00Z'));
    render(React.createElement(InvoicesPage));
    act(() => window.dispatchEvent(new CustomEvent('asinta:mobile-quick-action', { detail:'invoice' })));
    expect(value('Issue Date')).toBe('2027-01-01'); expect(value('Due Date')).toBe('2027-01-16');
    expect(state.create).not.toHaveBeenCalled(); expect(state.send).not.toHaveBeenCalled();
  });
});
