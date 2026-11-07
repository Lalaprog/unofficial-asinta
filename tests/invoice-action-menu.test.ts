// @vitest-environment jsdom
vi.mock('@/lib/sms/loadTemplate', () => ({ loadSMSTemplate: async () => 'Dear {{client_contact_name}}, invoice {{invoice_number}}.' }));
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ sendSMS: vi.fn(), createInvoice: vi.fn(), recordInvoicePayment: vi.fn(), emailLookup: vi.fn() }));
vi.mock('@/components/layout/AppShell', () => ({ AppShell: ({ children }: { children: React.ReactNode }) => React.createElement('main', null, children) }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('@/lib/data/store', () => ({ useDataStore: () => ({
  invoices: [
    { id: 'pending', invoice_number: 'ASINTA-2026-001', status: 'pending', project_id: 'site', client_id: 'client', amount: 1000, amount_paid: 0, issue_date: '2026-10-01', due_date: '2026-11-01' },
    { id: 'paid', invoice_number: 'ASINTA-2026-002', status: 'paid', project_id: 'site', client_id: 'client', amount: 500, amount_paid: 500, issue_date: '2026-10-01', due_date: '2026-11-01' },
    { id: 'cancelled', invoice_number: 'ASINTA-2026-003', status: 'cancelled', project_id: 'site', client_id: 'client', amount: 500, amount_paid: 0, issue_date: '2026-10-01', due_date: '2026-11-01' },
  ],
  projects: [{ id: 'site', name: 'Test Site', client_id: 'client' }],
  clients: [{ id: 'client', name: 'Test Client', contact_person: 'Pat', phone: '09171234567' }],
  createInvoice: mock.createInvoice, recordInvoicePayment: mock.recordInvoicePayment, sendSMS: mock.sendSMS,
}) }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({
  from: () => ({ select() { return this; }, eq() { return this; }, in() { return this; }, order() { return this; }, limit() { return this; }, maybeSingle: () => mock.emailLookup() }),
}) }));
vi.mock('@/components/email/RequestPaymentModal', () => ({ RequestPaymentModal: ({ isOpen, invoiceId }: { isOpen: boolean; invoiceId: string | null }) => isOpen ? React.createElement('div', { role: 'dialog', 'aria-label': 'Payment request' }, invoiceId) : null }));
vi.mock('@/components/email/EmailHistoryModal', () => ({ EmailHistoryModal: ({ isOpen, invoiceId }: { isOpen: boolean; invoiceId: string | null }) => isOpen ? React.createElement('div', { role: 'dialog', 'aria-label': 'Email history' }, invoiceId) : null }));
import InvoicesPage from '@/app/invoices/page';

beforeAll(() => {
  // Radix uses pointer capture and scrolling APIs which jsdom does not implement.
  window.PointerEvent = MouseEvent as typeof PointerEvent;
  HTMLElement.prototype.hasPointerCapture = () => false;
  HTMLElement.prototype.setPointerCapture = () => {};
  HTMLElement.prototype.releasePointerCapture = () => {};
  HTMLElement.prototype.scrollIntoView = () => {};
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
});
beforeEach(() => { vi.clearAllMocks(); mock.emailLookup.mockReset().mockResolvedValue({data:null,error:null}); });
afterEach(() => cleanup());

const trigger = (number: string) => screen.getByRole('button', { name: `More actions for ${number}` });
function open(number: string) {
  fireEvent.pointerDown(trigger(number), { button: 0, ctrlKey: false, pointerType: 'mouse' });
}

describe('invoice action menu', () => {
  it('opens a portalled overlay without adding actions inside the invoice row, and Escape returns focus', async () => {
    render(React.createElement(InvoicesPage));
    const button = trigger('ASINTA-2026-001');
    const row = button.closest('.hover\\:bg-surface')!;
    button.focus();
    open('ASINTA-2026-001');
    const menu = await screen.findByRole('menu', { name: 'More actions for ASINTA-2026-001' });
    expect(row.contains(menu)).toBe(false);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(3);
    fireEvent.keyDown(menu, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(button);
  });

  it('opens from the keyboard and dismisses on an outside pointer without sending', async () => {
    render(React.createElement(InvoicesPage));
    const button = trigger('ASINTA-2026-001');
    button.focus();
    fireEvent.keyDown(button, { key: 'Enter' });
    await screen.findByRole('menu');
    fireEvent.pointerDown(document.body, { button: 0, pointerType: 'mouse' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(mock.sendSMS).not.toHaveBeenCalled();
  });

  it('shows only history for paid and cancelled invoices, and switches to another invoice', async () => {
    render(React.createElement(InvoicesPage));
    open('ASINTA-2026-001');
    await screen.findByRole('menu');
    open('ASINTA-2026-002');
    const menu = await screen.findByRole('menu', { name: 'More actions for ASINTA-2026-002' });
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Email history']);
    open('ASINTA-2026-003');
    const cancelled = await screen.findByRole('menu', { name: 'More actions for ASINTA-2026-003' });
    expect(within(cancelled).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Email history']);
  });

  it('opens the selected invoice’s payment request and history, without sending anything', async () => {
    render(React.createElement(InvoicesPage));
    open('ASINTA-2026-001');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Send payment request' }));
    expect((await screen.findByRole('dialog', { name: 'Payment request' })).textContent).toBe('pending');
    expect(mock.sendSMS).not.toHaveBeenCalled();
    cleanup();
    render(React.createElement(InvoicesPage));
    open('ASINTA-2026-002');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Email history' }));
    expect((await screen.findByRole('dialog', { name: 'Email history' })).textContent).toBe('paid');
  });

  it('warns when email history cannot be checked while preparing an SMS', async () => {
    mock.emailLookup.mockResolvedValue({data:null,error:{message:'offline'}});
    render(React.createElement(InvoicesPage));open('ASINTA-2026-001');
    fireEvent.click(await screen.findByRole('menuitem',{name:'Send SMS reminder'}));
    const dialog = await screen.findByRole('dialog',{name:'Send PhilSMS Payment Notification'});
    expect(within(dialog).getByText(/Could not verify the payment-request email history/)).toBeTruthy();
    expect(mock.sendSMS).not.toHaveBeenCalled();
  });

  it('prepares an SMS for review without sending it', async () => {
    render(React.createElement(InvoicesPage));
    open('ASINTA-2026-001');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Send SMS reminder' }));
    const dialog = await screen.findByRole('dialog', { name: 'Send PhilSMS Payment Notification' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Edit message' }));
    expect((within(dialog).getByLabelText('Reminder message') as HTMLTextAreaElement).value).toContain('ASINTA-2026-001');
    expect(mock.sendSMS).not.toHaveBeenCalled();
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Send PhilSMS Payment Notification' })).toBeNull());
    expect(document.activeElement).toBe(trigger('ASINTA-2026-001'));
  });
});
