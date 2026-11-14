// @vitest-environment jsdom
import React from 'react';
import {act, cleanup, render, waitFor} from '@testing-library/react';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type { Invoice } from '@/types';
const mock = vi.hoisted(() => ({ updates: [] as Array<{table:string;payload:unknown;filters:Array<[string,unknown]>}>, result: {data:null as any,error:null as any}, thrown:false, audit:vi.fn(), toast:vi.fn() }));
vi.mock('@/lib/attendance/loadBaleRequests',()=>({loadBaleRequests:async()=>({data:[],coverage:{openOmitted:0,historyOmitted:0}})}));
vi.mock('@/lib/supabase/client', () => ({createClient: () => ({
  rpc: () => ({order: async () => ({data:[],error:null})}),
  from: (table:string) => ({
    select: () => ({order: async () => ({data:[],error:null}), then: (resolve:(v:unknown)=>void) => resolve({data:[],error:null})}),
    update: (payload:unknown) => {
      const filters:Array<[string,unknown]>=[];
      const execute = async () => {mock.updates.push({table,payload,filters}); if(mock.thrown) throw new Error('lost connection'); return mock.result};
      const builder = {eq:(key:string,value:unknown) => {filters.push([key,value]);return builder}, select: () => ({maybeSingle:execute,single:execute})};
      return builder;
    },
  }),
})}));
vi.mock('@/lib/auth/authContext',()=>{const user={id:'founder',email:'founder@example.test',role:'founder'};return {useAuth:()=>({assurance:'ready',user,isFounder:true})}});
vi.mock('@/components/ui/Toast',()=>({useToast:()=>({showToast:mock.toast})}));
vi.mock('@/lib/audit/log',()=>({writeAuditEntry:mock.audit,auditFailureMessage:()=>''}));
import {DataStoreProvider,useDataStore} from '@/lib/data/store';
import {prepareInvoicePayment} from '@/lib/invoices/payment';
let current:ReturnType<typeof useDataStore>;
function Probe(){current=useDataStore();return null}
const invoice:Invoice={id:'inv',invoice_number:'INV-1',project_id:'p',client_id:'c',amount:100,amount_paid:0,status:'pending',issue_date:'2026-01-01',due_date:'2026-02-01',created_at:'2026-01-01',automatic_reminders_enabled:false,reminders_paused_until:null};
beforeEach(()=>{mock.updates=[];mock.result={data:null,error:null};mock.thrown=false;mock.audit.mockReset().mockResolvedValue({ok:true});mock.toast.mockReset();sessionStorage.clear()});
afterEach(()=>cleanup());
async function setup(){render(React.createElement(DataStoreProvider,null,React.createElement(Probe)));await waitFor(()=>expect(current.isLoaded).toBe(true))}
describe('invoice payment guard',()=>{
  it('uses the invoice the user reviewed in all conditional filters and writes the audit after the payment',async()=>{
    await setup();mock.result={data:{...invoice,amount_paid:30.25,status:'partially_paid'},error:null};
    await act(async()=>{expect(await current.recordInvoicePayment(invoice,'30.25')).toBe('recorded')});
    expect(mock.updates).toEqual([{table:'invoices',payload:{amount_paid:30.25,status:'partially_paid'},filters:[['id','inv'],['amount',100],['amount_paid',0],['status','pending']]}]);
    expect(mock.audit).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({recordId:'inv',before:invoice,after:expect.objectContaining({amount_paid:30.25})}));
  });
  it('does not audit or retry a zero-row, error, or lost response',async()=>{
    await setup();
    await act(async()=>{expect(await current.recordInvoicePayment(invoice,'10')).toBe('stale')});
    mock.result={data:null,error:{message:'network'}};
    await act(async()=>{expect(await current.recordInvoicePayment(invoice,'10')).toBe('unconfirmed')});
    mock.thrown=true;
    await act(async()=>{expect(await current.recordInvoicePayment(invoice,'10')).toBe('unconfirmed')});
    expect(mock.updates).toHaveLength(3);expect(mock.audit).not.toHaveBeenCalled();
  });
  it('distinguishes a saved payment whose audit write failed or threw',async()=>{
    await setup();mock.result={data:{...invoice,amount_paid:10,status:'partially_paid'},error:null};
    mock.audit.mockResolvedValueOnce({ok:false}).mockRejectedValueOnce(new Error('unavailable'));
    for(let i=0;i<2;i++) await act(async()=>{expect(await current.recordInvoicePayment(invoice,'10')).toBe('audit_unconfirmed')});
    expect(mock.updates).toHaveLength(2);
  });
  it('updates reminder settings without using a stale invoice status',async()=>{
    await setup();mock.result={data:{...invoice,status:'paid',amount_paid:100,automatic_reminders_enabled:true},error:null};
    await act(async()=>{await current.updateInvoice('inv',{automatic_reminders_enabled:true})});
    expect(mock.updates).toEqual([{table:'invoices',payload:{automatic_reminders_enabled:true},filters:[['id','inv']]}]);
  });
  it('validates positive two-decimal amounts and uses integer cents',()=>{
    for(const amount of ['0','-1','0.001','101','NaN','1e2','1000000000000']) expect(prepareInvoicePayment(invoice,amount)).toBeNull();
    expect(prepareInvoicePayment({...invoice,amount:0.3,amount_paid:0.1,status:'partially_paid'},'0.20')).toEqual({amountPaid:0.3,status:'paid'});
    expect(prepareInvoicePayment(invoice,'30.25')).toEqual({amountPaid:30.25,status:'partially_paid'});
    expect(prepareInvoicePayment({...invoice,status:'paid',amount_paid:100},'1')).toBeNull();
  });
});
