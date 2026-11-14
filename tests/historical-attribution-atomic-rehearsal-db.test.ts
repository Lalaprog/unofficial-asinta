// Isolated synthetic PGlite only: this bundle is held and is not an installer.
import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {describe,expect,it} from 'vitest';
import {baseFixture} from './helpers/pr103-fixture';
const founder='00000000-0000-0000-0000-000000000001',worker='00000000-0000-0000-0000-000000000003',site='00000000-0000-0000-0000-000000000004';
const id=(n:number)=>`84000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const sql=(name:string)=>readFileSync(`supabase/drafts/${name}.sql`,'utf8');
const bundle=()=>sql('historical_attribution_atomic_rehearsal');
async function fixture(){
 const db=new PGlite();await db.exec(baseFixture);
 for(const name of ['supervisor_table_foundation','supervisor_rpc_rollout','supervisor_payroll_preview','historical_external_worker_payroll','supervisor_payroll_ledger','paid_period_assertion_adjustments','historical_worker_project_attribution'])await db.exec(`BEGIN;${sql(name)} COMMIT;`);
 await db.exec(`SET ROLE authenticated;SET test.uid='${founder}';SET test.assurance='yes'`);
 const w=(await db.query<{v:{worker:unknown}}>("SELECT public.historical_external_worker_review($1,'2024-11-03') v",[worker])).rows[0].v.worker;
 await db.query("SELECT public.record_historical_external_worker_payroll($1,$2,'2024-11-03','2024-11-09',600,100,0,500,'Ledger',$3,true)",[id(1),worker,JSON.stringify(w)]);
 const source=(await db.query<{v:unknown}>('SELECT public.historical_external_worker_lookup($1) v',[id(1)])).rows[0].v;
 return {db,source};
}
const split=[{project_id:site,gross:'600.00'}];
const oldSql='SELECT public.record_historical_worker_attribution($1,$2,$3::jsonb,$4::jsonb,$5,true) v';
const newSql='SELECT public.record_historical_attribution_with_cases($1,$2,$3::jsonb,$4::jsonb,$5,true,$6::jsonb) v';
const install=(db:PGlite)=>db.exec(`BEGIN;SET LOCAL app.historical_case_atomic_rehearsal='synthetic-only';${bundle()} COMMIT;`);
describe('held atomic historical cutover rehearsal',()=>{
 it('is reproducibly generated from pinned sources',()=>{execFileSync('node',['scripts/build-historical-case-cutover-rehearsal.mjs','--check']);});
 it('holds without explicit synthetic mode',async()=>{const {db}=await fixture();try{await db.exec('RESET ROLE');await expect(db.exec(`BEGIN;${bundle()} COMMIT;`)).rejects.toThrow(/synthetic rehearsal only/);await db.exec('ROLLBACK');expect((await db.query<{v:string|null}>("SELECT to_regclass('public.historical_attribution_case_bindings')::text v")).rows[0].v).toBeNull();}finally{await db.close();}},30000);
 it('aborts and preserves old access and evidence when a prior unbound split exists',async()=>{const {db,source}=await fixture();try{
  await db.query(oldSql,[id(2),id(1),JSON.stringify(source),JSON.stringify(split),'Reviewed']);await db.exec('RESET ROLE');await expect(install(db)).rejects.toThrow(/unbound historical attribution/);await db.exec('ROLLBACK');
  expect((await db.query<{v:boolean}>("SELECT has_function_privilege('authenticated','public.record_historical_worker_attribution(uuid,uuid,jsonb,jsonb,text,boolean)','EXECUTE') v")).rows[0].v).toBe(true);
  expect((await db.query<{v:string|null}>("SELECT to_regclass('public.historical_attribution_case_bindings')::text v")).rows[0].v).toBeNull();
  expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.historical_worker_attributions')).rows[0].n).toBe(1);
 }finally{await db.close();}},30000);
 it('installs both held candidates atomically and accepts only a case-bound split',async()=>{const {db,source}=await fixture();try{
  await db.exec('RESET ROLE');await install(db);await db.exec('SET ROLE authenticated');
  await expect(db.query(oldSql,[id(2),id(1),JSON.stringify(source),JSON.stringify(split),'Reviewed'])).rejects.toThrow(/permission denied/);
  const cases=(await db.query<{v:unknown}>("SELECT public.paid_period_assertion_case_list('external_worker',$1) v",[id(1)])).rows[0].v;
  expect((await db.query<{v:{replayed:boolean}}>(newSql,[id(2),id(1),JSON.stringify(source),JSON.stringify(split),'Reviewed',JSON.stringify(cases)])).rows[0].v.replayed).toBe(false);
  expect((await db.query<{v:{replayed:boolean}}>(newSql,[id(2),id(1),JSON.stringify(source),JSON.stringify(split),'Reviewed',JSON.stringify(cases)])).rows[0].v.replayed).toBe(true);
  await db.exec('RESET ROLE');for(const [table,n] of [['historical_worker_attributions',1],['historical_attribution_case_bindings',1],['historical_attribution_write_permits',0]] as const)expect((await db.query<{n:number}>(`SELECT count(*)::int n FROM public.${table}`)).rows[0].n).toBe(n);
 }finally{await db.close();}},30000);
 it('rolls back the complete bundle and old ACL when inherited permit access is detected',async()=>{const {db}=await fixture();try{
  await db.exec('RESET ROLE;CREATE ROLE bundle_inherited_reader;GRANT bundle_inherited_reader TO service_role;ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO bundle_inherited_reader');
  await expect(install(db)).rejects.toThrow(/Unexpected case-binding table privilege|Unexpected historical barrier privilege/);await db.exec('ROLLBACK');
  expect((await db.query<{v:string|null}>("SELECT to_regclass('public.historical_attribution_case_bindings')::text v")).rows[0].v).toBeNull();
  expect((await db.query<{v:boolean}>("SELECT has_function_privilege('authenticated','public.record_historical_worker_attribution(uuid,uuid,jsonb,jsonb,text,boolean)','EXECUTE') v")).rows[0].v).toBe(true);
 }finally{await db.close();}},30000);
});
