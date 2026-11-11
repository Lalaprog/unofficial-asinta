// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ founder: false, rpc: vi.fn() }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ rpc: mocks.rpc }) }));
vi.mock('next/navigation', () => ({ useParams: () => ({ id: 'site-1' }), useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next/link', () => ({ default: ({ children, href, prefetch: _prefetch, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { prefetch?: boolean }) => React.createElement('a', { ...props, href }, children) }));
vi.mock('@/components/layout/AppShell', () => ({ AppShell: ({ children }: { children: React.ReactNode }) => React.createElement('main', null, children) }));
vi.mock('@/lib/auth/authContext', () => ({ useAuth: () => ({ isFounder: mocks.founder, isSupervisor: !mocks.founder, user: { id: 'supervisor' } }) }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('@/lib/data/store', () => {
  const projects = [
    { id: 'site-1', name: 'Sample Site', client_id: 'client-1', location: 'Batangas', budget_estimate: 90000, status: 'active', start_date: '2026-01-01', target_completion_date: '2027-01-01' },
    { id: 'site-2', name: 'Other Site', client_id: 'client-1', location: 'Lipa', budget_estimate: 1000, status: 'active', start_date: '2026-01-01', target_completion_date: '2027-01-01' },
  ];
  const workers = Array.from({length: 26}, (_, i) => ({ id: `worker-${i}`, name: `Worker ${String(i).padStart(2, '0')}`, position: i === 25 ? 'Carpenter' : 'Mason', active: true }));
  const attendance = [
    ...Array.from({length: 26}, (_, i) => ({ id: `new-${i}`, worker_id: `worker-${i}`, project_id: 'site-1', date: '2026-10-12', status: i === 0 ? 'leave' : 'present', hours_worked: i === 0 ? 0 : 8, notes: i === 25 ? 'Paint repair' : '', recorded_by: 'supervisor' })),
    ...Array.from({length: 11}, (_, i) => ({ id: `old-${i}`, worker_id: 'worker-0', project_id: 'site-1', date: `2026-10-${String(i + 1).padStart(2, '0')}`, status: 'half_day', hours_worked: 4, notes: '', recorded_by: 'supervisor' })),
    { id: 'other', worker_id: 'worker-0', project_id: 'site-2', date: '2026-12-31', status: 'absent', hours_worked: 0, notes: '', recorded_by: 'supervisor' },
  ];
  const store = { projects, clients: [{ id: 'client-1', name: 'Private Person', contact_person: 'Private Contact', phone: '09170000000', email: 'secret@example.com' }], invoices: [], expenses: [], tools: [{ id: 'tool-1', project_id: 'site-1', name: 'Site Drill', quantity: 2, condition: 'good' }, { id: 'tool-2', project_id: 'site-2', name: 'Other Drill', quantity: 1, condition: 'good' }], attendance, workers, users: [{ id: 'supervisor', name: 'Site Supervisor', email: 'supervisor@example.com', role: 'supervisor' }], projectSupervisors: [{ id: 'assignment', project_id: 'site-1', supervisor_id: 'supervisor' }], updateProject: vi.fn(), deleteProject: vi.fn(), createProject: vi.fn(), getProjectsForSupervisor: () => [projects[0]] };
  return { useDataStore: () => store };
});
import ProjectDetailPage from '@/app/projects/[id]/page';
import ProjectsPage from '@/app/projects/page';

beforeEach(() => { mocks.founder = false; mocks.rpc.mockResolvedValue({ data: [], error: null }); });
afterEach(() => cleanup());

describe('project roles and workforce logs', () => {
  it('hides client details from Supervisor project list and detail while keeping site tools and logs', () => {
    render(React.createElement(ProjectsPage));
    expect(screen.getByText('Sample Site')).toBeTruthy();
    expect(screen.queryByText('Private Person')).toBeNull();
    expect(screen.queryByText('Private Client')).toBeNull();
    expect(screen.queryByText('Other Site')).toBeNull();
    cleanup();
    render(React.createElement(ProjectDetailPage));
    expect(screen.getByRole('heading', { name: 'Sample Site' })).toBeTruthy();
    expect(screen.getByText('Batangas')).toBeTruthy();
    expect(screen.queryByText(/Client/)).toBeNull();
    expect(screen.queryByText('Private Person')).toBeNull();
    expect(screen.queryByText('Private Contact')).toBeNull();
    expect(screen.queryByText('secret@example.com')).toBeNull();
    expect(screen.queryByRole('button', { name: /Invoices/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Site Tools/ }));
    expect(screen.getByText('Site Drill')).toBeTruthy();
    expect(screen.queryByText('Other Drill')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Workforce Logs/ }));
    expect(screen.getByRole('heading', { name: 'Site Attendance Logs' })).toBeTruthy();
    expect(screen.queryByText('December 31, 2026')).toBeNull();
  });

  it('keeps Founder client information and financial tools', () => {
    mocks.founder = true;
    render(React.createElement(ProjectDetailPage));
    expect(screen.getByText('Site & Client Specifications')).toBeTruthy();
    expect(screen.getByText('Private Contact')).toBeTruthy();
    expect(screen.getByText('secret@example.com')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Invoices/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Edit Project' })).toBeTruthy();
  });

});
