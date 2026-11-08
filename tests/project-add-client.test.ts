// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(), createProject: vi.fn(), showToast: vi.fn(), founder: true,
  clients: [] as Array<{id: string; name: string; contact_person: string}>,
}));
vi.mock('next/link', () => ({ default: ({ children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => React.createElement('a', props, children) }));
vi.mock('@/components/layout/AppShell', () => ({ AppShell: ({ children }: { children: React.ReactNode }) => React.createElement('main', null, children) }));
vi.mock('@/lib/auth/authContext', () => ({ useAuth: () => ({ isFounder: mocks.founder, isSupervisor: !mocks.founder, user: { id: 'user-1' } }) }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ showToast: mocks.showToast }) }));
vi.mock('@/lib/data/store', () => ({ useDataStore: () => ({
  projects: [], clients: mocks.clients, invoices: [], expenses: [], createClient: mocks.createClient,
  createProject: mocks.createProject, getProjectsForSupervisor: () => [],
}) }));
import ProjectsPage from '@/app/projects/page';

beforeEach(() => { vi.clearAllMocks(); mocks.clients = []; mocks.founder = true; });
afterEach(() => cleanup());
function openProject() {
  fireEvent.click(screen.getByRole('button', { name: 'New Project' }));
  return screen.getByRole('dialog', { name: 'Create New Project' });
}
function openClient(project: HTMLElement) {
  fireEvent.click(within(project).getByRole('button', { name: 'Add New Client' }));
  return screen.getByRole('dialog', { name: 'Add New Client' });
}
function fillClient(dialog: HTMLElement) {
  for (const [label, value] of [
    ['Client / Company Name', '  New Client  '], ['Contact Person / Representative', '  Sam  '],
    ['Contact Number', '  09171234567  '], ['Email Address', '  sam@example.com  '],
    ['Billing / Residence Address', '  Lipa  '],
  ]) fireEvent.change(within(dialog).getByLabelText(label), { target: { value } });
}

describe('add client while creating a project', () => {
  it.each([375, 1440])('saves and selects the new client without losing the project at %i px', async (width) => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    mocks.createClient.mockImplementation(async (payload) => {
      const client = { id: 'new-client', ...payload, created_at: '2026-01-01' };
      mocks.clients = [...mocks.clients, client];
      return client;
    });
    mocks.createProject.mockResolvedValue({ id: 'new-project' });
    render(React.createElement(ProjectsPage));
    const project = openProject();
    fireEvent.change(within(project).getByLabelText('Project Name'), { target: { value: 'My Site' } });
    fireEvent.change(within(project).getByLabelText('Site Location'), { target: { value: 'Batangas' } });
    fireEvent.change(within(project).getByLabelText('Budget Estimate (PHP ₱)'), { target: { value: '1200' } });
    fireEvent.change(within(project).getByLabelText('Start Date'), { target: { value: '2027-01-01' } });
    fireEvent.change(within(project).getByLabelText('Target Completion Date'), { target: { value: '2027-02-01' } });
    const client = openClient(project);
    expect(client.textContent).toContain('saved to the directory immediately');
    expect(project.getAttribute('aria-hidden')).toBe('true');
    fillClient(client);
    fireEvent.submit(within(client).getByRole('button', { name: 'Save and Select Client' }).closest('form')!);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add New Client' })).toBeNull());
    expect(mocks.createClient).toHaveBeenCalledWith({ name: 'New Client', contact_person: 'Sam', phone: '09171234567', email: 'sam@example.com', address: 'Lipa' });
    expect(mocks.createProject).not.toHaveBeenCalled();
    expect((within(project).getByLabelText('Client') as HTMLSelectElement).value).toBe('new-client');
    expect((within(project).getByLabelText('Project Name') as HTMLInputElement).value).toBe('My Site');
    expect((within(project).getByLabelText('Site Location') as HTMLInputElement).value).toBe('Batangas');
    expect((within(project).getByLabelText('Budget Estimate (PHP ₱)') as HTMLInputElement).value).toBe('1200');
    fireEvent.click(within(project).getByRole('button', { name: 'Create Project' }));
    await waitFor(() => expect(mocks.createProject).toHaveBeenCalledWith(expect.objectContaining({ name: 'My Site', client_id: 'new-client', location: 'Batangas' })));
  });
  it('cancels the client form without creating a client or losing the project', () => {
    render(React.createElement(ProjectsPage));
    const project = openProject();
    fireEvent.change(within(project).getByLabelText('Project Name'), { target: { value: 'Unfinished' } });
    const client = openClient(project);
    fillClient(client);
    fireEvent.click(within(client).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Add New Client' })).toBeNull();
    expect((within(project).getByLabelText('Project Name') as HTMLInputElement).value).toBe('Unfinished');
    expect(mocks.createClient).not.toHaveBeenCalled();
  });
  it('blocks duplicate submissions and dismissals while saving', async () => {
    let finish!: (value: unknown) => void;
    mocks.createClient.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    render(React.createElement(ProjectsPage));
    const client = openClient(openProject());
    fillClient(client);
    const form = within(client).getByRole('button', { name: 'Save and Select Client' }).closest('form')!;
    fireEvent.submit(form); fireEvent.submit(form);
    expect(mocks.createClient).toHaveBeenCalledTimes(1);
    expect(within(client).getByRole('button', { name: 'Saving client…' }).hasAttribute('disabled')).toBe(true);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: 'Add New Client' })).toBeTruthy();
    finish(null);
    expect(await within(client).findByRole('alert')).toBeTruthy();
    expect(within(client).getByRole('button', { name: 'Save and Select Client' }).hasAttribute('disabled')).toBe(true);
    expect(client.textContent).toContain('check the client directory before trying again');
    fireEvent.click(within(client).getByRole('button', { name: 'Back to Project' }));
    expect(screen.getByRole('dialog', { name: 'Create New Project' })).toBeTruthy();
  });
  it('rejects whitespace fields even if native validation is bypassed', () => {
    render(React.createElement(ProjectsPage));
    const client = openClient(openProject());
    fillClient(client);
    fireEvent.change(within(client).getByLabelText('Client / Company Name'), { target: { value: '   ' } });
    fireEvent.submit(within(client).getByRole('button', { name: 'Save and Select Client' }).closest('form')!);
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.showToast).toHaveBeenCalledWith('error', expect.stringContaining('actual contact details'));
  });
  it('does not offer project or client creation to a Supervisor', () => {
    mocks.founder = false;
    render(React.createElement(ProjectsPage));
    expect(screen.queryByRole('button', { name: 'New Project' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add New Client' })).toBeNull();
  });
});
