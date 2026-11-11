// @vitest-environment jsdom
vi.mock('@/lib/sms/loadTemplate', () => ({ loadSMSTemplate: async () => 'Dear {{client_contact_name}}, invoice {{invoice_number}}.' }));
import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@/types';

const mocks = vi.hoisted(() => ({ store: {} as Record<string, unknown> }));
vi.mock('next/link', () => ({ default: ({ children, href, prefetch: _prefetch, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { prefetch?: boolean }) => React.createElement('a', { ...props, href }, children) }));
vi.mock('@/components/layout/AppShell', () => ({ AppShell: ({ children }: { children: React.ReactNode }) => React.createElement('main', null, children) }));
vi.mock('@/lib/data/store', () => ({ useDataStore: () => mocks.store }));
import FounderDashboard from '@/app/dashboard/page';

const project = (id: string, name: string, status: Project['status']) => ({ id, name, status, location: 'Batangas', client_id: 'c', budget_estimate: 10000, start_date: '2026-01-01', target_completion_date: '2026-12-31', created_at: '2026-01-01' });
const invoice = (id: string, project_id: string, amount: number) => ({ id, project_id, client_id: 'c', invoice_number: id, amount, amount_paid: 0, issue_date: '2026-01-01', due_date: '2099-01-01', status: 'pending', automatic_reminders_enabled: false, reminders_paused_until: null, created_at: '2026-01-01' });
const originalProjects = [project('alpha', 'Alpha', 'active'), project('beta', 'Beta', 'on_hold'), project('gamma', 'Gamma', 'planning'), project('past', 'Completed site', 'completed')];
beforeEach(() => {
  mocks.store = {
    projects: [...originalProjects], isLoaded: true, loadError: null,
    invoices: [invoice('a', 'alpha', 1000), invoice('b', 'beta', 2500), invoice('c', 'past', 5000)],
    expenses: [], advances: [], advanceRequests: [], attendance: [], payroll: [], tools: [], clients: [], sendSMS: vi.fn(),
  };
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function scopeGroup() { return screen.getByRole('group', { name: 'Filter dashboard by project' }); }
function balancesCard() { return screen.getByRole('heading', { name: 'Client balances due' }).closest('.group') as HTMLElement; }

describe('dashboard project scope selector', () => {
  it('removes the static dashboard guide while retaining mobile context and walkthrough targets', () => {
    const view = render(React.createElement(FounderDashboard));
    expect(screen.queryByRole('complementary', { name: 'How to read the dashboard figures' })).toBeNull();
    const balances = view.container.querySelector('[data-dashboard-guide="balances"]') as HTMLElement;
    const costs = view.container.querySelector('[data-dashboard-guide="costs"]') as HTMLElement;
    expect(within(balances).getByText('Draft and cancelled invoices are excluded.').closest('details')?.className).toContain('lg:hidden');
    expect(within(costs).getByText(/activity indicator shows today’s spending/).closest('details')?.className).toContain('lg:hidden');
    expect(view.container.querySelectorAll('[data-dashboard-guide]')).toHaveLength(6);
  });
  it('offers the same loaded current projects as the filter card and scopes the actual totals', () => {
    render(React.createElement(FounderDashboard));
    const selector = screen.getByRole('combobox', { name: 'Project scope' }) as HTMLSelectElement;
    expect(Array.from(selector.options).map((option) => option.textContent)).toEqual(['All projects', 'Alpha', 'Beta', 'Gamma']);
    expect(selector.value).toBe('');
    expect(selector.closest('div.relative')?.parentElement?.className).toContain('lg:hidden');
    expect(selector.getAttribute('aria-label')).toBe('Project scope');
    expect(screen.queryByText('Current project options come from loaded data.')).toBeNull();
    // The existing all-project receivables total includes historical projects.
    expect(within(balancesCard()).getAllByLabelText('₱8,500.00').length).toBeGreaterThan(0);
    fireEvent.change(selector, { target: { value: 'alpha' } });
    expect(selector.value).toBe('alpha');
    expect(within(balancesCard()).getAllByLabelText('₱1,000.00').length).toBeGreaterThan(0);
    expect(within(scopeGroup()).getByRole('button', { name: /Alpha/ }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText(/Focused project view for Alpha/)).toBeTruthy();
    fireEvent.change(selector, { target: { value: 'beta' } });
    expect(within(balancesCard()).getAllByLabelText('₱2,500.00').length).toBeGreaterThan(0);
    expect(within(scopeGroup()).getByRole('button', { name: /Beta/ }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.change(selector, { target: { value: '' } });
    expect(within(scopeGroup()).getByRole('button', { name: /All projects/ }).getAttribute('aria-pressed')).toBe('true');
    expect(within(balancesCard()).getAllByLabelText('₱8,500.00').length).toBeGreaterThan(0);
  });

  it('keeps both controls synchronized when the original card changes or clears the scope', () => {
    render(React.createElement(FounderDashboard));
    const selector = screen.getByRole('combobox', { name: 'Project scope' }) as HTMLSelectElement;
    fireEvent.click(within(scopeGroup()).getByRole('button', { name: /Gamma/ }));
    expect(selector.value).toBe('gamma');
    fireEvent.click(within(scopeGroup()).getByRole('button', { name: /Gamma/ }));
    expect(selector.value).toBe('');
    fireEvent.click(within(scopeGroup()).getByRole('button', { name: /Alpha/ }));
    fireEvent.click(screen.getByRole('button', { name: 'All projects' }));
    expect(selector.value).toBe('');
  });

  it('clears a removed current project after a successful refresh rather than silently restoring it later', () => {
    const view = render(React.createElement(FounderDashboard));
    const selector = screen.getByRole('combobox', { name: 'Project scope' }) as HTMLSelectElement;
    fireEvent.change(selector, { target: { value: 'alpha' } });
    mocks.store.projects = originalProjects.filter((item) => item.id !== 'alpha');
    view.rerender(React.createElement(FounderDashboard));
    expect(selector.value).toBe('');
    expect(within(scopeGroup()).getByRole('button', { name: /All projects/ }).getAttribute('aria-pressed')).toBe('true');
    mocks.store.projects = [...originalProjects];
    view.rerender(React.createElement(FounderDashboard));
    expect(selector.value).toBe('');
  });

  it('handles loading and no available current projects without pretending there are options', () => {
    mocks.store.projects = [];
    mocks.store.isLoaded = false;
    const view = render(React.createElement(FounderDashboard));
    const selector = screen.getByRole('combobox', { name: 'Project scope' }) as HTMLSelectElement;
    expect(selector.disabled).toBe(true);
    expect(selector.getAttribute('aria-busy')).toBe('true');
    mocks.store.isLoaded = true;
    view.rerender(React.createElement(FounderDashboard));
    expect(selector.disabled).toBe(false);
    expect(selector.options).toHaveLength(1);
    expect(screen.getByText('No current projects')).toBeTruthy();
  });
  it('keeps payroll matching by period attendance, voucher notes and advance assignment', () => {
    mocks.store.attendance = [{ id: 'att', worker_id: 'w1', project_id: 'alpha', date: '2026-10-10', status: 'present' }];
    mocks.store.advances = [{ id: 'adv', worker_id: 'w3', project_id: 'beta', amount: 100, amount_deducted: 0, status: 'active', date: '2026-10-01' }];
    const pay = (id: string, worker_id: string, net_pay: number, notes = '') => ({ id, worker_id, period_start: '2026-10-01', period_end: '2026-10-15', gross_pay: net_pay, bale_deduction: 0, other_deductions: 0, net_pay, status: 'approved', notes, created_at: '2026-10-16' });
    mocks.store.payroll = [pay('v1', 'w1', 700), pay('v2', 'w2', 900, 'Site: Beta'), pay('v3', 'w3', 200)];
    render(React.createElement(FounderDashboard));
    const selector = screen.getByRole('combobox', { name: 'Project scope' });
    const workforceCard = screen.getByRole('heading', { name: 'Workforce & pay' }).closest('.group') as HTMLElement;
    fireEvent.change(selector, { target: { value: 'alpha' } });
    expect(within(workforceCard).getAllByLabelText('₱700.00').length).toBeGreaterThan(0);
    fireEvent.change(selector, { target: { value: 'beta' } });
    expect(within(workforceCard).getAllByLabelText('₱1,100.00').length).toBeGreaterThan(0);
  });

  it('distinguishes projects with duplicate names in the native selector', () => {
    mocks.store.projects = [project('one', 'Shared name', 'active'), project('two', 'Shared name', 'active')];
    render(React.createElement(FounderDashboard));
    const selector = screen.getByRole('combobox', { name: 'Project scope' }) as HTMLSelectElement;
    expect(Array.from(selector.options).map((item) => item.textContent)).toEqual(['All projects', 'Shared name — Batangas · one', 'Shared name — Batangas · two']);
    fireEvent.change(selector, { target: { value: 'two' } });
    expect(selector.value).toBe('two');
  });

  it('lets a Founder customize the quick SMS without changing future messages', async () => {
    const overdue={...invoice('late','alpha',1000),due_date:'2020-01-01'};
    const send=vi.fn(async()=>true);mocks.store.invoices=[overdue];mocks.store.sendSMS=send;
    render(React.createElement(FounderDashboard));
    fireEvent.click(screen.getAllByRole('button',{name:'Remind client'})[0]);
    const message=await screen.findByLabelText('SMS message') as HTMLTextAreaElement;
    expect(message.value).toContain('late');
    fireEvent.change(message,{target:{value:'Personal one-time reminder'}});
    fireEvent.click(screen.getByRole('button',{name:'Send PhilSMS Now'}));
    await screen.findByText(/Reminder handed to the PhilSMS gateway/);
    expect(send).toHaveBeenCalledWith({invoiceId:'late',message:'Personal one-time reminder'});
    fireEvent.click(screen.getByRole('button',{name:'Done'}));
    fireEvent.click(screen.getAllByRole('button',{name:'Remind client'})[0]);
    expect((await screen.findByLabelText('SMS message') as HTMLTextAreaElement).value).not.toContain('Personal one-time reminder');
  });

});
