import { describe, expect, it } from 'vitest';
import { prepareExpenseItems, itemSubtotal } from '@/lib/expenses/items';
import { buildReceiptItems } from '@/lib/ai/receiptDraft';

describe('receipt item breakdown', () => {
  it('validates rows, permits unknown fields, and computes a centavo-safe subtotal', () => {
    const result = prepareExpenseItems([{name:' Cement ',quantity:'10 bags',amount:'2500.50'}, {name:'Sand',quantity:'',amount:'1200.25'}, {name:'',quantity:'',amount:''}]);
    expect(result.items).toEqual([{name:'Cement',quantity:'10 bags',amount:2500.5},{name:'Sand',quantity:null,amount:1200.25}]);
    expect(itemSubtotal(result.items)).toBe(3700.75);
    expect(itemSubtotal([{name:'Cement',quantity:null,amount:null}])).toBeNull();
    for (const amount of ['-1','2.001','1e2','10000000000','foo']) expect(prepareExpenseItems([{name:'x',quantity:'',amount}]).error).toBeTruthy();
    expect(prepareExpenseItems([{name:'',quantity:'1',amount:''}]).error).toBeTruthy();
    expect(prepareExpenseItems(Array.from({length:101},()=>({name:'x',quantity:'',amount:''}))).error).toBeTruthy();
  });
  it('only suggests item lines actually quoted from the model reading', () => {
    const text='CEMENT 10 BAGS 4800.00\nSAND 2 LOADS 1200.00\nTOTAL 6000.00';
    expect(buildReceiptItems([
      {name:'CEMENT',quantity:'10 BAGS',amount:4800,line_quote:'CEMENT 10 BAGS 4800.00'},
      {name:'SAND',quantity:'3 LOADS',amount:999,line_quote:'SAND 2 LOADS 1200.00'},
      {name:'Invented',quantity:'1',amount:1,line_quote:'Invented 1'},
      {name:'TOTAL',quantity:null,amount:6000,line_quote:'TOTAL 6000.00'},
    ],text)).toEqual([{name:'CEMENT',quantity:'10 BAGS',amount:4800},{name:'SAND',quantity:null,amount:null}]);
  });
});
