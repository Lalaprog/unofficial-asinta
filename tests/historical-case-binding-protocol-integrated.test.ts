// HELD candidate protocol + actual SQL, isolated synthetic data only.
import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import {baseFixture} from './helpers/pr103-fixture';
import {parseAttributionStatus} from '@/lib/payroll/historicalAttribution';
import {boundAttributionArguments, parseBoundAttributionAttempt, verifyBoundAttribution} from '@/lib/payroll/historicalCaseBinding';
import type {ExternalRow} from '@/lib/payroll/historicalExternalWorker';
const founder='00000000-0000-0000-0000-000000000001',worker='00000000-0000-0000-0000-000000000003',site='00000000-0000-0000-0000-000000000004';
const id=(n:number)=>`83000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const sql=(name:string)=>readFileSync(`supabase/drafts/${name}.sql`,'utf8');

describe('held historical case-binding retry protocol and synthetic SQL',()=>{
 it('preserves exact reviewed cases through a lost reply, detects later changes, and rejects legacy or altered evidence',async()=>{
  const db=new PGlite();try{
   await db.exec(baseFixture);
   for(const name of ['supervisor_table_foundation','supervisor_rpc_rollout','supervisor_payroll_preview','historical_external_worker_payroll','supervisor_payroll_ledger','paid_period_assertion_adjustments','historical_worker_project_attribution'])await db.exec(`BEGIN;${sql(name)} COMMIT;`);
   await db.exec(`BEGIN;SET LOCAL app.historical_case_binding_candidate='synthetic-only';${sql('historical_attribution_case_binding')} COMMIT;SET ROLE authenticated;SET test.uid='${founder}';SET test.assurance='yes'`);
   const workerSnapshot=(await db.query<{v:{worker:unknown}}>("SELECT public.historical_external_worker_review($1,'2024-11-03') v",[worker])).rows[0].v.worker;
   await db.query("SELECT public.record_historical_external_worker_payroll($1,$2,'2024-11-03','2024-11-09',600,100,0,500,'Old ledger',$3,true)",[id(1),worker,JSON.stringify(workerSnapshot)]);
   const source=(await db.query<{v:ExternalRow}>('SELECT public.historical_external_worker_lookup($1) v',[id(1)])).rows[0].v;
   const list=async()=>(await db.query<{v:{snapshot:unknown;total:number;items:unknown[]}}>("SELECT public.paid_period_assertion_case_list('external_worker',$1) v",[id(1)])).rows[0].v;
   const cases=await list();
   const legacy={id:id(2),actor:founder,source,split:[{project_id:site,gross:'600.00'}],note:'Reviewed ledger'};
   expect(()=>parseBoundAttributionAttempt(legacy,founder,worker,id(1))).toThrow(/version/);
   const attempt=parseBoundAttributionAttempt({version:2,attribution:legacy,reviewed_cases:cases},founder,worker,id(1));
   const persisted=JSON.stringify(attempt),restored=parseBoundAttributionAttempt(JSON.parse(persisted),founder,worker,id(1));
   const write=async()=>{const a=boundAttributionArguments(restored);return (await db.query<{v:{replayed:boolean}}>('SELECT public.record_historical_attribution_with_cases($1,$2,$3::jsonb,$4::jsonb,$5,$6,$7::jsonb) v',[a.p_request,a.p_source,JSON.stringify(a.p_expected),JSON.stringify(a.p_split),a.p_note,a.p_ack,JSON.stringify(a.p_cases)])).rows[0].v;};
   expect((await write()).replayed).toBe(false); // simulate response lost after commit
   await db.query("SELECT public.open_paid_period_assertion_case($1,'external_worker',$2,$3::jsonb,30,'Later case')",[id(3),id(1),JSON.stringify(cases.snapshot)]);
   expect((await write()).replayed).toBe(true);
   const original=parseAttributionStatus((await db.query<{v:unknown}>('SELECT public.historical_worker_attribution($1) v',[id(1)])).rows[0].v,worker,id(1));
   const binding=(await db.query<{v:Record<string,unknown>}>('SELECT public.historical_attribution_case_binding($1) v',[id(1)])).rows[0].v;
   expect(verifyBoundAttribution(binding,original,restored)).toEqual({casesChanged:true});
   expect(()=>verifyBoundAttribution({found:false},original,restored)).toThrow();
   const changedCases=await list();
   expect(()=>verifyBoundAttribution({...binding,reviewed_cases:changedCases},original,restored)).toThrow();
   expect(()=>verifyBoundAttribution({...binding,source_changed:true},original,restored)).toThrow();
   expect(()=>parseBoundAttributionAttempt({...restored,version:1},founder,worker,id(1))).toThrow();
   expect(()=>parseBoundAttributionAttempt({...restored,reviewed_cases:{...cases,total:1}},founder,worker,id(1))).toThrow();
   expect(()=>parseBoundAttributionAttempt(restored,id(8),worker,id(1))).toThrow();
   await db.exec('RESET ROLE');
   expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.historical_attribution_case_bindings')).rows[0].n).toBe(1);
   expect((await db.query<{n:number}>('SELECT count(*)::int n FROM public.historical_worker_attributions')).rows[0].n).toBe(1);
  }finally{await db.close();}
 },30000);
});
