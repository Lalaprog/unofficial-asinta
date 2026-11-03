import { describe, expect, it } from 'vitest';
import { buildReceiptDraft, receiptDescription } from '@/lib/ai/receiptDraft';
import type { DraftContext } from '@/lib/ai/draft';
const context:DraftContext={projects:[{id:'p',name:'Casa Batangas'}],vendorMemory:[],todayISO:'2026-11-03'};
const text='JMC Hardware\nPORTLAND CEMENT 10 BAGS\nITEM 4800\nTOTAL 5200\n2026-10-31';
describe('receipt draft evidence',()=>{
  it('accepts only a short exact item excerpt, not an invented or whole receipt',()=>{
    expect(receiptDescription('PORTLAND CEMENT 10 BAGS',text)).toBe('PORTLAND CEMENT 10 BAGS');
    expect(receiptDescription('Cement and steel',text)).toBe('');
    expect(receiptDescription(text,text)).toBe('');
    expect(receiptDescription('TOTAL 5200',text)).toBe('');
    expect(receiptDescription('x'.repeat(121),'x'.repeat(121))).toBe('');
  });
  it('keeps uncertain amounts and dates blank rather than guessing from other numbers',()=>{
    const draft=buildReceiptDraft({description:'PORTLAND CEMENT 10 BAGS',amount:null,amount_quote:null,date:'2026-10-31',date_quote:'31/10/2026',vendor:'JMC Hardware',vendor_quote:'JMC Hardware'},text,context,'mock');
    expect(draft.description).toBe('PORTLAND CEMENT 10 BAGS');expect(draft.amount).toBeNull();expect(draft.expenseDate).toBeNull();expect(draft.vendor).toBe('JMC Hardware');expect(draft.unresolved.join(' ')).toMatch(/date needs your input/i);expect(draft.verification).toBe('model-reported');
  });
  it('accepts only a quoted amount, ISO date, supplier and project found in model-read text',()=>{
    const draft=buildReceiptDraft({description:'PORTLAND CEMENT 10 BAGS',amount:5200,amount_quote:'TOTAL 5200',date:'2026-10-31',date_quote:'2026-10-31',vendor:'JMC Hardware',vendor_quote:'JMC Hardware',project_name:'Casa Batangas'},text,context,'mock');
    expect(draft.amount).toBe(5200);expect(draft.expenseDate).toBe('2026-10-31');expect(draft.projectId).toBeNull();expect(draft.vendor).toBe('JMC Hardware');
    const bad=buildReceiptDraft({description:'Invented',amount:9999,amount_quote:'TOTAL 5200',vendor:'Invented',vendor_quote:'JMC Hardware',bale:'false'},text,context,'mock');
    expect(bad.amount).toBeNull();expect(bad.vendor).toBeNull();expect(bad.description).toBe('');expect(bad.isBaleHint).toBe(false);expect(bad.unresolved.join(' ')).toMatch(/short item description/);
  });
  it('does not accept a line item or subtotal as the receipt total',()=>{
    const item=buildReceiptDraft({amount:4800,amount_quote:'ITEM 4800'},text,context,'mock');expect(item.amount).toBeNull();
    const subtotal=buildReceiptDraft({amount:4800,amount_quote:'4800'},'SUBTOTAL 4800\nTOTAL 5200',context,'mock');expect(subtotal.amount).toBeNull();
  });

});
