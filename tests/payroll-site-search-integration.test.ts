// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  rpc: vi.fn(), create: vi.fn(),
  projects: Array.from({ length: 10 }, (_, i) => ({ id: `site-${i}`, name: i === 8 ? 'Luna Site' : `Site ${i}`, location: 'Batangas, PH' })),
}));
vi.mock('@/components/layout/AppShell', () => ({ AppShell: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('@/lib/auth/authContext', () => ({ useAuth: () => ({ user: { id: 'founder' }, isFounder: true }) }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ rpc: mock.rpc }) }));
vi.mock('@/lib/data/store', () => ({ useDataStore: () => ({
  payroll: [], workers: [], projects: mock.projects, attendance: [], advances: [],
  createPayrollRun: mock.create, updatePayrollStatus: vi.fn(),
}) }));
import PayrollPage from '@/app/payroll/page';

beforeEach(() => { mock.create.mockReset(); mock.rpc.mockReset(); });
afterEach(cleanup);

describe('payroll project site search', () => {
  it('filters voucher choices without changing the filter until a site is selected', () => {
    render(React.createElement(PayrollPage));
    const region = screen.getByRole('region', { name: 'Find a payroll voucher' });
    const select = within(region).getByRole('combobox', { name: 'Project' }) as HTMLSelectElement;
    fireEvent.click(within(region).getByRole('button', { name: 'Search voucher project sites' }));
    fireEvent.change(within(region).getByRole('searchbox', { name: 'Search voucher project sites' }), { target: { value: 'luna' } });
    expect(select.value).toBe('all');
    expect(within(select).getByRole('option', { name: 'All Project Sites' })).toBeTruthy();
    expect(within(select).queryByRole('option', { name: 'Site 0 (Batangas)' })).toBeNull();
    fireEvent.change(select, { target: { value: 'site-8' } });
    fireEvent.change(within(region).getByRole('searchbox'), { target: { value: 'no match' } });
    expect(select.value).toBe('site-8');
    expect(within(select).getByRole('option', { name: 'Luna Site (Batangas)' })).toBeTruthy();
    expect(mock.create).not.toHaveBeenCalled();
  });

  it('keeps matrix and run scope unchanged while searching, then shares an explicitly selected site', async () => {
    mock.create.mockResolvedValue(false);
    render(React.createElement(PayrollPage));
    fireEvent.click(screen.getByRole('button', { name: /Payroll-period attendance matrix/ }));
    const matrixSelect = screen.getByRole('combobox', { name: 'Matrix project site' }) as HTMLSelectElement;
    fireEvent.click(screen.getByRole('button', { name: 'Search matrix project sites' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search matrix project sites' }), { target: { value: 'luna' } });
    expect(matrixSelect.value).toBe('all');
    expect(mock.rpc).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'New Payroll Run' }));
    const dialog = screen.getByRole('dialog', { name: 'Compute Weekly / Bi-Monthly Payroll' });
    const runSelect = within(dialog).getByRole('combobox', { name: 'Project Site Scope' }) as HTMLSelectElement;
    expect(runSelect.value).toBe('all');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Search payroll run sites' }));
    const search = within(dialog).getByRole('searchbox', { name: 'Search payroll run sites' });
    fireEvent.change(search, { target: { value: 'luna' } });
    fireEvent.keyDown(search, { key: 'Enter', code: 'Enter' });
    expect(runSelect.value).toBe('all');
    expect(mock.create).not.toHaveBeenCalled();
    fireEvent.change(runSelect, { target: { value: 'site-8' } });
    expect(matrixSelect.value).toBe('site-8');
    fireEvent.change(search, { target: { value: 'no match' } });
    expect(runSelect.value).toBe('site-8');
    expect(within(runSelect).getByRole('option', { name: 'Luna Site (Batangas)' })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Generate / Refresh Payroll Run' }));
    await waitFor(() => expect(mock.create).toHaveBeenCalledWith(expect.any(String), expect.any(String), 'site-8'));
    expect(mock.rpc).not.toHaveBeenCalled();
  });
});
