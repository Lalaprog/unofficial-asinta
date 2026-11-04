// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createInvoice: vi.fn(), createPayrollRun: vi.fn(), createTool: vi.fn(), updateTool: vi.fn(),
  projects: [{ id: 'site-1', name: 'Synthetic site', location: 'Batangas, PH', client_id: 'client-1' }],
  clients: [{ id: 'client-1', name: 'Synthetic client' }],
}));
vi.mock('@/components/layout/AppShell', () => ({ AppShell: ({children}: {children: React.ReactNode}) => children }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('@/lib/auth/authContext', () => ({ useAuth: () => ({user: {id:'founder'}, isFounder:true}) }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({rpc: vi.fn()}) }));
vi.mock('@/lib/data/store', () => ({ useDataStore: () => ({
  projects: mocks.projects, clients: mocks.clients, invoices: [], workers: [],
  payroll: [], attendance: [], advances: [], tools: [],
  createInvoice: mocks.createInvoice, createPayrollRun: mocks.createPayrollRun,
  createTool: mocks.createTool, updateTool: mocks.updateTool,
  updatePayrollStatus: vi.fn(), recordInvoicePayment: vi.fn(), sendSMS: vi.fn(),
  deleteTool: vi.fn(), refresh: vi.fn(),
}) }));
vi.mock('@/components/email/RequestPaymentModal', () => ({ RequestPaymentModal: () => null }));
vi.mock('@/components/email/EmailHistoryModal', () => ({ EmailHistoryModal: () => null }));

import InvoicesPage from '@/app/invoices/page';
import PayrollPage from '@/app/payroll/page';
import ToolsPage from '@/app/tools/page';

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

function responsiveGrid(field: HTMLElement) {
  const grid = field.closest('.grid');
  expect(grid).not.toBeNull();
  expect(grid?.className).toContain('grid-cols-1');
  expect(grid?.className).toContain('sm:grid-cols-2');
  return grid;
}

describe('responsive fields in real dialogs', () => {
  it('keeps invoice number, project, amount and both dates available without submitting', () => {
    render(React.createElement(InvoicesPage));
    fireEvent.click(screen.getByRole('button', {name: 'New Invoice'}));
    const dialog = screen.getByRole('dialog', {name: 'Create Milestone Progress Invoice'});
    const invoice = within(dialog).getByLabelText('Invoice Number') as HTMLInputElement;
    const project = within(dialog).getByLabelText('Associated Project') as HTMLSelectElement;
    expect(responsiveGrid(invoice)).toBe(responsiveGrid(project));
    const amount = within(dialog).getByLabelText('Invoice Amount (PHP ₱)') as HTMLInputElement;
    const issue = within(dialog).getByLabelText('Issue Date') as HTMLInputElement;
    const due = within(dialog).getByLabelText('Due Date') as HTMLInputElement;
    expect(responsiveGrid(amount)).toBe(responsiveGrid(issue));
    expect(responsiveGrid(issue)).toBe(responsiveGrid(due));
    expect(amount.parentElement?.parentElement?.parentElement?.className).toContain('sm:col-span-2');
    fireEvent.change(project, {target:{value:'site-1'}});
    fireEvent.change(amount, {target:{value:'1500000'}});
    expect(project.value).toBe('site-1');
    expect(amount.value).toBe('1500000');
    expect(invoice.value).toMatch(/^ASINTA-/);
    expect(mocks.createInvoice).not.toHaveBeenCalled();
  });

  it('keeps both payroll dates individually editable without generating a run', () => {
    render(React.createElement(PayrollPage));
    fireEvent.click(screen.getByRole('button', {name:'New Payroll Run'}));
    const dialog = screen.getByRole('dialog', {name:'Compute Weekly / Bi-Monthly Payroll'});
    const start = within(dialog).getByLabelText('Period Start Date') as HTMLInputElement;
    const end = within(dialog).getByLabelText('Period End Date') as HTMLInputElement;
    expect(responsiveGrid(start)).toBe(responsiveGrid(end));
    fireEvent.change(start, {target:{value:'2026-01-01'}});
    fireEvent.change(end, {target:{value:'2026-01-31'}});
    expect(start.value).toBe('2026-01-01');
    expect(end.value).toBe('2026-01-31');
    expect(mocks.createPayrollRun).not.toHaveBeenCalled();
  });

  it('keeps equipment quantity and condition editable without changing inventory', () => {
    render(React.createElement(ToolsPage));
    fireEvent.click(screen.getByRole('button', {name:'Add Tool'}));
    const dialog = screen.getByRole('dialog', {name:'Register New Tool / Machine'});
    const quantity = within(dialog).getByLabelText('Quantity (Units)') as HTMLInputElement;
    const condition = within(dialog).getByLabelText('Equipment Condition') as HTMLSelectElement;
    expect(responsiveGrid(quantity)).toBe(responsiveGrid(condition));
    fireEvent.change(quantity, {target:{value:'12'}});
    fireEvent.change(condition, {target:{value:'good'}});
    expect(quantity.value).toBe('12');
    expect(condition.value).toBe('good');
    expect(mocks.createTool).not.toHaveBeenCalled();
    expect(mocks.updateTool).not.toHaveBeenCalled();
  });
});
