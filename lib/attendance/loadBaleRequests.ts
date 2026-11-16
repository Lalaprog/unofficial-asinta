import type {SupabaseClient} from '@supabase/supabase-js';
import type {AdvanceRequest} from '@/types';

const PAGE_SIZE=500;
/** Keeps status verification bounded; open requests take priority over history. */
export const MAX_LOADED_BALE_REQUESTS=2000;
const OPEN=['pending_approval','approved_pending_payment'] as const;
const HISTORY=['issued','rejected'] as const;
export type BaleRequestCoverage={openOmitted:number;historyOmitted:number};
type Page={data:unknown;count:number|null;error:{message:string}|null};
type FetchPage=(statuses:readonly string[],from:number,to:number)=>PromiseLike<Page>;

/** A newly returned request must not expand the view past status-check bounds. */
export function mergeLoadedBaleRequest(existing:AdvanceRequest[],incoming:AdvanceRequest):AdvanceRequest[] {
 const rows=[incoming,...existing.filter(row=>row.id!==incoming.id)];
 const open=rows.filter(row=>row.status==='pending_approval'||row.status==='approved_pending_payment');
 const history=rows.filter(row=>row.status!=='pending_approval'&&row.status!=='approved_pending_payment');
 return [...open,...history].slice(0,MAX_LOADED_BALE_REQUESTS);
}

/** Multiple RLS-protected statements, not a transaction. Count, shape and ID
 * checks catch some concurrent changes but cannot prove a consistent snapshot. */
export async function loadBaleRequestPages(fetchPage:FetchPage):Promise<{data:Record<string,unknown>[];coverage:BaleRequestCoverage}> {
 const seen=new Set<string>();
 async function group(statuses:readonly string[],capacity:number){
  const rows:Record<string,unknown>[]=[];let count:number|null=null;
  // Even with no room, query once to report omitted history accurately.
  do {
   const limit=capacity===0?1:Math.min(PAGE_SIZE,capacity-rows.length);
   const response=await fetchPage(statuses,rows.length,rows.length+limit-1);
   if(response.error)throw Error(response.error.message);
   if(!Number.isSafeInteger(response.count)||response.count===null||response.count<0||!Array.isArray(response.data))throw Error('Bale request count or page unavailable');
   if(count!==null&&response.count!==count)throw Error('Bale requests changed while loading');
   count=response.count;
   if(response.data.length>limit || response.data.length>Math.max(0,count-rows.length) || (count>rows.length&&response.data.length===0))throw Error('Incomplete Bale request page');
   if(capacity===0)break;
   for(const value of response.data){
    if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid Bale request page');
    const row=value as Record<string,unknown>;
    if(typeof row.id!=='string'||!row.id||seen.has(row.id)||typeof row.status!=='string'||!statuses.includes(row.status))throw Error('Bale request page changed or is invalid');
    seen.add(row.id);rows.push(row);
   }
  } while(count!==null && rows.length<count && rows.length<capacity);
  return {rows,omitted:Math.max(0,(count??0)-rows.length)};
 }
 const open=await group(OPEN,MAX_LOADED_BALE_REQUESTS);
 const history=await group(HISTORY,MAX_LOADED_BALE_REQUESTS-open.rows.length);
 return {data:[...open.rows,...history.rows],coverage:{openOmitted:open.omitted,historyOmitted:history.omitted}};
}

/** Uses stable tie-breaking and exact per-group counts. The queries use the
 * current user's JWT/RLS and the server's own maximum row limit. */
export function loadBaleRequests(client:SupabaseClient){
 return loadBaleRequestPages((statuses,from,to)=>client.from('advance_requests')
  .select('*',{count:'exact'}).in('status',[...statuses])
  .order('created_at',{ascending:false}).order('id',{ascending:false}).range(from,to));
}
