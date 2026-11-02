// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ createProject: vi.fn(), updateProject: vi.fn(), deleteProject: vi.fn(), showToast: vi.fn(), push: vi.fn() }));
const project = { id: 'project-1', name: 'Test Site', client_id: 'client-1', location: 'Batangas', budget_estimate: 0, status: 'active', start_date: '2027-01-01', target_completion_date: '2027-02-01' };
vi.mock('next/navigation', () => ({ useParams: () => ({ id: 'project-1' }), useRouter: () => ({ push: mocks.push }) }));
vi.mock('next/link', () => ({ default: ({ children, prefetch: _prefetch, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { prefetch?: boolean }) => React.createElement('a', props, children) }));
vi.mock('@/components/layout/AppShell', () => ({ AppShell: ({ children }: { children: React.ReactNode }) => React.createElement('main', null, children) }));
vi.mock('@/lib/auth/authContext', () => ({ useAuth: () => ({ isFounder: true, isSupervisor: false, user: { id: 'founder-1' } }) }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ showToast: mocks.showToast }) }));
vi.mock('@/lib/data/store', () => ({ useDataStore: () => ({
  projects: [project], clients: [{ id: 'client-1', name: 'Client', contact_person: 'Contact' }],
  invoices: [], expenses: [], tools: [], attendance: [], workers: [], users: [], projectSupervisors: [],
  createProject: mocks.createProject, updateProject: mocks.updateProject, deleteProject: mocks.deleteProject,
  getProjectsForSupervisor: () => [],
}) }));
import ProjectsPage from '@/app/projects/page';
import ProjectDetailPage from '@/app/projects/[id]/page';

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => cleanup());

describe('project creation and editing', () => {
  it('requires real fields and a valid date range before creating', () => {
    render(React.createElement(ProjectsPage));
    fireEvent.click(screen.getByRole('button', { name: 'New Project' }));
    const dialog = screen.getByRole('dialog', { name: 'Create New Project' });
    expect((within(dialog).getByLabelText('Target Completion Date') as HTMLInputElement).value).toBe('');
    fireEvent.change(within(dialog).getByLabelText('Project Name'), { target: { value: '  ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create Project' }));
    expect(within(dialog).getByText('Enter a project name.')).toBeTruthy();
    expect(within(dialog).getByText('Select a client.')).toBeTruthy();
    expect(within(dialog).getByText('Enter the site location.')).toBeTruthy();
    expect(mocks.createProject).not.toHaveBeenCalled();
  });

  it('blocks repeat creation while pending and submits normalized values', async () => {
    let finish!: (value: unknown) => void;
    mocks.createProject.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    render(React.createElement(ProjectsPage));
    fireEvent.click(screen.getByRole('button', { name: 'New Project' }));
    const dialog = screen.getByRole('dialog', { name: 'Create New Project' });
    fireEvent.change(within(dialog).getByLabelText('Project Name'), { target: { value: '  New Site  ' } });
    fireEvent.change(within(dialog).getByLabelText('Client'), { target: { value: 'client-1' } });
    fireEvent.change(within(dialog).getByLabelText('Site Location'), { target: { value: '  Lipa  ' } });
    fireEvent.change(within(dialog).getByLabelText('Budget Estimate (PHP ₱)'), { target: { value: '0' } });
    fireEvent.change(within(dialog).getByLabelText('Start Date'), { target: { value: '2027-01-01' } });
    fireEvent.change(within(dialog).getByLabelText('Target Completion Date'), { target: { value: '2027-06-01' } });
    const form = within(dialog).getByRole('button', { name: 'Create Project' }).closest('form')!;
    fireEvent.submit(form); fireEvent.submit(form);
    expect(mocks.createProject).toHaveBeenCalledTimes(1);
    expect(mocks.createProject).toHaveBeenCalledWith(expect.objectContaining({ name: 'New Site', location: 'Lipa', budget_estimate: 0 }));
    expect(within(dialog).getByRole('button', { name: /Creating project/ }).hasAttribute('disabled')).toBe(true);
    finish({ id: 'new' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('validates edits, preserves a zero budget, and locks while the update is pending', async () => {
    let finish!: (value: unknown) => void;
    mocks.updateProject.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    render(React.createElement(ProjectDetailPage));
    fireEvent.click(screen.getByRole('button', { name: 'Edit Project' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit Project Details' });
    expect((within(dialog).getByLabelText('Budget Estimate') as HTMLInputElement).value).toBe('0');
    fireEvent.change(within(dialog).getByLabelText('Target Completion Date'), { target: { value: '2026-12-01' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save Changes' }));
    expect(within(dialog).getByText(/cannot be before/)).toBeTruthy();
    expect(mocks.updateProject).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText('Target Completion Date'), { target: { value: '2027-02-01' } });
    const form = within(dialog).getByRole('button', { name: 'Save Changes' }).closest('form')!;
    fireEvent.submit(form); fireEvent.submit(form);
    expect(mocks.updateProject).toHaveBeenCalledTimes(1);
    expect(within(dialog).getByRole('button', { name: /Saving changes/ }).hasAttribute('disabled')).toBe(true);
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(document.activeElement).toBe(dialog);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: 'Edit Project Details' })).toBeTruthy();
    finish({ id: project.id });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('keeps an edit open when the store cannot confirm a save', async () => {
    mocks.updateProject.mockResolvedValueOnce(null);
    render(React.createElement(ProjectDetailPage));
    fireEvent.click(screen.getByRole('button', { name: 'Edit Project' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit Project Details' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(mocks.updateProject).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('dialog', { name: 'Edit Project Details' })).toBeTruthy();
  });

  it('locks deletion until its result and keeps the project on an unconfirmed removal', async () => {
    let finish!: (value: boolean) => void;
    mocks.deleteProject.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    render(React.createElement(ProjectDetailPage));
    fireEvent.click(screen.getByRole('button', { name: 'Delete Test Site' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Delete project' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete project' }));
    expect(within(dialog).getByRole('button', { name: /Deleting/ }).hasAttribute('disabled')).toBe(true);
    expect(mocks.deleteProject).toHaveBeenCalledTimes(1);
    finish(false);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(mocks.push).not.toHaveBeenCalled();
  });
});
