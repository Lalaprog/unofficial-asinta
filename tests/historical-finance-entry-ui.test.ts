// @vitest-environment jsdom
import React from 'react';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const mock=vi.hoisted(()=>({rpc:vi.fn(),projects:[] as {id:string;name:string}[],isLoaded:true,loadError:null as string|null}));
vi.mock('@/lib/supabase/client',()=>({createClient:()=>({rpc:mock.rpc})}));
vi.mock('@/lib/data/store',()=>({useDataStore:()=>({projects:mock.projects,isLoaded:mock.isLoaded,loadError:mock.loadError})}));
vi.mock('@/lib/reminders/scheduler',()=>({getManilaClock:()=>({dateIso:'2026-10-15'})}));
import {HistoricalFinanceEntry} from '@/components/payroll/HistoricalFinanceEntry';
import {historicalFinanceEntryPreviewEnabled} from '@/lib/finance/featureAvailability';
import {parseHistoricalAttempt,parseHistoricalSnapshot,snapshotMatchesVoucher} from '@/lib/payroll/historicalEntry';
const id=(n:number)=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const voucher={id:id(1),worker_id:id(2),worker_name:'Worker',period_start:'2024-10-20',period_end:'2024-10-26',gross_pay:'1000.00',bale_deduction:'200.00',other_deductions:'0.00',net_pay:'800.00',overlapping_paid:false,period_bale_total:'0.00',period_bale_count:0,unlinked_period_bale_count:0};
const snap={id:voucher.id,worker_id:voucher.worker_id,period_start:voucher.period_start,period_end:voucher.period_end,status:'paid' as const,gross_pay:'1000',bale_deduction:'200',other_deductions:'0',net_pay:'800'};
const evidence={payroll_id:voucher.id,worker_id:voucher.worker_id,period_start:voucher.period_start,period_end:voucher.period_end,voucher_snapshot:snap,payment_conflict:false,recorded_payment_date:null,date_evidence:null,bale_evidence:null};
const dateEvidence={request_id:id(3),payment_date:'2024-10-26',note:'Payroll ledger',recorded_by:id(4),recorded_at:'2026-10-01T00:00:00Z',matches_voucher:true};
const props={userId:id(4),voucher,evidence,onRecorded:vi.fn()};
const deferred=()=>{let resolve!:(v:unknown)=>void;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function dateForm(){fireEvent.click(screen.getByRole('button',{name:'Review historical payment-date assertion'}));fireEvent.change(screen.getByLabelText('Actual external payment date'),{target:{value:'2024-10-26'}});fireEvent.change(screen.getByLabelText('Source evidence note'),{target:{value:'  Payroll ledger  '}});}
beforeEach(()=>{sessionStorage.clear();mock.rpc.mockReset();mock.projects=[{id:id(5),name:'Old site'}];mock.isLoaded=true;mock.loadError=null;props.onRecorded.mockReset();vi.spyOn(crypto,'randomUUID').mockReturnValue(id(6));});afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllEnvs();});
describe('experimental historical assertion entry',()=>{
 it('requires the finance, reader and independent entry switches',()=>{vi.stubEnv('NEXT_PUBLIC_FINANCE_FOUNDATION_PREVIEW','true');vi.stubEnv('NEXT_PUBLIC_HISTORICAL_FINANCE_EVIDENCE_PREVIEW','true');vi.stubEnv('NEXT_PUBLIC_HISTORICAL_FINANCE_ENTRY_PREVIEW','false');expect(historicalFinanceEntryPreviewEnabled()).toBe(false);vi.stubEnv('NEXT_PUBLIC_HISTORICAL_FINANCE_ENTRY_PREVIEW','true');expect(historicalFinanceEntryPreviewEnabled()).toBe(true);vi.stubEnv('NEXT_PUBLIC_HISTORICAL_FINANCE_EVIDENCE_PREVIEW','false');expect(historicalFinanceEntryPreviewEnabled()).toBe(false);vi.stubEnv('NEXT_PUBLIC_HISTORICAL_FINANCE_EVIDENCE_PREVIEW','true');vi.stubEnv('NEXT_PUBLIC_FINANCE_FOUNDATION_PREVIEW','false');expect(historicalFinanceEntryPreviewEnabled()).toBe(false);});
 it('records only an explicitly verified historical date, with the exact reviewed snapshot',async()=>{
  mock.rpc.mockResolvedValue({data:{request_id:id(6),payroll_id:voucher.id,replayed:false,payment_date:'2024-10-26'},error:null});render(React.createElement(HistoricalFinanceEntry,props));dateForm();expect((screen.getByRole('button',{name:'Save historical assertion'}) as HTMLButtonElement).disabled).toBe(true);fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(screen.getByRole('button',{name:'Save historical assertion'}));
  await screen.findByText(/Evidence assertion saved/);expect(mock.rpc).toHaveBeenCalledWith('annotate_historical_paid_date',{p_request:id(6),p_payroll:voucher.id,p_expected:snap,p_date:'2024-10-26',p_note:'Payroll ledger'});expect(props.onRecorded).toHaveBeenCalledOnce();expect(sessionStorage.length).toBe(0);expect(screen.getByText(/No payment, Bale deduction or transfer/)).toBeTruthy();
 });
 it('records one fully deducted past Bale as evidence, with a selected project and no payment action',async()=>{
  mock.rpc.mockResolvedValue({data:{request_id:id(6),payroll_id:voucher.id,replayed:false},error:null});render(React.createElement(HistoricalFinanceEntry,{...props,evidence:{...evidence,date_evidence:dateEvidence}}));fireEvent.click(screen.getByRole('button',{name:'Review settled Bale assertion'}));fireEvent.change(screen.getByLabelText('Project for historical Bale'),{target:{value:id(5)}});fireEvent.change(screen.getByLabelText('Actual external Bale release date'),{target:{value:'2024-10-23'}});fireEvent.change(screen.getByLabelText('Source evidence note'),{target:{value:'Release ledger'}});fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(screen.getByRole('button',{name:'Save historical assertion'}));
  await screen.findByText(/Evidence assertion saved/);expect(mock.rpc).toHaveBeenCalledWith('record_historical_settled_bale',{p_request:id(6),p_payroll:voucher.id,p_expected:snap,p_project:id(5),p_release_date:'2024-10-23',p_amount:'200',p_note:'Release ledger'});expect(mock.rpc).toHaveBeenCalledTimes(1);
 });
 it('keeps the exact ambiguous request on reload and retries without creating a new identifier',async()=>{
  mock.rpc.mockRejectedValueOnce(Error('lost')).mockResolvedValueOnce({data:{request_id:id(6),payroll_id:voucher.id,replayed:true,payment_date:'2024-10-26'},error:null});const first=render(React.createElement(HistoricalFinanceEntry,props));dateForm();fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(screen.getByRole('button',{name:'Save historical assertion'}));await screen.findByText(/Outcome not verified/);expect(sessionStorage.length).toBe(1);first.unmount();
  render(React.createElement(HistoricalFinanceEntry,{...props,evidence:null}));fireEvent.click(screen.getByRole('button',{name:'Retry exact evidence request'}));await screen.findByText(/Evidence assertion saved/);expect(mock.rpc.mock.calls[1][1]).toEqual(mock.rpc.mock.calls[0][1]);expect(crypto.randomUUID).toHaveBeenCalledTimes(1);expect(sessionStorage.length).toBe(0);
 });
 it('does not send if retry storage is unavailable or an existing record is corrupt',async()=>{
  render(React.createElement(HistoricalFinanceEntry,props));dateForm();fireEvent.click(screen.getByRole('checkbox'));vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw Error('unavailable');});fireEvent.click(screen.getByRole('button',{name:'Save historical assertion'}));await screen.findByText(/no request was sent/);expect(mock.rpc).not.toHaveBeenCalled();cleanup();vi.restoreAllMocks();
  sessionStorage.setItem(JSON.stringify(['historical-evidence-v1',props.userId,voucher.id]),'broken');render(React.createElement(HistoricalFinanceEntry,props));expect(await screen.findByText(/previous request may have been sent/)).toBeTruthy();expect(screen.queryByRole('button',{name:'Review historical payment-date assertion'})).toBeNull();expect(mock.rpc).not.toHaveBeenCalled();
 });
 it('withholds entry for a stale or missing snapshot, conflict or changed date assertion',()=>{
  const view=render(React.createElement(HistoricalFinanceEntry,{...props,evidence:{...evidence,voucher_snapshot:{...snap,net_pay:'999'}}}));expect(screen.getByText(/snapshots differ or are invalid/)).toBeTruthy();expect(screen.queryByRole('button',{name:'Review historical payment-date assertion'})).toBeNull();
  view.rerender(React.createElement(HistoricalFinanceEntry,{...props,evidence:{...evidence,payment_conflict:true,recorded_payment_date:'2024-10-25',date_evidence:dateEvidence}}));expect(screen.queryByRole('button',{name:'Review settled Bale assertion'})).toBeNull();
  view.rerender(React.createElement(HistoricalFinanceEntry,{...props,evidence:{...evidence,date_evidence:{...dateEvidence,matches_voucher:false}}}));expect(screen.queryByRole('button',{name:'Review settled Bale assertion'})).toBeNull();
 });
 it('rejects future and mismatched inputs and resets confirmation on new evidence',async()=>{
  const view=render(React.createElement(HistoricalFinanceEntry,props));dateForm();fireEvent.click(screen.getByRole('checkbox'));fireEvent.change(screen.getByLabelText('Actual external payment date'),{target:{value:'2026-12-01'}});fireEvent.click(screen.getByRole('button',{name:'Save historical assertion'}));expect((await screen.findByRole('alert')).textContent).toMatch(/Check the date/);expect(mock.rpc).not.toHaveBeenCalled();
  view.rerender(React.createElement(HistoricalFinanceEntry,{...props,evidence:{...evidence}}));expect(screen.queryByRole('checkbox')).toBeNull();
 });
 it('ignores completion from an unmounted view, retaining the retry if the outcome is ambiguous',async()=>{
  const pending=deferred();mock.rpc.mockReturnValue(pending.promise);const first=render(React.createElement(HistoricalFinanceEntry,props));dateForm();fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(screen.getByRole('button',{name:'Save historical assertion'}));first.unmount();await act(async()=>pending.resolve({data:null,error:{message:'lost'}}));expect(props.onRecorded).not.toHaveBeenCalled();expect(sessionStorage.length).toBe(1);
 });
 it('validates saved scope and snapshot amounts without float rounding',()=>{
  expect(snapshotMatchesVoucher(parseHistoricalSnapshot(snap),voucher)).toBe(true);expect(()=>parseHistoricalSnapshot({...snap,gross_pay:'NaN'})).toThrow();expect(()=>parseHistoricalSnapshot({...snap,extra:1})).toThrow();expect(()=>parseHistoricalAttempt({kind:'date',request:id(6),snapshot:{...snap,worker_id:id(99)},date:'2024-10-26',note:'x',project:null},voucher)).toThrow();
 });
});
