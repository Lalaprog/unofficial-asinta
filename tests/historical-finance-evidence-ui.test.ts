// @vitest-environment jsdom
import React from 'react';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const mock=vi.hoisted(()=>({rpc:vi.fn(),user:'founder',founder:true,assurance:'ready'}));
vi.mock('@/lib/auth/authContext',()=>({useAuth:()=>({user:{id:mock.user},isFounder:mock.founder,assurance:mock.assurance})}));
vi.mock('@/lib/supabase/client',()=>({createClient:()=>({rpc:mock.rpc})}));
import {HistoricalFinanceEvidence} from '@/components/payroll/HistoricalFinanceEvidence';
import {historicalFinanceEvidencePreviewEnabled} from '@/lib/finance/featureAvailability';
import {parseHistoricalEvidence} from '@/lib/payroll/historicalEvidence';
const id=(n:number)=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const voucher={id:id(1),worker_id:id(2),worker_name:'Worker',period_start:'2024-10-20',period_end:'2024-10-26',gross_pay:'1000.00',bale_deduction:'200.00',other_deductions:'0.00',net_pay:'800.00',overlapping_paid:false,period_bale_total:'0.00',period_bale_count:0,unlinked_period_bale_count:0};
const date={request_id:id(3),payment_date:'2024-10-26',note:'Payroll ledger',recorded_by:id(4),recorded_at:'2026-10-01T00:00:00Z',matches_voucher:true};
const bale={request_id:id(5),payment_date:'2024-10-26',note:'Release ledger',recorded_by:id(4),recorded_at:'2026-10-01T00:00:00Z',matches_voucher:true,project_id:id(6),release_date:'2024-10-23',amount:'200.00',payment_date_source:'historical_annotation',context_changed:false};
const response={payroll_id:voucher.id,worker_id:voucher.worker_id,period_start:voucher.period_start,period_end:voucher.period_end,payment_conflict:false,recorded_payment_date:null,date_evidence:date,bale_evidence:bale};
const deferred=()=>{let resolve!:(value:unknown)=>void;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
beforeEach(()=>{mock.rpc.mockReset();mock.user='founder';mock.founder=true;mock.assurance='ready';});afterEach(()=>{cleanup();vi.unstubAllEnvs();});
describe('historical payment and Bale evidence review',()=>{
 it('requires both default-off gates',()=>{vi.stubEnv('NEXT_PUBLIC_FINANCE_FOUNDATION_PREVIEW','true');vi.stubEnv('NEXT_PUBLIC_HISTORICAL_FINANCE_EVIDENCE_PREVIEW','false');expect(historicalFinanceEvidencePreviewEnabled()).toBe(false);vi.stubEnv('NEXT_PUBLIC_HISTORICAL_FINANCE_EVIDENCE_PREVIEW','true');expect(historicalFinanceEvidencePreviewEnabled()).toBe(true);vi.stubEnv('NEXT_PUBLIC_FINANCE_FOUNDATION_PREVIEW','false');expect(historicalFinanceEvidencePreviewEnabled()).toBe(false);});
 it('loads only on demand and shows evidence separately without implying payment or another deduction',async()=>{
  mock.rpc.mockResolvedValue({data:response,error:null});render(React.createElement(HistoricalFinanceEvidence,{voucher}));expect(mock.rpc).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'Historical payment and Bale evidence'}));fireEvent.click(screen.getByRole('button',{name:'Load historical evidence'}));await screen.findByText(/Historical settled Bale assertion: ₱200.00/);
  expect(mock.rpc).toHaveBeenCalledWith('historical_finance_evidence_review',{p_payroll:voucher.id});expect(screen.getByText(/not proof of release, payment/)).toBeTruthy();expect(screen.getByText(/Evidence note: Release ledger/)).toBeTruthy();expect(screen.queryByRole('button',{name:/^(record payment|deduct bale|release bale)$/i})).toBeNull();
 });
 it('shows conflicts and changed evidence and never treats empty results as proof',async()=>{
  mock.rpc.mockResolvedValueOnce({data:{...response,payment_conflict:true,recorded_payment_date:'2024-10-25',bale_evidence:{...bale,context_changed:true},date_evidence:{...date,matches_voucher:false}},error:null}).mockResolvedValueOnce({data:{...response,date_evidence:null,bale_evidence:null},error:null});
  render(React.createElement(HistoricalFinanceEvidence,{voucher}));fireEvent.click(screen.getByRole('button',{name:'Historical payment and Bale evidence'}));fireEvent.click(screen.getByRole('button',{name:'Load historical evidence'}));await screen.findByText(/Conflicting payment-date sources/);expect(screen.getByText(/voucher differs/)).toBeTruthy();expect(screen.getByText(/related records changed/)).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:'Refresh historical evidence'}));await screen.findByText(/does not prove no Bale was released/);expect(screen.getByText(/does not prove no payment occurred/)).toBeTruthy();
 });
 it('fails closed on mismatched data and ignores stale responses after user change',async()=>{
  const old=deferred();mock.rpc.mockReturnValueOnce(old.promise).mockResolvedValueOnce({data:{...response,payroll_id:id(99)},error:null});const view=render(React.createElement(HistoricalFinanceEvidence,{voucher}));fireEvent.click(screen.getByRole('button',{name:'Historical payment and Bale evidence'}));fireEvent.click(screen.getByRole('button',{name:'Load historical evidence'}));mock.user='another';view.rerender(React.createElement(HistoricalFinanceEvidence,{voucher}));fireEvent.click(screen.getByRole('button',{name:'Historical payment and Bale evidence'}));fireEvent.click(screen.getByRole('button',{name:'Load historical evidence'}));await screen.findByRole('alert');await act(async()=>old.resolve({data:response,error:null}));expect(screen.queryByText(/Historical settled Bale assertion/)).toBeNull();
 });
 it('clears pending results on lost assurance and displays missing RPC as an error',async()=>{
  const old=deferred();mock.rpc.mockReturnValueOnce(old.promise).mockResolvedValueOnce({data:null,error:{message:'RPC not found'}});const view=render(React.createElement(HistoricalFinanceEvidence,{voucher}));fireEvent.click(screen.getByRole('button',{name:'Historical payment and Bale evidence'}));fireEvent.click(screen.getByRole('button',{name:'Load historical evidence'}));mock.assurance='required';view.rerender(React.createElement(HistoricalFinanceEvidence,{voucher}));await act(async()=>old.resolve({data:response,error:null}));expect(screen.queryByText(/Historical settled Bale assertion/)).toBeNull();mock.assurance='ready';view.rerender(React.createElement(HistoricalFinanceEvidence,{voucher}));fireEvent.click(screen.getByRole('button',{name:'Historical payment and Bale evidence'}));fireEvent.click(screen.getByRole('button',{name:'Load historical evidence'}));expect((await screen.findByRole('alert')).textContent).toContain('RPC not found');expect(screen.queryByText(/No historical settled Bale evidence/)).toBeNull();
 });
 it('rejects malformed, incomplete or inconsistent responses',()=>{
  for(const raw of [{...response,worker_id:id(99)},{...response,payment_conflict:true},{...response,bale_evidence:{...bale,amount:'NaN'}},{...response,bale_evidence:{...bale,release_date:'2024-10-29'}},{...response,date_evidence:{...date,recorded_at:'invalid'}},{...response,date_evidence:undefined}])expect(()=>parseHistoricalEvidence(raw,voucher)).toThrow();
 });
});
