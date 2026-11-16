import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {describe,expect,it} from 'vitest';
const sql=readFileSync('supabase/release/development-anon-workforce-finance-privileges.sql','utf8');
const tables=['advance_requests','advances','attendance','payroll'];
async function setup(){const db=new PGlite();await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;
 CREATE FUNCTION public.is_founder() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT current_setting('test.founder',true)='yes'$$;
 CREATE FUNCTION public.session_assurance_satisfied() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT current_setting('test.assurance',true)='yes'$$;`);
 for(const table of tables)await db.exec(`CREATE TABLE public.${table}(id integer PRIMARY KEY,amount integer);INSERT INTO public.${table} VALUES(1,50);ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;
 CREATE POLICY founder ON public.${table} FOR ALL TO authenticated USING (public.is_founder()) WITH CHECK (public.is_founder());
 CREATE POLICY assurance ON public.${table} AS RESTRICTIVE FOR ALL TO authenticated USING (public.session_assurance_satisfied()) WITH CHECK (public.session_assurance_satisfied());
 GRANT SELECT,INSERT,UPDATE,DELETE,REFERENCES,TRIGGER,MAINTAIN ON public.${table} TO anon;
 GRANT SELECT ON public.${table} TO authenticated,service_role;GRANT UPDATE(amount) ON public.${table} TO authenticated;`);
 return db;}
async function apply(db:PGlite){await db.exec(`BEGIN;${sql} COMMIT;`);}
describe('development anonymous finance and attendance grants',()=>{
 it('pins the installed development artifact',()=>{expect(createHash('sha256').update(sql).digest('hex')).toBe('97856e8c525f999c9dcabf8edeaa8bba378e919a5baf9a3fc8d094eb2bec5604');});
 it('removes anonymous table and column access without changing authenticated column privileges or rows',async()=>{const db=await setup();try{
  await db.exec('SET ROLE anon');for(const t of tables)expect((await db.query(`SELECT * FROM public.${t}`)).rows).toEqual([]);await db.exec('RESET ROLE');await apply(db);
  for(const t of tables){for(const p of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'])expect((await db.query<{ok:boolean}>('SELECT has_table_privilege(\'anon\',$1,$2) ok',[`public.${t}`,p])).rows[0].ok).toBe(false);
   expect((await db.query<{ok:boolean}>(`SELECT has_column_privilege('authenticated','public.${t}','amount','UPDATE') ok`)).rows[0].ok).toBe(true);}
  await db.exec('SET ROLE anon');for(const t of tables)await expect(db.query(`SELECT * FROM public.${t}`)).rejects.toThrow(/permission denied/);await db.exec('RESET ROLE');
  await db.exec("SET ROLE authenticated;SET test.founder='yes';SET test.assurance='yes'");for(const t of tables){expect((await db.query(`SELECT * FROM public.${t}`)).rows).toEqual([{id:1,amount:50}]);await db.exec(`UPDATE public.${t} SET amount=60 WHERE id=1`);}await db.exec("SET test.assurance='no'");for(const t of tables)expect((await db.query(`SELECT * FROM public.${t}`)).rows).toEqual([]);await db.exec('RESET ROLE');
 }finally{await db.close();}},30000);
 it('rolls back the exact artifact',async()=>{const db=await setup();try{await db.exec(`BEGIN;${sql} ROLLBACK;`);for(const t of tables)expect((await db.query<{ok:boolean}>('SELECT has_table_privilege(\'anon\',$1,\'SELECT\') ok',[`public.${t}`])).rows[0].ok).toBe(true);}finally{await db.close();}},30000);
 it('fails closed on public policies, explicit anonymous columns, public grants or role inheritance',async()=>{for(const drift of ['CREATE POLICY extra ON public.payroll FOR SELECT TO PUBLIC USING (true)','GRANT SELECT(amount) ON public.payroll TO anon','GRANT SELECT ON public.payroll TO PUBLIC','GRANT anon TO authenticated']){const db=await setup();try{await db.exec(drift);await expect(apply(db)).rejects.toThrow();await db.exec('ROLLBACK');expect((await db.query("SELECT has_table_privilege('anon','public.payroll','SELECT') ok")).rows[0]).toEqual({ok:true});}finally{await db.close();}}},30000);
});
