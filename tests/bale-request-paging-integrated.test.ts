// Synthetic database only; does not connect to a hosted project.
import {PGlite} from '@electric-sql/pglite';
import {describe,expect,it} from 'vitest';
import {loadBaleRequestPages} from '@/lib/attendance/loadBaleRequests';

describe('Bale request loading over synthetic row-level policies',()=>{
 it('keeps an old open request visible despite newer history and respects the actor scope',async()=>{
  const db=new PGlite();try{
   await db.exec(`CREATE ROLE authenticated;CREATE TABLE public.advance_requests(id uuid primary key,status text not null,submitted_by text not null,created_at timestamptz not null);
    ALTER TABLE public.advance_requests ENABLE ROW LEVEL SECURITY;
    GRANT SELECT ON public.advance_requests TO authenticated;
    CREATE POLICY test_role_visibility ON public.advance_requests FOR SELECT TO authenticated USING(current_setting('test.role')='founder' OR submitted_by=current_setting('test.actor'));
    INSERT INTO public.advance_requests SELECT md5('history-'||n)::uuid,'rejected',CASE WHEN n<=501 THEN 'sup-a' ELSE 'sup-b' END,'2026-11-14'::timestamptz FROM generate_series(1,2100) n;
    INSERT INTO public.advance_requests VALUES(md5('old-open')::uuid,'pending_approval','sup-a','2026-01-01');
    SET test.role='founder';SET test.actor='f';SET ROLE authenticated;`);
   const fetch=async(statuses:readonly string[],from:number,to:number)=>{
    const count=(await db.query<{count:number}>('SELECT count(*)::int count FROM public.advance_requests WHERE status=ANY($1::text[])',[statuses])).rows[0].count;
    const data=(await db.query('SELECT id::text,status FROM public.advance_requests WHERE status=ANY($1::text[]) ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3',[statuses,to-from+1,from])).rows;
    return {data,count,error:null};
   };
   const founder=await loadBaleRequestPages(fetch);
   expect(founder.data).toHaveLength(2000);expect(founder.data[0].status).toBe('pending_approval');
   expect(founder.coverage).toEqual({openOmitted:0,historyOmitted:101});
   await db.exec("SET test.role='supervisor';SET test.actor='sup-a'");
   const supervisor=await loadBaleRequestPages(fetch);
   expect(supervisor.data).toHaveLength(502);expect(supervisor.data[0].status).toBe('pending_approval');
   expect(supervisor.coverage).toEqual({openOmitted:0,historyOmitted:0});
  }finally{await db.close();}
 },30000);
});
