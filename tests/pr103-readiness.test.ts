import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
const sql=readFileSync('supabase/preflight/pr103_readiness.sql','utf8');
describe('PR 103 read-only catalog preflight',()=>{
 it('reports absent prerequisites and detects name collisions without modifying data',async()=>{
  const db=new PGlite();try{
   await db.exec(`CREATE SCHEMA auth; CREATE SCHEMA app_private; CREATE TABLE public.attendance(id int); INSERT INTO public.attendance VALUES (123); CREATE TABLE public.supervisor_leave_requests(id int); CREATE FUNCTION public.weekly_worker_time_preview_inputs(date) RETURNS int LANGUAGE sql AS $$SELECT 1$$;`);
   const result=(await db.query<{readiness:{missing_relations:string[];missing_helpers:string[];existing_new_relations:string[];existing_new_functions:string[];advance_request_explicit_column_acls:unknown[]}}>(sql)).rows[0].readiness;
   expect(result.missing_relations).toContain('public.workers');expect(result.missing_relations).not.toContain('public.attendance');
   expect(result.missing_helpers).toContain('public.is_founder()');
   expect(result.existing_new_relations).toEqual(['public.supervisor_leave_requests']);
   expect(result.existing_new_functions).toContain('public.weekly_worker_time_preview_inputs(date)');
   expect(result.advance_request_explicit_column_acls).toEqual([]);
   expect((await db.query<{id:number}>('SELECT id FROM public.attendance')).rows).toEqual([{id:123}]);
  }finally{await db.close();}
 },30000);
});
