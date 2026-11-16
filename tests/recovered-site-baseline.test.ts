import {PGlite} from '@electric-sql/pglite';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
const sql=readFileSync('supabase/preflight/recovered_site_baseline.sql','utf8');
type Baseline={functions:{signature:string;present:boolean;body_matches:boolean;execution_mode_matches:boolean;contract_matches:boolean;grants_match:boolean}[];tables:{name:string;present:boolean;rls_enabled:boolean;policy_count:number}[];site_guard_trigger_enabled:boolean;gated_functions:{signature:string;present:boolean}[]};
describe('read-only recovered-site baseline',()=>{
 it('reports absent objects and detects selected schema, mode and privilege drift without modifying records',async()=>{
  const db=new PGlite();try{
   await db.exec("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE TABLE public.advance_requests(id int); INSERT INTO public.advance_requests VALUES (42); CREATE FUNCTION public.visible_projects() RETURNS int LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT 1$$; REVOKE ALL ON FUNCTION public.visible_projects() FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.visible_projects() TO authenticated,service_role;");
   const testSql=sql.replace('60eb06b0370a7dcad55523ad20174cb8',createHash('md5').update('SELECT 1').digest('hex'));
   const get=async()=>(await db.query<{baseline:Baseline}>(testSql)).rows[0].baseline;
   const before=await get();const visible=before.functions.find(f=>f.signature==='public.visible_projects()');expect(visible).toEqual({signature:'public.visible_projects()',present:true,body_matches:true,execution_mode_matches:true,contract_matches:false,grants_match:true});
   expect(before.functions.find(f=>f.signature==='public.payroll_input_snapshot(date,date,uuid)')).toMatchObject({present:false,body_matches:false,grants_match:false});
   expect(before.tables.find(t=>t.name==='public.advance_requests')).toMatchObject({present:true,rls_enabled:false,policy_count:0});expect(before.site_guard_trigger_enabled).toBe(false);
   expect(before.gated_functions.every(f=>!f.present)).toBe(true);
   await db.exec("GRANT EXECUTE ON FUNCTION public.visible_projects() TO anon; CREATE OR REPLACE FUNCTION public.visible_projects() RETURNS int LANGUAGE sql VOLATILE SECURITY INVOKER AS $$SELECT 2$$; CREATE FUNCTION public.submit_supervisor_day(uuid,date,text) RETURNS int LANGUAGE sql AS $$SELECT 1$$; ALTER TABLE public.advance_requests ENABLE ROW LEVEL SECURITY;");
   const after=await get();expect(after.functions.find(f=>f.signature==='public.visible_projects()')).toMatchObject({present:true,body_matches:false,execution_mode_matches:false,grants_match:false});expect(after.tables.find(t=>t.name==='public.advance_requests')?.rls_enabled).toBe(true);expect(after.gated_functions.find(f=>f.signature==='public.submit_supervisor_day(uuid,date,text)')?.present).toBe(true);
   expect((await db.query<{id:number}>('SELECT id FROM public.advance_requests')).rows).toEqual([{id:42}]);
  }finally{await db.close();}
 },30000);
});
