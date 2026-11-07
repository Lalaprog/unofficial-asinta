// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ReminderQueueStatus } from '@/components/reminders/ReminderQueueStatus';
const settings = {master_enabled:false,email_enabled:true,sms_enabled:true,revision:1};
const response = (body: unknown, ok = true) => ({ok,json:async()=>body});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
describe('honest automatic reminder status',()=>{
  it('uses the saved master switch rather than a server environment flag',async()=>{
    const fetcher = vi.fn().mockResolvedValue(response({settings,rolloutReady:false,automaticRemindersEnabled:true}));
    vi.stubGlobal('fetch',fetcher); render(React.createElement(ReminderQueueStatus));
    await screen.findByText('Automatic reminders: OFF');
    expect(fetcher.mock.calls[0][0]).toBe('/api/reminders/settings');
    expect(screen.queryByText(/reminders: ON/i)).toBeNull();
  });
  it('does not claim sending is on when the master, scheduler or response is unverified',async()=>{
    const fetcher = vi.fn().mockResolvedValueOnce(response({settings:{...settings,master_enabled:true},rolloutReady:true}))
      .mockResolvedValueOnce(response({settings,rolloutReady:false}));
    vi.stubGlobal('fetch',fetcher);render(React.createElement(ReminderQueueStatus));
    await screen.findByText('Automatic reminder status unavailable');
    fireEvent.click(screen.getByRole('button',{name:'Retry status'}));
    await screen.findByText('Automatic reminders: OFF');
  });
  it('rejects malformed settings and a later focus check cannot be overwritten by an older response',async()=>{
    let resolveOld!: (value: unknown)=>void;
    const fetcher = vi.fn().mockImplementationOnce(()=>new Promise(resolve=>{resolveOld=resolve;}))
      .mockResolvedValueOnce(response({settings,rolloutReady:false}));
    vi.stubGlobal('fetch',fetcher);render(React.createElement(ReminderQueueStatus));
    fireEvent(window,new Event('focus'));await screen.findByText('Automatic reminders: OFF');
    await act(async()=>resolveOld(response({settings:{...settings,master_enabled:true},rolloutReady:true})));
    expect(screen.getByText('Automatic reminders: OFF')).toBeTruthy();
    fireEvent(window,new Event('focus'));
    await screen.findByText('Automatic reminder status unavailable');
  });
});
