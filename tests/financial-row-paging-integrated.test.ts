// Synthetic database only: no hosted rows or payments are created.
import {PGlite} from '@electric-sql/pglite';
import {describe,expect,it} from 'vitest';
import {loadFinancialRowPages} from '@/lib/data/loadFinancialRows';

describe('financial paging over synthetic row policies',()=>{
 it('loads past the first server page and counts only RLS-visible rows',async()=>{
  const db=new PGlite();try{
   await db.exec(`CREATE ROLE authenticated;
    CREATE TABLE public.invoices(id uuid primary key,owner_id text not null,created_at timestamptz not null);
    ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;GRANT SELECT ON public.invoices TO authenticated;
    CREATE POLICY invoice_scope ON public.invoices FOR SELECT TO authenticated USING(current_setting('test.role')='founder' OR owner_id=current_setting('test.actor'));
    INSERT INTO public.invoices SELECT md5('inv-'||n)::uuid,CASE WHEN n<=600 THEN 'a' ELSE 'b' END,'2026-11-14'::timestamptz FROM generate_series(1,3200) n;
    SET test.role='founder';SET test.actor='f';SET ROLE authenticated;`);
   const fetch=async(from:number,to:number)=>{
    const count=(await db.query<{count:number}>('SELECT count(*)::int count FROM public.invoices')).rows[0].count;
    const data=(await db.query('SELECT id::text FROM public.invoices ORDER BY created_at DESC,id DESC LIMIT $1 OFFSET $2',[Math.min(to-from+1,173),from])).rows;
    return {data,count,error:null};
   };
   const founder=await loadFinancialRowPages(fetch);expect(founder.data).toHaveLength(3000);expect(founder.omitted).toBe(200);
   await db.exec("SET test.role='other';SET test.actor='a'");
   const scoped=await loadFinancialRowPages(fetch);expect(scoped.data).toHaveLength(600);expect(scoped.omitted).toBe(0);
  }finally{await db.close();}
 },30000);
});
