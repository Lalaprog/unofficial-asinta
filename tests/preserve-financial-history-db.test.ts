import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
const sql=readFileSync('supabase/migrations/20261114000000_preserve_financial_history.sql','utf8');
async function fixture(){
 const db=new PGlite();
 await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
 CREATE TABLE public.payroll(id int primary key,status text,amount numeric); CREATE TABLE public.advances(id int primary key,status text,amount numeric);
 INSERT INTO public.payroll VALUES (1,'paid',123.45),(2,'draft',500); INSERT INTO public.advances VALUES (1,'fully_deducted',12.34);
 ALTER TABLE public.payroll ENABLE ROW LEVEL SECURITY; ALTER TABLE public.advances ENABLE ROW LEVEL SECURITY;
 CREATE POLICY founder_payroll ON public.payroll FOR ALL TO authenticated USING (true) WITH CHECK (true);
 CREATE POLICY founder_advances ON public.advances FOR ALL TO authenticated USING (true) WITH CHECK (true);
 GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role;
 GRANT SELECT,INSERT,UPDATE,DELETE ON public.payroll,public.advances TO anon,authenticated,service_role;`);
 return db;
}
describe('financial history deletion guard',()=>{
 it('removes only client DELETE, preserves rows, other grants, RLS and service access',async()=>{
  const db=await fixture();try{
   await db.exec(`BEGIN; SET ROLE authenticated; DELETE FROM public.payroll WHERE id=1; ROLLBACK;`);
   await db.exec(sql);
   const grants=await db.query<{role:string;del:boolean;sel:boolean;ins:boolean;upd:boolean}>(`SELECT role,has_table_privilege(role,'public.payroll','DELETE') del,has_table_privilege(role,'public.payroll','SELECT') sel,has_table_privilege(role,'public.payroll','INSERT') ins,has_table_privilege(role,'public.payroll','UPDATE') upd FROM unnest(ARRAY['anon','authenticated','service_role']) role ORDER BY role`);
   expect(grants.rows).toEqual([{role:'anon',del:false,sel:true,ins:true,upd:true},{role:'authenticated',del:false,sel:true,ins:true,upd:true},{role:'service_role',del:true,sel:true,ins:true,upd:true}]);
   await db.exec('SET ROLE authenticated');
   for(const table of ['payroll','advances'])await expect(db.exec(`DELETE FROM public.${table}`)).rejects.toThrow(/permission denied/);
   expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.payroll')).rows[0].n).toBe(2);
   expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.advances')).rows[0].n).toBe(1);
   await db.exec('RESET ROLE; SET ROLE service_role');
   expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.payroll')).rows[0].n).toBe(2);
  }finally{await db.close();}
 },30000);
 it('fails closed and rolls back if role inheritance preserves a DELETE grant',async()=>{
  const db=await fixture();try{
   await db.exec('CREATE ROLE inherited; GRANT inherited TO authenticated; GRANT DELETE ON public.advances TO inherited;');
   await expect(db.exec(`BEGIN; ${sql} COMMIT;`)).rejects.toThrow(/Inherited DELETE grant remains/);
   await db.exec('ROLLBACK;');
   expect((await db.query<{del:boolean}>("SELECT has_table_privilege('authenticated','public.payroll','DELETE') del")).rows[0].del).toBe(true);
   expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.payroll')).rows[0].n).toBe(2);
  }finally{await db.close();}
 },30000);
 it('fails and rolls back if revoking client access would change the service role',async()=>{
  const db=await fixture();try{
   await db.exec('REVOKE DELETE ON public.payroll,public.advances FROM service_role; GRANT authenticated TO service_role;');
   await expect(db.exec(`BEGIN; ${sql} COMMIT;`)).rejects.toThrow(/Service DELETE privilege would change/);
   await db.exec('ROLLBACK;');
   expect((await db.query<{del:boolean}>("SELECT has_table_privilege('service_role','public.payroll','DELETE') del")).rows[0].del).toBe(true);
  }finally{await db.close();}
 },30000);
});
