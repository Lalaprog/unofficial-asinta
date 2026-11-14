// Isolated synthetic schema only. Candidate remains held and uninstalled.
import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {baseFixture} from './helpers/pr103-fixture';
const sql=(name:string)=>readFileSync(`supabase/drafts/${name}.sql`,'utf8');
const founder='00000000-0000-0000-0000-000000000001',supervisor='00000000-0000-0000-0000-000000000002',worker='00000000-0000-0000-0000-000000000003',site='00000000-0000-0000-0000-000000000004';
const id=(n:number)=>`82000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const record="SELECT public.record_historical_attribution_with_cases($1,$2,$3::jsonb,$4::jsonb,$5,$6,$7::jsonb) v";
const original="SELECT public.record_historical_worker_attribution($1,$2,$3::jsonb,$4::jsonb,$5,$6) v";
const split=[{project_id:site,gross:'600.00'}];
async function setup(){
 const db=new PGlite();await db.exec(baseFixture);
 for(const n of ['supervisor_table_foundation','supervisor_rpc_rollout','supervisor_payroll_preview','historical_external_worker_payroll','supervisor_payroll_ledger','paid_period_assertion_adjustments','historical_worker_project_attribution'])await db.exec(`BEGIN;${sql(n)} COMMIT;`);
 await db.exec(`BEGIN;SET LOCAL app.historical_case_binding_candidate='synthetic-only';${sql('historical_attribution_case_binding')} COMMIT;`);
 await db.exec(`SET ROLE authenticated;SET test.uid='${founder}';SET test.assurance='yes'`);
 const review=(await db.query<{v:{worker:unknown}}>("SELECT public.historical_external_worker_review($1,'2024-11-03') v",[worker])).rows[0].v;
 await db.query("SELECT public.record_historical_external_worker_payroll($1,$2,'2024-11-03','2024-11-09',600,100,0,500,'Original ledger',$3,true)",[id(1),worker,JSON.stringify(review.worker)]);
 const source=(await db.query<{v:unknown}>('SELECT public.historical_external_worker_lookup($1) v',[id(1)])).rows[0].v;
 const cases=async()=>(await db.query<{v:{snapshot:unknown;total:number;items:unknown[]}}>("SELECT public.paid_period_assertion_case_list('external_worker',$1) v",[id(1)])).rows[0].v;
 const run=(request:string,inventory:unknown,overrides?:{source?:unknown;split?:unknown;note?:string;ack?:boolean})=>db.query<{v:{replayed:boolean}}>(record,[request,id(1),JSON.stringify(overrides?.source??source),JSON.stringify(overrides?.split??split),overrides?.note??'Reviewed',overrides?.ack??true,JSON.stringify(inventory)]);
 return {db,source,cases,run};
}

describe('historical attribution case-binding held candidate',()=>{
 it('requires the explicit synthetic hold bypass',async()=>{
  const db=new PGlite();try{await expect(db.exec(`BEGIN;${sql('historical_attribution_case_binding')} COMMIT;`)).rejects.toThrow(/synthetic rehearsal only/);}finally{await db.close();}
 });
 it('rolls back candidate installation if inherited grants expose the evidence table',async()=>{
  const db=new PGlite();try{
   await db.exec(baseFixture);
   for(const n of ['supervisor_table_foundation','supervisor_rpc_rollout','supervisor_payroll_preview','historical_external_worker_payroll','supervisor_payroll_ledger','paid_period_assertion_adjustments','historical_worker_project_attribution'])await db.exec(`BEGIN;${sql(n)} COMMIT;`);
   await db.exec('CREATE ROLE inherited_case_reader;GRANT inherited_case_reader TO service_role;ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO inherited_case_reader');
   await expect(db.exec(`BEGIN;SET LOCAL app.historical_case_binding_candidate='synthetic-only';${sql('historical_attribution_case_binding')} COMMIT;`)).rejects.toThrow(/Unexpected case-binding table privilege/);
   await db.exec('ROLLBACK');expect((await db.query<{v:string|null}>("SELECT to_regclass('public.historical_attribution_case_bindings')::text v")).rows[0].v).toBeNull();
  }finally{await db.close();}
 },30000);
 it('binds reviewed cases, marks later changes, and retries the exact evidence without another write',async()=>{
  const {db,cases,run}=await setup();try{
   const reviewed=await cases();expect(reviewed.total).toBe(0);
   expect((await run(id(2),reviewed)).rows[0].v.replayed).toBe(false);
   let read=(await db.query<{v:any}>('SELECT public.historical_attribution_case_binding($1) v',[id(1)])).rows[0].v;
   expect(read).toMatchObject({found:true,request_id:id(2),cases_changed:false,source_changed:false,reviewed_cases:reviewed});
   await db.query("SELECT public.open_paid_period_assertion_case($1,'external_worker',$2,$3::jsonb,30,'New case')",[id(3),id(1),JSON.stringify(reviewed.snapshot)]);
   read=(await db.query<{v:any}>('SELECT public.historical_attribution_case_binding($1) v',[id(1)])).rows[0].v;expect(read.cases_changed).toBe(true);
   expect((await run(id(2),reviewed)).rows[0].v.replayed).toBe(true);
   await expect(run(id(2),await cases())).rejects.toThrow(/different details/);
   await expect(run(id(2),reviewed,{note:'Changed'})).rejects.toThrow(/different details/);
   await db.exec('RESET ROLE');
   expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.historical_attribution_case_bindings')).rows[0].n).toBe(1);
   expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.historical_worker_attributions')).rows[0].n).toBe(1);
   await expect(db.exec('DELETE FROM public.historical_attribution_case_bindings')).rejects.toThrow(/immutable/);
  }finally{await db.close();}
 },30000);
 it('rejects a stale reviewed list and leaves no attribution or envelope',async()=>{
  const {db,cases,run}=await setup();try{
   const reviewed=await cases();await db.query("SELECT public.open_paid_period_assertion_case($1,'external_worker',$2,$3::jsonb,30,'Another case')",[id(3),id(1),JSON.stringify(reviewed.snapshot)]);
   await expect(run(id(2),reviewed)).rejects.toThrow(/Case inventory changed/);
   await db.exec('RESET ROLE');expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.historical_worker_attributions')).rows[0].n).toBe(0);
   expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.historical_attribution_case_bindings')).rows[0].n).toBe(0);
  }finally{await db.close();}
 },30000);
 it('rolls back the original split if binding evidence cannot be saved',async()=>{
  const {db,cases,run}=await setup();try{
   const reviewed=await cases();await db.exec(`RESET ROLE;CREATE FUNCTION public.fail_case_binding_test() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'synthetic failure';END$$;CREATE TRIGGER fail_case_binding_test BEFORE INSERT ON public.historical_attribution_case_bindings FOR EACH ROW EXECUTE FUNCTION public.fail_case_binding_test();SET ROLE authenticated`);
   await expect(run(id(2),reviewed)).rejects.toThrow(/synthetic failure/);
   await db.exec('RESET ROLE');for(const table of ['historical_worker_attributions','historical_worker_attribution_sites','historical_attribution_case_bindings'])expect((await db.query<{n:number}>(`SELECT count(*)::int n FROM public.${table}`)).rows[0].n).toBe(0);
  }finally{await db.close();}
 },30000);
 it('does not silently upgrade old unbound evidence',async()=>{
  const {db,source,cases,run}=await setup();try{
   const reviewed=await cases();await db.query(original,[id(2),id(1),JSON.stringify(source),JSON.stringify(split),'Reviewed',true]);
   await expect(run(id(2),reviewed)).rejects.toThrow(/unbound attribution/);
   expect((await db.query<{v:{found:boolean}}>('SELECT public.historical_attribution_case_binding($1) v',[id(1)])).rows[0].v).toEqual({found:false});
  }finally{await db.close();}
 },30000);
 it('denies unauthorized actors and direct evidence access',async()=>{
  const {db,cases,run}=await setup();try{
   const reviewed=await cases();await expect(db.query('SELECT * FROM public.historical_attribution_case_bindings')).rejects.toThrow(/permission denied/);
   await db.exec(`SET test.uid='${supervisor}'`);await expect(run(id(2),reviewed)).rejects.toThrow(/Founder access/);
   await db.exec(`SET test.uid='${founder}';SET test.assurance='no'`);await expect(run(id(2),reviewed)).rejects.toThrow(/Founder access/);
  }finally{await db.close();}
 },30000);
});
