import {describe,expect,it} from 'vitest';
import {parseExpensePage,parseExpenseTotals} from '@/lib/projects/expenseLedger';
const record={id:'b',project_id:'site',description:'Cement',category:'materials',amount:'12.35',expense_date:'2026-10-10',notes:null};
describe('expense ledger validation',()=>{
 it('preserves centavos and zero expense totals',()=>{
  expect(parseExpenseTotals([{project_id:'site',expense_count:2,total:'12.35'},{project_id:'empty',expense_count:0,total:'0'}],['site','empty']).get('site')?.total).toBe(12.35);
  expect(parseExpensePage({items:[record],has_more:false},'site').items[0].amount).toBe(12.35);
 });
 it('rejects incomplete or unsafe totals and stale/misordered pages',()=>{
  for(const data of [[],[{project_id:'other',expense_count:2,total:'1.00'}],[{project_id:'site',expense_count:1,total:'1.234'}],[{project_id:'site',expense_count:1,total:'90071992547409.91'}]]) expect(()=>parseExpenseTotals(data,['site'])).toThrow();
  for(const data of [{items:[{...record,project_id:'other'}],has_more:false},{items:[record,record],has_more:false},{items:[{...record,expense_date:'2026-02-30'}],has_more:false},{items:[],has_more:true}]) expect(()=>parseExpensePage(data,'site')).toThrow();
 });
});
