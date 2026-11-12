import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {baseFixture} from './helpers/pr103-fixture';
import {buildSupervisorPreview,parseSupervisorCatalog,parseSupervisorPreview} from '@/lib/payroll/supervisorPreview';
const read=(f:string)=>readFileSync(`supabase/drafts/${f}.sql`,'utf8');
const founder='00000000-0000-0000-0000-000000000001',sup='00000000-0000-0000-0000-000000000002',entry='00000000-0000-0000-0000-000000000090';
describe('uninstalled Supervisor payroll planning SQL',()=>{
 it('rejects missing rollout, scopes reads to Founder and returns matching half-month inputs without finance writes',async()=>{
  const db=new PGlite();try{
   await db.exec(baseFixture);await db.exec(`BEGIN; ${read('supervisor_table_foundation')} COMMIT;`);
   await expect(db.exec(`BEGIN; ${read('supervisor_payroll_preview')} COMMIT;`)).rejects.toThrow(/prerequisites missing/);await db.exec('ROLLBACK');
   await db.exec(`BEGIN; ${read('supervisor_rpc_rollout')} COMMIT;`);
   await db.exec(`INSERT INTO public.workers VALUES ('${sup}','Supervisor','Supervisor','none',600,'daily',true); INSERT INTO public.project_supervisors VALUES ('00000000-0000-0000-0000-000000000005','${sup}')`);
   const before=(await db.query('SELECT (SELECT count(*) FROM public.payroll) payroll,(SELECT count(*) FROM public.attendance) attendance,(SELECT count(*) FROM public.advances) advances')).rows[0];
   await db.exec(`BEGIN; ${read('supervisor_payroll_preview')} COMMIT;`);
   await expect(db.exec(`BEGIN; ${read('supervisor_payroll_preview')} COMMIT;`)).rejects.toThrow(/already exist/);await db.exec('ROLLBACK');
   await db.exec(`SET test.uid='${sup}'; SET test.assurance='yes'; SET ROLE authenticated`);
   await expect(db.query('SELECT public.supervisor_payroll_preview_catalog()')).rejects.toThrow(/Founder access/);
   await expect(db.query("SELECT public.supervisor_payroll_preview_inputs($1,'2024-02-16')",[sup])).rejects.toThrow(/Founder access/);
   await db.query("SELECT public.submit_supervisor_day($1,'2024-02-16','half_day')",[entry]);
   await db.exec(`SET test.uid='${founder}'`);await db.query("SELECT public.review_supervisor_day($1,'approved')",[entry]);
   const catalog=(await db.query<{v:unknown}>('SELECT public.supervisor_payroll_preview_catalog() v')).rows[0].v;expect(parseSupervisorCatalog(catalog)).toEqual([{id:sup,name:'Supervisor'}]);
   const call=async(start:string)=>(await db.query<{v:unknown}>('SELECT public.supervisor_payroll_preview_inputs($1,$2) v',[sup,start])).rows[0].v;
   const input=parseSupervisorPreview(await call('2024-02-16'),sup,'2024-02-16');expect(input.end).toBe('2024-02-29');expect(buildSupervisorPreview(input,'655.55','2024-02-29').gross).toBe('327.78');
   expect(parseSupervisorPreview(await call('2023-02-16'),sup,'2023-02-16').end).toBe('2023-02-28');expect(parseSupervisorPreview(await call('2026-12-16'),sup,'2026-12-16').end).toBe('2026-12-31');
   await expect(call('2024-02-15')).rejects.toThrow(/Invalid Supervisor period/);await db.exec("SET test.assurance='no'");await expect(call('2024-02-16')).rejects.toThrow(/Founder access/);
   await db.exec('RESET ROLE; SET ROLE anon');await expect(db.query('SELECT public.supervisor_payroll_preview_catalog()')).rejects.toThrow(/permission denied/);await db.exec('RESET ROLE');
   expect((await db.query('SELECT (SELECT count(*) FROM public.payroll) payroll,(SELECT count(*) FROM public.attendance) attendance,(SELECT count(*) FROM public.advances) advances')).rows[0]).toEqual(before);
  }finally{await db.close();}
 },30000);
 it('fails closed on schema drift and direct client privileges',async()=>{
  const db=new PGlite();try{
   await db.exec(baseFixture);await db.exec(`BEGIN; ${read('supervisor_table_foundation')} COMMIT;`);await db.exec(`BEGIN; ${read('supervisor_rpc_rollout')} COMMIT;`);
   await db.exec('ALTER TABLE public.payroll ALTER COLUMN period_start TYPE text USING period_start::text');
   await expect(db.exec(`BEGIN; ${read('supervisor_payroll_preview')} COMMIT;`)).rejects.toThrow(/prerequisite columns.*payroll.period_start/);await db.exec('ROLLBACK');
   await db.exec('ALTER TABLE public.payroll ALTER COLUMN period_start TYPE date USING period_start::date; GRANT SELECT ON public.supervisor_daily_attendance TO authenticated');
   await expect(db.exec(`BEGIN; ${read('supervisor_payroll_preview')} COMMIT;`)).rejects.toThrow(/Unexpected Supervisor table privileges/);await db.exec('ROLLBACK');
   expect((await db.query<{absent:boolean}>("SELECT to_regprocedure('public.supervisor_payroll_preview_catalog()') IS NULL absent")).rows[0].absent).toBe(true);
  }finally{await db.close();}
 },30000);
 it('flags same-name ambiguity, site records, and overlapping vouchers without treating them as verified links',async()=>{
  const db=new PGlite();try{
   await db.exec(baseFixture);await db.exec(`BEGIN; ${read('supervisor_table_foundation')} COMMIT;`);await db.exec(`BEGIN; ${read('supervisor_rpc_rollout')} COMMIT;`);await db.exec(`BEGIN; ${read('supervisor_payroll_preview')} COMMIT;`);
   await db.exec(`UPDATE public.workers SET name='Supervisor'; SET test.uid='${founder}'; SET test.assurance='yes'; SET ROLE authenticated`);
   const raw=(await db.query<{v:unknown}>("SELECT public.supervisor_payroll_preview_inputs($1,'2026-10-16') v",[sup])).rows[0].v;
   const value=parseSupervisorPreview(raw,sup,'2026-10-16');expect(value).toMatchObject({identity_needs_review:true,legacy_count:1,overlapping_vouchers:1});
   expect(buildSupervisorPreview(value,'600','2026-10-30').gross).toBeNull();
  }finally{await db.close();}
 },30000);
});
