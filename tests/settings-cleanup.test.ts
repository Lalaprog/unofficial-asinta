// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  auth: { user: { id: 'user-1', name: 'Alex', email: 'alex@example.test' }, isFounder: true, isSupervisor: false },
  refresh: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/auth/authContext', () => ({ useAuth: () => mocks.auth }));
vi.mock('@/lib/data/store', () => ({ useDataStore: () => ({ refresh: mocks.refresh, isLoading: false, isLoaded: true, loadError: null, workers: [], getProjectsForSupervisor: () => [] }) }));
vi.mock('@/components/layout/AppShell', () => ({ AppShell: ({ children }: { children: React.ReactNode }) => React.createElement('main', null, children) }));
vi.mock('@/components/auth/MfaCard', () => ({ MfaCard: () => React.createElement('div', null, 'Two-factor settings') }));
vi.mock('@/components/email/TemplateEditorCard', () => ({ TemplateEditorCard: () => null }));
vi.mock('@/components/email/SmsTemplateCard', () => ({ SmsTemplateCard: () => null }));
vi.mock('@/components/email/TestEmailCard', () => ({ TestEmailCard: () => null }));
vi.mock('@/components/reminders/ReminderPreferences', () => ({ ReminderPreferences: () => null }));
import SettingsPage from '@/app/settings/page';

beforeEach(() => {
  mocks.auth.isFounder = true; mocks.auth.isSupervisor = false; mocks.refresh.mockClear();
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://sensitive-project.example.test');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({
    groqConfigured: true, groqModel: 'internal-text-model', groqVisionModel: 'internal-vision-model',
    philsmsConfigured: true, philsmsSenderId: 'ASINTA', smtpConfigured: true,
    mfaEnforcedForFounders: true, sessionPolicy: { idleMinutes: 15, absoluteHours: 12, warningSeconds: 60 },
  }) }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('settings presentation', () => {
  it.each([375, 1440])('hides model and project details while retaining controls at %i px', async (width) => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    render(React.createElement(SettingsPage));
    await screen.findByText('AI expense assistance');
    await screen.findByText('Founder two-factor enforcement:');
    await waitFor(() => expect(screen.getByText('enabled')).toBeTruthy());
    expect(document.body.textContent).not.toMatch(/Groq|internal-text-model|internal-vision-model|sensitive-project\.example|Supabase Project|Endpoint:/i);
    expect(screen.getByText('Loaded (may include cached data)')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Now' }));
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce());
    expect(screen.getByRole('button', { name: 'Send Test SMS' })).toBeTruthy();
    expect(fetch).toHaveBeenCalledTimes(1); // Rendering/refreshing never sends a message.
  });
  it('keeps the Supervisor profile and refresh without Founder integrations', async () => {
    mocks.auth.isFounder = false; mocks.auth.isSupervisor = true;
    render(React.createElement(SettingsPage));
    expect(screen.getByText('Supervisor Field Profile')).toBeTruthy();
    expect(screen.queryByText('AI expense assistance')).toBeNull();
    expect(screen.getByRole('button', { name: 'Refresh Now' })).toBeTruthy();
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  });
  it('reports an unknown status and allows a retry when the status check fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    render(React.createElement(SettingsPage));
    expect((await screen.findByRole('alert')).textContent).toContain('unknown');
    expect(screen.getByText('Idle limit unknown')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry status check' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  });
});
