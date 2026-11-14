// @vitest-environment jsdom
import React from 'react';
import {cleanup,render,screen} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const mock=vi.hoisted(()=>({rpc:vi.fn()}));
vi.mock('@/lib/supabase/client',()=>({createClient:()=>({rpc:mock.rpc})}));
import {ConfirmedRentals} from '@/components/projects/ConfirmedRentals';
import {parseConfirmedRentals} from '@/lib/projects/confirmedRentals';
import {confirmedRentalPreviewEnabled} from '@/lib/finance/featureAvailability';
const row={id:'b',expense_id:'e',project_id:'site',expense_amount:'1234.50',expense_date:'2026-10-14',expense_description:'Excavator hire',item_name:'Excavator',supplier:'Supplier',quantity:1,rental_start:'2026-10-10',rental_end:'2026-10-14',confirmed_at:'2026-10-15T00:00:00Z'};
beforeEach(()=>mock.rpc.mockReset());afterEach(()=>{cleanup();vi.unstubAllEnvs();});
describe('read-only confirmed rentals',()=>{
 it('requires two default-off flags',()=>{vi.stubEnv('NEXT_PUBLIC_FINANCE_FOUNDATION_PREVIEW','true');vi.stubEnv('NEXT_PUBLIC_CONFIRMED_RENTAL_PREVIEW','false');expect(confirmedRentalPreviewEnabled()).toBe(false);vi.stubEnv('NEXT_PUBLIC_CONFIRMED_RENTAL_PREVIEW','true');expect(confirmedRentalPreviewEnabled()).toBe(true);vi.stubEnv('NEXT_PUBLIC_FINANCE_FOUNDATION_PREVIEW','false');expect(confirmedRentalPreviewEnabled()).toBe(false);});
 it('shows the linked expense once and does not claim payment',async()=>{mock.rpc.mockResolvedValue({data:{project_id:'site',items:[row]},error:null});render(React.createElement(ConfirmedRentals,{projectId:'site',userId:'founder'}));expect(await screen.findByText(/Excavator · 1 · Supplier/)).toBeTruthy();expect(screen.getByText(/not additional costs/)).toBeTruthy();expect(screen.getByText(/does not prove payment/)).toBeTruthy();expect(mock.rpc).toHaveBeenCalledWith('project_confirmed_rentals',{p_project:'site'});});
 it('fails closed on wrong-site data and stale user/project responses',async()=>{
  let resolve!:(value:unknown)=>void;mock.rpc.mockReturnValueOnce(new Promise(r=>{resolve=r;})).mockResolvedValueOnce({data:{project_id:'other',items:[row]},error:null});
  const view=render(React.createElement(ConfirmedRentals,{projectId:'site',userId:'one'}));view.rerender(React.createElement(ConfirmedRentals,{projectId:'other',userId:'two'}));resolve({data:{project_id:'site',items:[row]},error:null});expect((await screen.findByRole('alert')).textContent).toContain('Could not verify');expect(screen.queryByText(/Excavator ·/)).toBeNull();
 });
 it('rejects duplicate expense links, incorrect order and invalid amounts',()=>{
  expect(parseConfirmedRentals({project_id:'site',items:[row]},'site')).toHaveLength(1);
  expect(()=>parseConfirmedRentals({project_id:'site',items:[row,{...row,id:'a'}]},'site')).toThrow();
  expect(()=>parseConfirmedRentals({project_id:'site',items:[row,{...row,id:'z',expense_id:'f'}]},'site')).toThrow();
  expect(()=>parseConfirmedRentals({project_id:'site',items:[{...row,expense_amount:'NaN'}]},'site')).toThrow();
 });
});
