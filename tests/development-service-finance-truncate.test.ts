import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
const sql=readFileSync('supabase/release/development-service-finance-truncate.sql','utf8');
const tables=['expenses','payroll_payment_dates','weekly_worker_paid_allocations'];
async function setup(){const db=new PGlite();await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;
 ${tables.map(t=>`CREATE TABLE public.${t}(id integer PRIMARY KEY);INSERT INTO public.${t} VALUES(1);ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY;GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE ON public.${t} TO service_role;`).join('\n')}`);return db;}
describe('targeted service finance TRUNCATE hardening',()=>{
 it('denies destructive truncate while preserving service DML, other grants and rows',async()=>{const db=await setup();try{
  await db.exec('GRANT SELECT,INSERT ON public.expenses TO authenticated');await db.exec(`BEGIN;${sql} COMMIT;`);
  for(const t of tables){
   for(const p of ['SELECT','INSERT','UPDATE','DELETE'])expect((await db.query<{allowed:boolean}>('SELECT has_table_privilege($1,$2,$3) allowed',['service_role',`public.${t}`,p])).rows[0].allowed).toBe(true);
   for(const role of ['anon','authenticated','service_role'])expect((await db.query<{allowed:boolean}>('SELECT has_table_privilege($1,$2,$3) allowed',[role,`public.${t}`,'TRUNCATE'])).rows[0].allowed).toBe(false);
   expect((await db.query(`SELECT * FROM public.${t}`)).rows).toEqual([{id:1}]);
   await db.exec('SET ROLE service_role');await expect(db.exec(`TRUNCATE public.${t}`)).rejects.toThrow(/permission denied/);await db.exec(`INSERT INTO public.${t} VALUES(2); UPDATE public.${t} SET id=3 WHERE id=2; DELETE FROM public.${t} WHERE id=3; RESET ROLE`);
  }
  expect((await db.query("SELECT has_table_privilege('authenticated','public.expenses','INSERT') allowed")).rows[0]).toEqual({allowed:true});
 }finally{await db.close();}},30000);
 it('rolls back rehearsal and refuses changed role, missing DML or ownership/RLS',async()=>{
  for(const drift of ["GRANT TRUNCATE ON public.expenses TO authenticated","REVOKE UPDATE ON public.expenses FROM service_role","ALTER TABLE public.expenses DISABLE ROW LEVEL SECURITY","GRANT TRUNCATE ON public.expenses TO PUBLIC"]){const db=await setup();try{
   await db.exec(drift);await expect(db.exec(`BEGIN;${sql} COMMIT;`)).rejects.toThrow(/changed/);await db.exec('ROLLBACK');
   expect((await db.query("SELECT has_table_privilege('service_role','public.payroll_payment_dates','TRUNCATE') allowed")).rows[0]).toEqual({allowed:true});
  }finally{await db.close();}}
  const db=await setup();try{await db.exec(`BEGIN;${sql} ROLLBACK;`);expect((await db.query("SELECT has_table_privilege('service_role','public.expenses','TRUNCATE') allowed")).rows[0]).toEqual({allowed:true});}finally{await db.close();}
 },30000);
});
