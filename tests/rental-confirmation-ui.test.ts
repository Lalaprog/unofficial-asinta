// @vitest-environment jsdom
import React from 'react';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const mock=vi.hoisted(()=>({rpc:vi.fn()}));
vi.mock('@/lib/supabase/client',()=>({createClient:()=>({rpc:mock.rpc})}));
import {RentalConfirmation} from '@/components/projects/RentalConfirmation';
import {rentalConfirmationPreviewEnabled} from '@/lib/finance/featureAvailability';
import {verifyRentalStatus} from '@/lib/projects/rentalConfirmation';
const site='00000000-0000-0000-0000-000000000003',expense='00000000-0000-0000-0000-000000000005';
const row={id:expense,project_id:site,description:'Excavator hire',category:'equipment',amount:1234.5,expense_date:'2026-10-14',notes:null};
const recorded=vi.fn();
function open(){render(React.createElement(RentalConfirmation,{projectId:site,userId:'founder',expenses:[row],onRecorded:recorded}));fireEvent.click(screen.getByRole('button',{name:'Review rental link'}));}
function fill(){fireEvent.change(screen.getByLabelText('Rental item'),{target:{value:'Excavator'}});fireEvent.change(screen.getByLabelText('Supplier'),{target:{value:'Supplier'}});fireEvent.change(screen.getByLabelText('Rental start'),{target:{value:'2026-10-10'}});fireEvent.change(screen.getByLabelText('Rental end'),{target:{value:'2026-10-14'}});}
beforeEach(()=>{mock.rpc.mockReset();recorded.mockReset();sessionStorage.clear();});afterEach(()=>{cleanup();vi.unstubAllEnvs();sessionStorage.clear();});
describe('experimental rental confirmation',()=>{
 it('needs all three independent flags',()=>{vi.stubEnv('NEXT_PUBLIC_FINANCE_FOUNDATION_PREVIEW','true');vi.stubEnv('NEXT_PUBLIC_CONFIRMED_RENTAL_PREVIEW','true');vi.stubEnv('NEXT_PUBLIC_RENTAL_CONFIRMATION_PREVIEW','false');expect(rentalConfirmationPreviewEnabled()).toBe(false);vi.stubEnv('NEXT_PUBLIC_RENTAL_CONFIRMATION_PREVIEW','true');expect(rentalConfirmationPreviewEnabled()).toBe(true);vi.stubEnv('NEXT_PUBLIC_CONFIRMED_RENTAL_PREVIEW','false');expect(rentalConfirmationPreviewEnabled()).toBe(false);});
 it('requires explicit review and sends existing expense snapshot, not payment',async()=>{
  mock.rpc.mockImplementation(async(_name:string,a:{p_id:string;p_expense:string})=>({data:{id:a.p_id,expense_id:a.p_expense,replayed:false},error:null}));open();fill();expect((screen.getByRole('button',{name:'Confirm rental link'}) as HTMLButtonElement).disabled).toBe(true);fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(screen.getByRole('button',{name:'Confirm rental link'}));
  await screen.findByText(/Rental link recorded/);expect(mock.rpc).toHaveBeenCalledTimes(1);expect(mock.rpc.mock.calls[0][0]).toBe('confirm_rental_expense');expect(mock.rpc.mock.calls[0][1]).toMatchObject({p_expense:expense,p_project:site,p_expected_amount:'1234.50',p_item:'Excavator',p_supplier:'Supplier',p_quantity:1});expect(recorded).toHaveBeenCalledTimes(1);expect(sessionStorage.length).toBe(0);
 });
 it('keeps the same request after an ambiguous result and missing status, including remount',async()=>{
  mock.rpc.mockRejectedValueOnce(new Error('network'));open();fill();fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(screen.getByRole('button',{name:'Confirm rental link'}));await screen.findByRole('alert');const saved=sessionStorage.getItem('rental-confirmation:founder');expect(saved).toBeTruthy();const attempt=JSON.parse(saved!);cleanup();
  mock.rpc.mockResolvedValueOnce({data:{found:false},error:null});render(React.createElement(RentalConfirmation,{projectId:site,userId:'founder',expenses:[row],onRecorded:recorded}));expect(screen.queryByRole('button',{name:'Review rental link'})).toBeNull();fireEvent.click(screen.getByRole('button',{name:'Check confirmation'}));await screen.findByText(/could still be processing/);expect(sessionStorage.getItem('rental-confirmation:founder')).toBe(saved);
  mock.rpc.mockResolvedValueOnce({data:{id:attempt.id,expense_id:expense,replayed:true},error:null});fireEvent.click(screen.getByRole('button',{name:'Retry same request'}));await screen.findByText(/Rental link recorded/);expect(mock.rpc.mock.calls[2][1].p_id).toBe(attempt.id);expect(sessionStorage.length).toBe(0);
 });
 it('clears a retry only after all status details match',async()=>{
  mock.rpc.mockRejectedValueOnce(new Error('network'));open();fill();fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(screen.getByRole('button',{name:'Confirm rental link'}));await screen.findByRole('alert');const attempt=JSON.parse(sessionStorage.getItem('rental-confirmation:founder')!);
  mock.rpc.mockResolvedValueOnce({data:{found:true,...attempt},error:null});fireEvent.click(screen.getByRole('button',{name:'Check confirmation'}));await screen.findByText(/Rental link recorded/);expect(sessionStorage.length).toBe(0);expect(recorded).toHaveBeenCalledTimes(1);
 });
 it('does not clear a mismatched status or malformed retry record',async()=>{
  mock.rpc.mockRejectedValueOnce(new Error('network'));open();fill();fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(screen.getByRole('button',{name:'Confirm rental link'}));await screen.findByRole('alert');const saved=sessionStorage.getItem('rental-confirmation:founder');const attempt=JSON.parse(saved!);
  mock.rpc.mockResolvedValueOnce({data:{found:true,...attempt,amount:'1.00'},error:null});fireEvent.click(screen.getByRole('button',{name:'Check confirmation'}));await screen.findByText(/Could not verify the exact confirmation/);expect(sessionStorage.getItem('rental-confirmation:founder')).toBe(saved);
  cleanup();sessionStorage.setItem('rental-confirmation:founder','broken');render(React.createElement(RentalConfirmation,{projectId:site,userId:'founder',expenses:[row],onRecorded:recorded}));expect(await screen.findByText(/Saved retry data is unreadable/)).toBeTruthy();expect(screen.queryByRole('button',{name:'Review rental link'})).toBeNull();
 });
 it('does not send if retry storage fails and ignores a late result after the retry record changes',async()=>{
  const save=vi.spyOn(Storage.prototype,'setItem').mockImplementationOnce(()=>{throw new Error('storage denied');});open();fill();fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(screen.getByRole('button',{name:'Confirm rental link'}));expect((await screen.findByRole('alert')).textContent).toContain('no request was sent');expect(mock.rpc).not.toHaveBeenCalled();save.mockRestore();cleanup();
  let resolve!:(v:unknown)=>void;mock.rpc.mockReturnValueOnce(new Promise(r=>{resolve=r;}));open();fill();fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(screen.getByRole('button',{name:'Confirm rental link'}));const attempt=JSON.parse(sessionStorage.getItem('rental-confirmation:founder')!);sessionStorage.setItem('rental-confirmation:founder',JSON.stringify({...attempt,id:'00000000-0000-0000-0000-000000000099'}));resolve({data:{id:attempt.id,expense_id:expense,replayed:false},error:null});expect((await screen.findByRole('alert')).textContent).toContain('may already be recorded');expect(JSON.parse(sessionStorage.getItem('rental-confirmation:founder')!).id).toBe('00000000-0000-0000-0000-000000000099');
 });
 it('does not overwrite a changed retry record or send the stale request',async()=>{
  mock.rpc.mockRejectedValueOnce(new Error('network'));open();fill();fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(screen.getByRole('button',{name:'Confirm rental link'}));await screen.findByRole('alert');
  const key='rental-confirmation:founder',attempt=JSON.parse(sessionStorage.getItem(key)!);const changed=JSON.stringify({...attempt,id:'00000000-0000-0000-0000-000000000099'});sessionStorage.setItem(key,changed);
  fireEvent.click(screen.getByRole('button',{name:'Retry same request'}));expect((await screen.findByRole('alert')).textContent).toContain('no request was sent');expect(mock.rpc).toHaveBeenCalledTimes(1);expect(sessionStorage.getItem(key)).toBe(changed);
  fireEvent.click(screen.getByRole('button',{name:'Review stopping retry'}));fireEvent.click(screen.getByRole('button',{name:'I checked; stop retrying'}));expect((await screen.findByRole('alert')).textContent).toContain('may have changed');expect(sessionStorage.getItem(key)).toBe(changed);
 });
 it('allows an explicitly reviewed stop only for the unchanged retry record',async()=>{
  mock.rpc.mockRejectedValueOnce(new Error('network'));open();fill();fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(screen.getByRole('button',{name:'Confirm rental link'}));await screen.findByRole('alert');fireEvent.click(screen.getByRole('button',{name:'Review stopping retry'}));fireEvent.click(screen.getByRole('button',{name:'I checked; stop retrying'}));await screen.findByText(/Retry stopped/);expect(sessionStorage.getItem('rental-confirmation:founder')).toBeNull();
 });
 it('does not overwrite a newly appeared request or send without verified storage',async()=>{
  open();fill();fireEvent.click(screen.getByRole('checkbox'));sessionStorage.setItem('rental-confirmation:founder','unexpected existing request');fireEvent.click(screen.getByRole('button',{name:'Confirm rental link'}));expect((await screen.findByRole('alert')).textContent).toContain('no request was sent');expect(mock.rpc).not.toHaveBeenCalled();expect(sessionStorage.getItem('rental-confirmation:founder')).toBe('unexpected existing request');
  cleanup();sessionStorage.clear();vi.spyOn(Storage.prototype,'setItem').mockImplementationOnce(()=>{});open();fill();fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(screen.getByRole('button',{name:'Confirm rental link'}));expect((await screen.findByRole('alert')).textContent).toContain('no request was sent');expect(mock.rpc).not.toHaveBeenCalled();vi.restoreAllMocks();
 });
 it('validates status details and prevents invalid input from sending',async()=>{
  open();fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(screen.getByRole('button',{name:'Confirm rental link'}));await screen.findByRole('alert');expect(mock.rpc).not.toHaveBeenCalled();
  expect(()=>verifyRentalStatus({found:true},{id:'x'} as never)).toThrow();await waitFor(()=>expect(screen.getByRole('dialog')).toBeTruthy());
 });
});
