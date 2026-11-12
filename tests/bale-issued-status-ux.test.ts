// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ createAdvance: vi.fn() }));
vi.mock('next/navigation',()=>({useRouter:()=>({replace:vi.fn()}),useSearchParams:()=>new URLSearchParams('tab=issued')}));
vi.mock('@/components/layout/AppShell',()=>({AppShell:({children}:{children:React.ReactNode})=>children}));
vi.mock('@/components/advances/AdvanceRequestsPanel',()=>({AdvanceRequestsPanel:()=>null}));
vi.mock('@/lib/auth/authContext',()=>({useAuth:()=>({isFounder:true,assurance:'ready',isLoading:false})}));
vi.mock('@/components/ui/Toast',()=>({useToast:()=>({showToast:vi.fn()})}));
vi.mock('@/lib/data/store',()=>({useDataStore:()=>({
  isLoaded:true,
  advances:[
    {id:'active',worker_id:'w1',project_id:'site',amount:1000,amount_deducted:100,status:'partially_deducted',reason:'Active item',date:'2026-01-01'},
    {id:'cancelled',worker_id:'w2',project_id:'site',amount:1000,amount_deducted:0,status:'cancelled',reason:'Cancelled item',date:'2026-01-01'},
  ],workers:[{id:'w1',name:'Ada',position:'Mason',active:true},{id:'w2',name:'Ben',position:'Mason',active:true}],projects:[{id:'site',name:'Site',location:'Batangas, PH'}],createAdvance:state.createAdvance,recordAdvanceDeduction:vi.fn(),
})}));
import AdvancesPage from '@/app/advances/page';
afterEach(()=>{cleanup();vi.useRealTimers();state.createAdvance.mockReset();});
describe('issued advance clarity',()=>{
  it('opens the existing record Bale form without issuing an advance',()=>{
    render(React.createElement(AdvancesPage));
    act(()=>{window.dispatchEvent(new CustomEvent('asinta:mobile-quick-action',{detail:'bale'}));});
    expect(screen.getByRole('dialog',{name:'Record Worker Advance (Bale)'})).toBeTruthy();
  });
  it('uses the current Manila date from the mobile quick action',()=>{
    vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-27T16:01:00Z'));
    render(React.createElement(AdvancesPage));
    act(()=>{window.dispatchEvent(new CustomEvent('asinta:mobile-quick-action',{detail:'bale'}));});
    expect((screen.getByLabelText('Disbursement Date') as HTMLInputElement).value).toBe('2026-10-28');
  });
  it('uses the Manila date when opening, refreshes an untouched default and preserves an edited draft',()=>{
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-27T15:59:00Z')); // Tuesday 23:59 in Manila
    render(React.createElement(AdvancesPage));
    vi.setSystemTime(new Date('2026-10-27T16:01:00Z')); // Wednesday 00:01 in Manila
    fireEvent.click(screen.getByRole('button',{name:'Record Bale'}));
    expect((screen.getByLabelText('Disbursement Date') as HTMLInputElement).value).toBe('2026-10-28');
    fireEvent.click(screen.getByRole('button',{name:'Cancel'}));
    vi.setSystemTime(new Date('2026-10-28T16:01:00Z'));
    fireEvent.click(screen.getByRole('button',{name:'Record Bale'}));
    expect((screen.getByLabelText('Disbursement Date') as HTMLInputElement).value).toBe('2026-10-29');
    fireEvent.change(screen.getByLabelText('Disbursement Date'),{target:{value:'2026-10-21'}});
    fireEvent.change(screen.getByLabelText('Reason / Purpose'),{target:{value:'Historical record'}});
    fireEvent.click(screen.getByRole('button',{name:'Cancel'}));
    vi.setSystemTime(new Date('2026-10-29T16:01:00Z'));
    fireEvent.click(screen.getByRole('button',{name:'Record Bale'}));
    expect((screen.getByLabelText('Disbursement Date') as HTMLInputElement).value).toBe('2026-10-21');
    expect((screen.getByLabelText('Reason / Purpose') as HTMLInputElement).value).toBe('Historical record');
  });
  it('resets an explicitly edited date after a confirmed synthetic save',async()=>{
    vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-27T16:01:00Z'));
    state.createAdvance.mockResolvedValue({id:'synthetic'});
    render(React.createElement(AdvancesPage));fireEvent.click(screen.getByRole('button',{name:'Record Bale'}));
    fireEvent.change(screen.getByLabelText('Worker Recipient'),{target:{value:'w1'}});
    fireEvent.change(screen.getByLabelText('Project Site'),{target:{value:'site'}});
    fireEvent.change(screen.getByLabelText('Advance Amount (PHP ₱)'),{target:{value:'50'}});
    fireEvent.change(screen.getByLabelText('Reason / Purpose'),{target:{value:'Historical'}});
    fireEvent.change(screen.getByLabelText('Disbursement Date'),{target:{value:'2026-10-21'}});
    await act(async()=>{fireEvent.submit(screen.getByRole('dialog',{name:'Record Worker Advance (Bale)'}).querySelector('form')!);});
    expect(state.createAdvance).toHaveBeenCalledWith(expect.objectContaining({date:'2026-10-21',amount:50}));
    vi.setSystemTime(new Date('2026-10-28T16:01:00Z'));
    fireEvent.click(screen.getByRole('button',{name:'Record Bale'}));
    expect((screen.getByLabelText('Disbursement Date') as HTMLInputElement).value).toBe('2026-10-29');
  });
  it('distinguishes cancelled amounts, limits deduction controls, and explains manual recording',()=>{
    render(React.createElement(AdvancesPage));
    expect(screen.getByText(/Summary reflects loaded advances/)).toBeTruthy();
    const cancelled=screen.getByText('Cancelled item').parentElement!.parentElement!;
    expect(within(cancelled).getByText('Cancelled')).toBeTruthy();
    expect(within(cancelled).getByText('Undeducted amount (cancelled)')).toBeTruthy();
    expect(within(cancelled).queryByRole('button',{name:'Record Deduction'})).toBeNull();
    const active=screen.getByText('Active item').parentElement!.parentElement!;
    expect(within(active).getByText('Partially deducted')).toBeTruthy();expect(within(active).getByRole('button',{name:'Record Deduction'})).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'Record Bale'}));
    expect(screen.getByText(/Record money already given to the worker/)).toBeTruthy();expect(screen.getByText(/this does not transfer money/)).toBeTruthy();
  });
});
