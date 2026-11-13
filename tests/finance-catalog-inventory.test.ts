import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';

const sql=readFileSync('supabase/preflight/finance_catalog_inventory.sql','utf8');
type Inventory={missing_roles:string[];missing_relations:string[];missing_or_different_columns:{table:string;column:string;expected_type:string;actual_type:string|null}[];candidate_relation_collisions:string[];column_properties:{table:string;column:string;not_null:boolean;has_default:boolean}[];effective_table_grants:{table:string;role:string;select:boolean;update:boolean}[];explicit_column_grants:{table:string;column:string;acl:string}[];constraints:{table:string;name:string;definition_md5:string}[];triggers:{table:string;name:string;function_body_md5:string}[];policies:{table:string;name:string;using_md5:string}[];functions:{signature:string;exists:boolean;execute_grants:Record<string,boolean>|null}[]};
const read=async(db:PGlite)=>(await db.query<{inventory:Inventory}>(sql)).rows[0].inventory;
describe('read-only finance catalog inventory',()=>{
 it('handles absent roles and relations without implying readiness',async()=>{const db=new PGlite();try{
  const x=await read(db);expect(x.missing_roles).toEqual(['anon','authenticated','service_role']);expect(x.missing_relations).toContain('payroll');
  expect(x.missing_or_different_columns).toContainEqual({table:'payroll',column:'gross_pay',expected_type:'numeric(10,2)',actual_type:null});
  expect(x.effective_table_grants).toEqual([]);expect(x.functions.find(f=>f.signature==='public.is_founder()')).toMatchObject({exists:false,execute_grants:null});
 }finally{await db.close();}},30000);
 it('reports mismatches, collisions, effective grants and selected metadata without returning or altering rows',async()=>{const db=new PGlite();try{
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE ROLE inherited_reader; GRANT inherited_reader TO authenticated;
   CREATE TABLE public.payroll(id uuid PRIMARY KEY, gross_pay numeric(12,2) NOT NULL DEFAULT 0,notes text,secret text);
   INSERT INTO public.payroll(id,gross_pay,secret) VALUES('10000000-0000-4000-8000-000000000001',9.25,'private-row-content');
   ALTER TABLE public.payroll ENABLE ROW LEVEL SECURITY; CREATE POLICY read_payroll ON public.payroll FOR SELECT TO authenticated USING(gross_pay>0);
   GRANT SELECT ON public.payroll TO inherited_reader; GRANT UPDATE(notes) ON public.payroll TO authenticated;
   CREATE TABLE public.weekly_worker_draft_sources(id uuid);
   CREATE FUNCTION public.is_founder() RETURNS boolean LANGUAGE sql AS $$SELECT false$$;
   REVOKE ALL ON FUNCTION public.is_founder() FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.is_founder() TO authenticated;
   CREATE FUNCTION public.audit_test() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$;
   CREATE TRIGGER inventory_test BEFORE UPDATE ON public.payroll FOR EACH ROW EXECUTE FUNCTION public.audit_test();`);
  const before=(await db.query('SELECT to_jsonb(p) p FROM public.payroll p')).rows;
  const x=await read(db);
  expect(x.missing_roles).toEqual([]);expect(x.candidate_relation_collisions).toEqual(['public.weekly_worker_draft_sources']);
  expect(x.missing_or_different_columns).toContainEqual({table:'payroll',column:'gross_pay',expected_type:'numeric(10,2)',actual_type:'numeric(12,2)'});
  expect(x.column_properties).toContainEqual(expect.objectContaining({table:'payroll',column:'gross_pay',not_null:true,has_default:true}));
  expect(x.effective_table_grants).toContainEqual(expect.objectContaining({table:'payroll',role:'authenticated',select:true,update:false}));
  expect(x.explicit_column_grants).toContainEqual(expect.objectContaining({table:'payroll',column:'notes'}));
  expect(x.constraints).toContainEqual(expect.objectContaining({table:'payroll',name:'payroll_pkey',definition_md5:expect.any(String)}));
  expect(x.triggers).toContainEqual(expect.objectContaining({table:'payroll',name:'inventory_test',function_body_md5:expect.any(String)}));
  expect(x.policies).toContainEqual(expect.objectContaining({table:'payroll',name:'read_payroll',using_md5:expect.any(String)}));
  expect(x.functions).toContainEqual(expect.objectContaining({signature:'public.is_founder()',exists:true,execute_grants:{anon:false,authenticated:true,service_role:false}}));
  expect(JSON.stringify(x)).not.toContain('private-row-content');expect((await db.query('SELECT to_jsonb(p) p FROM public.payroll p')).rows).toEqual(before);
 }finally{await db.close();}},30000);
});
