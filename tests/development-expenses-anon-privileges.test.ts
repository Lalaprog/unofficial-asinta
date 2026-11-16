import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {describe,expect,it} from 'vitest';
const release=readFileSync('supabase/release/development-expenses-anon-privileges.sql','utf8');
async function setup(){const db=new PGlite();await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;
 CREATE FUNCTION public.is_founder() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT current_setting('test.founder',true)='yes'$$;
 CREATE FUNCTION public.session_assurance_satisfied() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT current_setting('test.assurance',true)='yes'$$;
 CREATE TABLE public.expenses(id integer PRIMARY KEY,amount integer);INSERT INTO public.expenses VALUES(1,50);ALTER TABLE public.expenses ENABLE ROW LEVEL SECURITY;
 CREATE POLICY "Founders full access to expenses" ON public.expenses AS PERMISSIVE FOR ALL TO authenticated USING (is_founder());
 CREATE POLICY mfa_session_required ON public.expenses AS RESTRICTIVE FOR ALL TO authenticated USING ((SELECT session_assurance_satisfied())) WITH CHECK ((SELECT session_assurance_satisfied()));
 GRANT SELECT,INSERT,UPDATE,DELETE,REFERENCES,TRIGGER,MAINTAIN ON public.expenses TO anon;
 GRANT SELECT,INSERT,UPDATE,DELETE ON public.expenses TO authenticated,service_role;`);return db;}
async function apply(db:PGlite){await db.exec(`BEGIN;${release} COMMIT;`);}
describe('development expense anonymous privilege hardening',()=>{
 it('pins the reviewed development artifact',()=>{expect(createHash('sha256').update(release).digest('hex')).toBe('34384d88b7fc5285d7c4cf386f820fa70d51134605eba3c5a7437085b1bfe10f');});
 it('removes only anonymous grants and preserves Founder/assurance access',async()=>{const db=await setup();try{
  await db.exec('SET ROLE anon');expect((await db.query('SELECT * FROM public.expenses')).rows).toEqual([]);await db.exec('RESET ROLE');
  await apply(db);
  for(const priv of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'])expect((await db.query<{allowed:boolean}>('SELECT has_table_privilege(\'anon\',\'public.expenses\',$1) allowed',[priv])).rows[0].allowed).toBe(false);
  await db.exec('SET ROLE anon');await expect(db.query('SELECT * FROM public.expenses')).rejects.toThrow(/permission denied/);await db.exec('RESET ROLE');
  await db.exec("SET ROLE authenticated;SET test.founder='yes';SET test.assurance='yes'");expect((await db.query('SELECT * FROM public.expenses')).rows).toEqual([{id:1,amount:50}]);await db.exec('INSERT INTO public.expenses VALUES(2,75)');
  await db.exec("SET test.assurance='no'");expect((await db.query('SELECT * FROM public.expenses')).rows).toEqual([]);await expect(db.exec('INSERT INTO public.expenses VALUES(3,10)')).rejects.toThrow(/row-level security/);
  await db.exec("SET test.assurance='yes';SET test.founder='no'");expect((await db.query('SELECT * FROM public.expenses')).rows).toEqual([]);await db.exec('RESET ROLE');
  expect((await db.query('SELECT count(*)::int n FROM public.expenses')).rows[0]).toEqual({n:2});
 }finally{await db.close();}},30000);
 it('rolls back completely and refuses changed RLS, column, or PUBLIC grants',async()=>{for(const drift of ["CREATE POLICY anon_extra ON public.expenses FOR SELECT TO anon USING (true)","GRANT SELECT(amount) ON public.expenses TO anon","GRANT SELECT ON public.expenses TO PUBLIC"]){const db=await setup();try{
  await db.exec(drift);await expect(apply(db)).rejects.toThrow(/policies changed|column or PUBLIC/);await db.exec('ROLLBACK');expect((await db.query("SELECT has_table_privilege('anon','public.expenses','MAINTAIN') allowed")).rows[0]).toEqual({allowed:true});
 }finally{await db.close();}}},30000);
 it('can be rehearsed and rolled back without leaving grants changed',async()=>{const db=await setup();try{
  await db.exec(`BEGIN;${release} ROLLBACK;`);expect((await db.query("SELECT has_table_privilege('anon','public.expenses','MAINTAIN') allowed")).rows[0]).toEqual({allowed:true});
 }finally{await db.close();}},30000);
});
