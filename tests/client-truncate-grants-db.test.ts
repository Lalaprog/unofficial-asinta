import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
const names=['advance_requests','advances','attendance','audit_log','clients','email_logs','email_templates','expense_drafts','expenses','invoices','payroll','project_supervisors','projects','reminder_dispatches','sms_logs','tools','users','vendor_memory','workers'];
const migration=readFileSync('supabase/migrations/20261112000006_revoke_client_truncate.sql','utf8');
let db:PGlite;
beforeEach(async()=>{
 db=new PGlite();
 await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
 ${names.map(n=>`CREATE TABLE public.${n}(id int); INSERT INTO public.${n} VALUES (1); ALTER TABLE public.${n} ENABLE ROW LEVEL SECURITY;`).join('\n')}
 GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE ON ALL TABLES IN SCHEMA public TO anon,authenticated,service_role;`);
},30000);
afterEach(async()=>{await db.close()});
describe('client truncate privilege hardening',()=>{
 it('removes truncate but preserves other privileges, service access, and all rows',async()=>{
  await db.exec(migration);
  for(const name of names){
   const result=await db.query<{anon_truncate:boolean;auth_truncate:boolean;auth_select:boolean;service_truncate:boolean;rows:number}>(`SELECT has_table_privilege('anon','public.${name}','TRUNCATE') AS anon_truncate,has_table_privilege('authenticated','public.${name}','TRUNCATE') AS auth_truncate,has_table_privilege('authenticated','public.${name}','SELECT') AS auth_select,has_table_privilege('service_role','public.${name}','TRUNCATE') AS service_truncate,(SELECT count(*)::int FROM public.${name}) AS rows`);
   expect(result.rows[0]).toEqual({anon_truncate:false,auth_truncate:false,auth_select:true,service_truncate:true,rows:1});
  }
  await db.exec('SET ROLE authenticated');await expect(db.exec('TRUNCATE public.attendance')).rejects.toThrow(/permission denied/);
 });
 it('fails closed and rolls back if an inherited public grant still grants truncate',async()=>{
  await db.exec('GRANT TRUNCATE ON public.expenses TO PUBLIC');
  await expect(db.exec(migration)).rejects.toThrow(/Inherited TRUNCATE grant remains/);
  const data=await db.query<{allowed:boolean}>("SELECT has_table_privilege('authenticated','public.attendance','TRUNCATE') AS allowed");expect(data.rows[0].allowed).toBe(true);
 });
});
