import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
const sql=readFileSync('supabase/release/development-service-paid-evidence-writers.sql','utf8');
const tables=['payroll_payment_dates','weekly_worker_paid_allocations'];
async function setup(){const db=new PGlite();await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;
 ${tables.map(t=>`CREATE TABLE public.${t}(id integer PRIMARY KEY);ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY;GRANT SELECT,INSERT,UPDATE,DELETE ON public.${t} TO service_role;GRANT SELECT ON public.${t} TO authenticated;`).join('\n')}
 CREATE FUNCTION public.weekly_payment_date_internal(uuid,date) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$INSERT INTO public.payroll_payment_dates VALUES(1)$$;
 CREATE FUNCTION public.weekly_worker_payment_internal(uuid,date) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$INSERT INTO public.weekly_worker_paid_allocations VALUES(1)$$;
 CREATE FUNCTION public.record_weekly_worker_payment(uuid,date,bigint) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$SELECT public.weekly_payment_date_internal($1,$2),public.weekly_worker_payment_internal($1,$2)$$;
 REVOKE ALL ON FUNCTION public.weekly_payment_date_internal(uuid,date),public.weekly_worker_payment_internal(uuid,date),public.record_weekly_worker_payment(uuid,date,bigint) FROM PUBLIC,anon,authenticated,service_role;
 GRANT EXECUTE ON FUNCTION public.record_weekly_worker_payment(uuid,date,bigint) TO authenticated;`);return db;}
describe('paid evidence direct writer hardening',()=>{
 it('blocks service direct DML and preserves an owner-definer payment path',async()=>{const db=await setup();try{
  await db.exec(`BEGIN;${sql} COMMIT; SET ROLE service_role`);
  for(const t of tables){await expect(db.exec(`INSERT INTO public.${t} VALUES(9)`)).rejects.toThrow(/permission denied/);await expect(db.exec(`UPDATE public.${t} SET id=9`)).rejects.toThrow(/permission denied/);await expect(db.exec(`DELETE FROM public.${t}`)).rejects.toThrow(/permission denied/);expect((await db.query(`SELECT * FROM public.${t}`)).rows).toEqual([]);}
  await db.exec("RESET ROLE;SET ROLE authenticated;SELECT public.record_weekly_worker_payment('00000000-0000-0000-0000-000000000001','2024-01-01',0);RESET ROLE");
  for(const t of tables)expect((await db.query(`SELECT * FROM public.${t}`)).rows).toEqual([{id:1}]);
 }finally{await db.close();}},30000);
 it('refuses drift and rolls back revocations',async()=>{for(const change of ["GRANT INSERT ON public.payroll_payment_dates TO authenticated","GRANT UPDATE(id) ON public.payroll_payment_dates TO service_role","GRANT EXECUTE ON FUNCTION public.weekly_payment_date_internal(uuid,date) TO service_role","ALTER TABLE public.payroll_payment_dates DISABLE ROW LEVEL SECURITY"]){const db=await setup();try{await db.exec(change);await expect(db.exec(`BEGIN;${sql} COMMIT;`)).rejects.toThrow(/changed/);await db.exec('ROLLBACK');expect((await db.query("SELECT has_table_privilege('service_role','public.weekly_worker_paid_allocations','INSERT') allowed")).rows[0]).toEqual({allowed:true});}finally{await db.close();}}
  const db=await setup();try{await db.exec(`BEGIN;${sql} ROLLBACK;`);expect((await db.query("SELECT has_table_privilege('service_role','public.payroll_payment_dates','DELETE') allowed")).rows[0]).toEqual({allowed:true});}finally{await db.close();}
 },30000);
});
