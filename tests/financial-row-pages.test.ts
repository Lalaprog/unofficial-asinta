import {describe,expect,it,vi} from 'vitest';
import type {SupabaseClient} from '@supabase/supabase-js';
import {loadFinancialRowPages,loadFinancialRows,MAX_SHARED_FINANCIAL_ROWS} from '@/lib/data/loadFinancialRows';

const make=(n:number)=>Array.from({length:n},(_,i)=>({id:`row-${i}`}));
function source(rows:ReturnType<typeof make>,cap=500){
 return vi.fn(async(from:number,to:number)=>({data:rows.slice(from,Math.min(to+1,from+cap)),count:rows.length,error:null}));
}
describe('bounded shared financial rows',()=>{
 it('uses exact RLS-scoped count and deterministic order for both tables',async()=>{
  for(const table of ['invoices','expenses'] as const){
   const calls:unknown[][]=[];
   const builder={select:(...a:unknown[])=>{calls.push(['select',...a]);return builder;},order:(...a:unknown[])=>{calls.push(['order',...a]);return builder;},range:async(...a:unknown[])=>{calls.push(['range',...a]);return {data:[],count:0,error:null}}};
   const client={from:(name:string)=>{calls.push(['from',name]);return builder}} as unknown as SupabaseClient;
   expect(await loadFinancialRows(client,table)).toEqual({data:[],omitted:0});
   expect(calls).toEqual([['from',table],['select','*',{count:'exact'}],['order','created_at',{ascending:false}],['order','id',{ascending:false}],['range',0,499]]);
  }
 });
 it('continues across a smaller server page limit and reports the capped remainder',async()=>{
  const fetch=source(make(MAX_SHARED_FINANCIAL_ROWS+23),137);
  const loaded=await loadFinancialRowPages(fetch);
  expect(loaded.data).toHaveLength(MAX_SHARED_FINANCIAL_ROWS);expect(loaded.omitted).toBe(23);
  expect(fetch.mock.calls.every(([from,to])=>to-from+1<=500)).toBe(true);
 });
 it('rejects unavailable counts, failed or missing data, and incomplete early pages',async()=>{
  for(const result of [{data:[],count:null,error:null},{data:null,count:0,error:null},{data:null,count:null,error:{message:'offline'}},{data:[],count:2,error:null}])
   await expect(loadFinancialRowPages(async()=>result)).rejects.toThrow();
 });
 it('rejects count drift, repeated ids and invalid rows',async()=>{
  const cases=[
   [{data:[{id:'a'}],count:2,error:null},{data:[{id:'b'}],count:3,error:null}],
   [{data:[{id:'a'}],count:2,error:null},{data:[{id:'a'}],count:2,error:null}],
   [{data:[{}],count:1,error:null}],
  ];
  for(const sequence of cases){let index=0;await expect(loadFinancialRowPages(async()=>sequence[index++])).rejects.toThrow();}
 });
});
