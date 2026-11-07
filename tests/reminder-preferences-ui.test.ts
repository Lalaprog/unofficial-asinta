// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ReminderPreferences } from '@/components/reminders/ReminderPreferences';

const initial = { master_enabled:false, email_enabled:false, sms_enabled:false, revision:1 };
const response = (settings: unknown, status = 200, rolloutReady = false) => ({ ok: status < 400, status, json: async () => ({settings, rolloutReady}) });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('reminder preferences', () => {
  it('saves independent choices without ever enabling the master', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response(initial)).mockResolvedValueOnce(response({...initial, email_enabled:true, revision:2}));
    vi.stubGlobal('fetch', fetcher);
    render(React.createElement(ReminderPreferences));
    const master = await screen.findByLabelText('Automatic reminders') as HTMLInputElement;
    expect(master.disabled).toBe(true); expect(master.checked).toBe(false);
    fireEvent.click(screen.getByLabelText('Email'));
    fireEvent.click(screen.getByRole('button', {name:'Save preferences'}));
    await screen.findByText(/Preferences saved/);
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({...initial, email_enabled:true});
    expect(master.checked).toBe(false);
  });
  it('requires a fresh read if a save is unconfirmed', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response(initial)).mockRejectedValueOnce(Error('lost response')).mockResolvedValueOnce(response({...initial,sms_enabled:true,revision:2}));
    vi.stubGlobal('fetch', fetcher); render(React.createElement(ReminderPreferences));
    fireEvent.click(await screen.findByLabelText('SMS'));
    fireEvent.click(screen.getByRole('button', {name:'Save preferences'}));
    await screen.findByText(/Save was not confirmed/);
    expect(screen.queryByRole('button',{name:'Save preferences'})).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'Refresh preferences'}));
    await waitFor(() => expect((screen.getByLabelText('SMS') as HTMLInputElement).checked).toBe(true));
  });
  it('fails closed if readiness or settings are unexpected', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({...initial,master_enabled:true},200,true)));
    render(React.createElement(ReminderPreferences));
    await screen.findByText(/Could not load reminder preferences/);
    expect(screen.queryByLabelText('Email')).toBeNull();
    expect((screen.getByLabelText('Automatic reminders') as HTMLInputElement).disabled).toBe(true);
  });
});
