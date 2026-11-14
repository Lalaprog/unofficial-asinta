import {describe,expect,it,vi} from 'vitest';
import {loadBaleRequestPages,loadBaleRequests,mergeLoadedBaleRequest,MAX_LOADED_BALE_REQUESTS} from '@/lib/attendance/loadBaleRequests';
import type {AdvanceRequest} from '@/types';
import type {SupabaseClient} from '@supabase/supabase-js';

type Row={id:string;status:string};
const make=(prefix:string,status:string,count:number):Row[]=>Array.from({length:count},(_,i)=>({id:`${prefix}-${i}`,status}));
function source(rows:Row[],serverCap=500){
 return vi.fn(async(statuses:readonly string[],from:number,to:number)=>{
  const matching=rows.filter(row=>statuses.includes(row.status));
  return {data:matching.slice(from,Math.min(to+1,from+serverCap)),count:matching.length,error:null};
 });
}
describe('bounded Bale request loading',()=>{
 it('requests RLS-scoped exact counts, stable ordering and bounded ranges through PostgREST',async()=>{
  const calls:unknown[][]=[];
  const builder={select:(...args:unknown[])=>{calls.push(['select',...args]);return builder;},in:(...args:unknown[])=>{calls.push(['in',...args]);return builder;},order:(...args:unknown[])=>{calls.push(['order',...args]);return builder;},range:async(...args:unknown[])=>{calls.push(['range',...args]);return {data:[],count:0,error:null};}};
  const client={from:(name:string)=>{calls.push(['from',name]);return builder;}} as unknown as SupabaseClient;
  await loadBaleRequests(client);
  expect(calls).toEqual([
   ['from','advance_requests'],['select','*',{count:'exact'}],['in','status',['pending_approval','approved_pending_payment']],['order','created_at',{ascending:false}],['order','id',{ascending:false}],['range',0,499],
   ['from','advance_requests'],['select','*',{count:'exact'}],['in','status',['issued','rejected']],['order','created_at',{ascending:false}],['order','id',{ascending:false}],['range',0,499],
  ]);
 });
 it('prioritizes all open requests over a larger historical backlog across server row caps',async()=>{
  const fetch=source([...make('old','rejected',1500),...make('open','pending_approval',750),...make('paid','issued',300)],173);
  const result=await loadBaleRequestPages(fetch);
  expect(result.data).toHaveLength(MAX_LOADED_BALE_REQUESTS);
  expect(result.data.slice(0,750).every(row=>row.status==='pending_approval')).toBe(true);
  expect(result.coverage).toEqual({openOmitted:0,historyOmitted:550});
  expect(fetch.mock.calls.every(([,from,to])=>to-from+1<=500)).toBe(true);
 });
 it('keeps a newly confirmed request within the bound and does not duplicate a replay',()=>{
  const open=make('open','pending_approval',1000),history=make('old','rejected',1000);
  const rows=[...open,...history] as AdvanceRequest[];
  const incoming={id:'new',status:'pending_approval'} as AdvanceRequest;
  const merged=mergeLoadedBaleRequest(rows,incoming);
  expect(merged).toHaveLength(2000);expect(merged[0].id).toBe('new');
  expect(merged.filter(row=>row.status==='pending_approval')).toHaveLength(1001);
  expect(merged.some(row=>row.id==='old-999')).toBe(false);
  const replay=mergeLoadedBaleRequest(merged,incoming);
  expect(replay).toHaveLength(2000);expect(replay.filter(row=>row.id==='new')).toHaveLength(1);
 });
 it('reports omitted open requests and still checks the size of history when the view is full',async()=>{
  const fetch=source([...make('open','approved_pending_payment',2100),...make('old','issued',7)]);
  const result=await loadBaleRequestPages(fetch);
  expect(result.data).toHaveLength(2000);
  expect(result.coverage).toEqual({openOmitted:100,historyOmitted:7});
  expect(fetch.mock.calls.at(-1)?.slice(1)).toEqual([0,0]);
 });
 it('handles an empty list without inventing omissions',async()=>{
  const result=await loadBaleRequestPages(source([]));
  expect(result).toEqual({data:[],coverage:{openOmitted:0,historyOmitted:0}});
 });
 it('rejects missing count, null data, failed pages and a silent early empty page',async()=>{
  for(const response of [{data:[],count:null,error:null},{data:null,count:0,error:null},{data:null,count:null,error:{message:'offline'}},{data:[],count:5,error:null}]){
   await expect(loadBaleRequestPages(async()=>response)).rejects.toThrow();
  }
 });
 it('rejects count drift, duplicate IDs and unexpected statuses across pages',async()=>{
  const responses=[
   [{data:[{id:'a',status:'pending_approval'}],count:2,error:null},{data:[{id:'b',status:'pending_approval'}],count:3,error:null}],
   [{data:[{id:'a',status:'pending_approval'}],count:2,error:null},{data:[{id:'a',status:'pending_approval'}],count:2,error:null}],
   [{data:[{id:'a',status:'issued'}],count:1,error:null}],
  ];
  for(const sequence of responses){let n=0;await expect(loadBaleRequestPages(async()=>sequence[n++])).rejects.toThrow();}
 });
});
