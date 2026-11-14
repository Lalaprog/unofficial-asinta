import type {SupabaseClient} from '@supabase/supabase-js';

const PAGE_SIZE=500;
/** Avoid silently presenting a server-capped first page as a complete ledger. */
export const MAX_SHARED_FINANCIAL_ROWS=3000;
type Page={data:unknown;count:number|null;error:{message:string}|null};
type FetchPage=(from:number,to:number)=>PromiseLike<Page>;

/** Count-checked pages are independent RLS-visible statements, not a snapshot. */
export async function loadFinancialRowPages(fetch:FetchPage):Promise<{data:Record<string,unknown>[];omitted:number}> {
 const rows:Record<string,unknown>[]=[];
 const seen=new Set<string>();
 let count:number|null=null;
 do {
  const limit=Math.min(PAGE_SIZE,MAX_SHARED_FINANCIAL_ROWS-rows.length);
  const page=await fetch(rows.length,rows.length+limit-1);
  if(page.error)throw Error(page.error.message);
  if(!Number.isSafeInteger(page.count)||page.count===null||page.count<0||!Array.isArray(page.data))throw Error('Financial row count or page unavailable');
  if(count!==null&&page.count!==count)throw Error('Financial rows changed while loading');
  count=page.count;
  if(page.data.length>limit||page.data.length>Math.max(0,count-rows.length)||(count>rows.length&&page.data.length===0))throw Error('Incomplete financial row page');
  for(const value of page.data){
   if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid financial row');
   const row=value as Record<string,unknown>;
   if(typeof row.id!=='string'||!row.id||seen.has(row.id))throw Error('Financial rows changed or are invalid');
   seen.add(row.id);rows.push(row);
  }
 }while(count!==null&&rows.length<count&&rows.length<MAX_SHARED_FINANCIAL_ROWS);
 return {data:rows,omitted:Math.max(0,(count??0)-rows.length)};
}

/** These tables both have a unique id and created_at. Uses the current JWT. */
export function loadFinancialRows(client:SupabaseClient,table:'invoices'|'expenses'){
 return loadFinancialRowPages((from,to)=>client.from(table).select('*',{count:'exact'})
  .order('created_at',{ascending:false}).order('id',{ascending:false}).range(from,to));
}
