// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('next/navigation',()=>({useRouter:()=>({replace:vi.fn()}),useSearchParams:()=>new URLSearchParams('tab=issued')}));
vi.mock('@/components/layout/AppShell',()=>({AppShell:({children}:{children:React.ReactNode})=>children}));
vi.mock('@/components/advances/AdvanceRequestsPanel',()=>({AdvanceRequestsPanel:()=>null}));
vi.mock('@/lib/auth/authContext',()=>({useAuth:()=>({isFounder:true})}));
vi.mock('@/components/ui/Toast',()=>({useToast:()=>({showToast:vi.fn()})}));
vi.mock('@/lib/data/store',()=>({useDataStore:()=>({
  advances:[
    {id:'active',worker_id:'w1',project_id:'site',amount:1000,amount_deducted:100,status:'partially_deducted',reason:'Active item',date:'2026-01-01'},
    {id:'cancelled',worker_id:'w2',project_id:'site',amount:1000,amount_deducted:0,status:'cancelled',reason:'Cancelled item',date:'2026-01-01'},
  ],workers:[{id:'w1',name:'Ada',position:'Mason',active:true},{id:'w2',name:'Ben',position:'Mason',active:true}],projects:[{id:'site',name:'Site',location:'Batangas, PH'}],createAdvance:vi.fn(),recordAdvanceDeduction:vi.fn(),
})}));
import AdvancesPage from '@/app/advances/page';
afterEach(()=>cleanup());
describe('issued advance clarity',()=>{
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
