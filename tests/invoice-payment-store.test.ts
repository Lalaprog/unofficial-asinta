// @vitest-environment jsdom
import React from 'react';
import {act,cleanup,render,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const mock=vi.hoisted(()=>({rpc:vi.fn(),updates:[] as unknown[],toast:vi.fn()}));
vi.mock('@/lib/supabase/client',()=>({createClient:()=>({
  rpc:mock.rpc,
  from:(table:string)=>({
    select:()=>({order:async()=>({data:[],error:null}),then:(resolve:(v:unknown)=>void)=>resolve({data:[],error:null})}),
    update:(payload:unknown)=>({eq:()=>({select:()=>({single:async()=>{mock.updates.push({table,payload});return {data:{id:'inv',amount:100,amount_paid:100,status:'paid',automatic_reminders_enabled:true},error:null}}})})}),
  }),
})}));
vi.mock('@/lib/auth/authContext',()=>{ const user={id:'f',email:'f@example.test',role:'founder'}; return {useAuth:()=>({user,isFounder:true})}; });
vi.mock('@/components/ui/Toast',()=>({useToast:()=>({showToast:mock.toast})}));
vi.mock('@/lib/audit/log',()=>({writeAuditEntry:async()=>({ok:true}),auditFailureMessage:()=>''}));
import {DataStoreProvider,useDataStore} from '@/lib/data/store';
import type {InvoicePaymentAttempt} from '@/lib/invoices/payment';
let current:ReturnType<typeof useDataStore>;
function Probe(){current=useDataStore();return null}
const attempt:InvoicePaymentAttempt={requestId:'00000000-0000-4000-8000-000000000005',invoiceId:'inv',amount:'30.25',expectedTotal:100,expectedPaid:0,expectedStatus:'pending'};
beforeEach(()=>{mock.rpc.mockReset();mock.toast.mockReset();mock.updates=[];sessionStorage.clear()});
afterEach(()=>cleanup());
async function setup(){render(React.createElement(DataStoreProvider,null,React.createElement(Probe)));await waitFor(()=>expect(current.isLoaded).toBe(true))}
describe('invoice payment store',()=>{
  it('sends the exact snapshot through the RPC and does not write an invoice directly',async()=>{
    await setup();mock.rpc.mockResolvedValue({data:{outcome:'recorded',invoice:{id:'inv',amount:'100',amount_paid:'30.25',status:'partially_paid'}},error:null});
    await act(async()=>{expect(await current.recordInvoicePayment(attempt)).toMatchObject({outcome:'recorded',invoice:{amount:100,amount_paid:30.25}})});
    expect(mock.rpc).toHaveBeenCalledWith('record_invoice_payment_atomic',{p_request_id:attempt.requestId,p_invoice_id:'inv',p_amount:'30.25',p_expected_total:100,p_expected_paid:0,p_expected_status:'pending'});
    expect(mock.updates).toHaveLength(0);
  });
  it('treats an RPC error, throw or malformed response as unconfirmed and never falls back to a direct write',async()=>{
    await setup();mock.rpc.mockResolvedValueOnce({data:null,error:{code:'PGRST202'}}).mockResolvedValueOnce({data:null,error:{code:'500'}}).mockRejectedValueOnce(new Error('lost response')).mockResolvedValueOnce({data:{outcome:'unknown'},error:null});
    for(const outcome of ['unavailable','unconfirmed','unconfirmed','unconfirmed']) await act(async()=>{expect((await current.recordInvoicePayment(attempt)).outcome).toBe(outcome)});
    expect(mock.updates).toHaveLength(0);
  });
  it('updates reminders without deriving stale payment status',async()=>{
    await setup();await act(async()=>{await current.updateInvoice('inv',{automatic_reminders_enabled:true})});
    expect(mock.updates).toEqual([{table:'invoices',payload:{automatic_reminders_enabled:true}}]);
    await act(async()=>{expect(await current.updateInvoice('inv',{amount_paid:100,status:'paid'})).toBeNull()});
    expect(mock.updates).toHaveLength(1);
  });
});
