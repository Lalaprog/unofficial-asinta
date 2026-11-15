import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {baseFixture} from './helpers/pr103-fixture';
import {parseCorrectedInventory,parseCorrectedSaved,calculateCorrected,verifyCorrectedTotals} from '@/lib/projects/correctedCostReview';
import {calculateCrossSite,verifyCrossSiteTotals} from '@/lib/projects/crossSiteCostReview';
import {parseCrossSiteSavedHeader,verifyCrossSiteSaved,verifyCrossSiteOverview} from '@/lib/projects/crossSiteReviewLedger';

// Real historical source, binding, case, attribution and cross-site review
// functions in a disposable synthetic database; not hosted business data.
const founder='00000000-0000-0000-0000-000000000001',worker='00000000-0000-0000-0000-000000000003',site='00000000-0000-0000-0000-000000000004',other='00000000-0000-0000-0000-000000000005',destination='00000000-0000-4000-8000-000000000006';
const id=(n:number)=>`ac000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const sql=(name:string)=>readFileSync(`supabase/drafts/${name}.sql`,'utf8');
const read=async(db:PGlite,query:string,args:unknown[])=>(await db.query<{v:unknown}>(query,args)).rows[0].v;
const j=(v:unknown)=>JSON.stringify(v);
async function setup(){const db=new PGlite();try{
 await db.exec(baseFixture);
 await db.exec(`INSERT INTO public.projects VALUES('${destination}','Destination');ALTER TABLE public.expenses ADD COLUMN ai_bale_detection boolean DEFAULT false;ALTER TABLE public.expenses ADD COLUMN revision bigint NOT NULL DEFAULT 0;
 CREATE TABLE public.weekly_worker_draft_sources(payroll_id uuid primary key,worker_id uuid,period_start date,approved_by uuid,approved_at timestamptz,approval_xid bigint,payment_actor uuid,payment_xid bigint,calculation jsonb);
 CREATE TABLE public.payroll_payment_dates(payroll_id uuid primary key,payment_date date,recorded_by uuid);
 CREATE TABLE public.weekly_worker_paid_allocations(payroll_id uuid,project_id uuid,hours numeric(8,2),wage numeric(10,2),allowance numeric(10,2),gross numeric(10,2),primary key(payroll_id,project_id));`);
 for(const n of ['supervisor_table_foundation','supervisor_rpc_rollout','supervisor_payroll_preview','historical_external_worker_payroll','supervisor_payroll_ledger','paid_period_assertion_adjustments','historical_worker_project_attribution'])await db.exec(`BEGIN;${sql(n)} COMMIT;`);
 await db.exec(`BEGIN;SET LOCAL app.historical_case_atomic_rehearsal='synthetic-only';${sql('historical_attribution_atomic_rehearsal')} COMMIT;`);
 for(const n of ['project_paid_payroll_evidence','confirmed_rental_expense_link','paid_payroll_adjustments','project_cost_reconciliation_preview','project_cost_historical_review','project_cost_correction_attribution','project_cost_correction_inventory','project_cost_corrected_preview','project_cost_corrected_review_ledger','project_cost_correction_original_context','project_cost_cross_site_preview','project_cost_cross_site_review_context','project_cost_cross_site_corrected_preview','project_cost_cross_site_review_ledger'])await db.exec(`BEGIN;${sql(n)} COMMIT;`);
 await db.exec(`BEGIN;SET LOCAL app.cross_site_source_lock_reviewed='yes';${sql('project_cost_cross_site_source_review_serialization')} COMMIT;`);
 await db.exec(`BEGIN;SET LOCAL app.cross_site_attribution_lock_reviewed='yes';${sql('project_cost_cross_site_attribution_serialization')} COMMIT;`);
 await db.exec(`BEGIN;SET LOCAL app.cross_site_all_attribution_lock_reviewed='synthetic-only';${sql('project_cost_cross_site_all_attribution_serialization')} COMMIT;`);
 await db.exec(`BEGIN;SET LOCAL app.cross_site_multicase_candidate='synthetic-only';${sql('project_cost_multi_case_upgrade')} COMMIT;`);
 await db.exec(`SET ROLE authenticated;SET test.uid='${founder}';SET test.assurance='yes'`);return db;
 }catch(e){await db.close();throw e;}}
const inventory=(db:PGlite,p:string)=>read(db,'SELECT public.project_cost_correction_inventory($1) v',[p]);
async function saveSource(db:PGlite,p:string,request:string,revision=0){
 const raw=await inventory(db,p),inv=parseCorrectedInventory(raw,p);
 const choices={expenses:Object.fromEntries(inv.historical.base.expenses.map(e=>[e.id,{decision:'include',reason:null}])),historical:Object.fromEntries(inv.historical.historical.map(h=>[h.requestId,{decision:'include',reason:null}])),corrections:Object.fromEntries(inv.cases.map(c=>[c.key,{decision:'include',reason:'Reviewed historical correction'}]))};
 const grouped=new Map<string,string[]>(); for(const c of inv.cases){const key=`${c.kind}:${c.sourceId}`;grouped.set(key,[...(grouped.get(key)??[]),c.key]);}
 const source_reviews=Object.fromEntries([...grouped].filter(([,ids])=>ids.length>1).map(([key,ids])=>[key,{case_ids:ids.sort(),note:'Distinct correction effects',non_overlapping:true}]));
 const reviewed=Object.keys(source_reviews).length?{...choices,source_reviews}:choices;
 const calc=calculateCorrected(inv,reviewed);verifyCorrectedTotals(await read(db,'SELECT public.project_cost_corrected_preview($1,$2::jsonb,$3::jsonb,true) v',[p,j(raw),j(reviewed)]),p,calc.totals);
 await read(db,'SELECT public.record_project_cost_corrected_review($1,$2,$6,$3::jsonb,$4::jsonb,$5,true) v',[request,p,j(raw),j(reviewed),'Historical source reviewed',revision]);
 return read(db,'SELECT public.project_cost_corrected_review($1,NULL) v',[p]);
}
describe('historical external payroll cross-site chain in isolated synthetic DB',()=>{
 it('binds original-period cases and reallocates reviewed historical gross without changing payroll',async()=>{const db=await setup();try{
  const review=await read(db,"SELECT public.historical_external_worker_review($1,'2024-11-03') v",[worker]) as {worker:unknown};
  await read(db,"SELECT public.record_historical_external_worker_payroll($1,$2,'2024-11-03','2024-11-09',600,100,0,500,'Original ledger',$3::jsonb,true) v",[id(1),worker,j(review.worker)]);
  const source=await read(db,'SELECT public.historical_external_worker_lookup($1) v',[id(1)]);
  const initial=await read(db,"SELECT public.paid_period_assertion_case_list('external_worker',$1) v",[id(1)]) as {snapshot:unknown};
  await read(db,"SELECT public.open_paid_period_assertion_case($1,'external_worker',$2,$3::jsonb,30,'Historical correction') v",[id(2),id(1),j(initial.snapshot)]);
  await read(db,"SELECT public.resolve_paid_period_assertion_case($1,'no_transfer',NULL,'Reallocation only',true) v",[id(2)]);
  const cases=await read(db,"SELECT public.paid_period_assertion_case_list('external_worker',$1) v",[id(1)]);
  await read(db,'SELECT public.record_historical_attribution_with_cases($1,$2,$3::jsonb,$4::jsonb,$5,true,$6::jsonb) v',[id(3),id(1),j(source),j([{project_id:site,gross:'400.00'},{project_id:other,gross:'200.00'}]),'Original records reviewed',j(cases)]);
  expect(await read(db,'SELECT public.historical_attribution_case_binding($1) v',[id(1)])).toMatchObject({found:true,cases_changed:false,source_changed:false});
  const evidence=await read(db,"SELECT public.project_cost_correction_attribution('external_worker',$1,NULL) v",[id(2)]) as {case:unknown};
  await read(db,"SELECT public.record_project_cost_correction_attribution($1,'external_worker',$2,0,$3::jsonb,0,$4::jsonb,'Correct site split',true) v",[id(4),id(2),j(evidence.case),j([{project_id:site,gross_change:'-100.00'},{project_id:destination,gross_change:'100.00'}])]);
  const sourceA=await saveSource(db,site,id(5)),sourceB=await saveSource(db,other,id(6));
  const a=parseCorrectedSaved(sourceA,site),b=parseCorrectedSaved(sourceB,other);expect(a.found&&a.totals.historical).toBe(40000n);expect(a.found&&a.totals.correction).toBe(-10000n);expect(b.found&&b.totals.historical).toBe(20000n);
  const raw=await inventory(db,destination),inv=parseCorrectedInventory(raw,destination),key=`external_worker:${id(2)}`;
  const choices={expenses:{},historical:{},corrections:{[key]:{decision:'include',reason:'Reviewed original sites'}}};
  const context=await read(db,"SELECT public.project_cost_cross_site_review_context($1,'external_worker',$2) v",[destination,id(2)]),contexts={[key]:context},sources={[key]:{[site]:sourceA,[other]:sourceB}};
  const calculated=calculateCrossSite(inv,choices,contexts,sources);expect(calculated.totals.total).toBe(10000n);
  verifyCrossSiteTotals(await read(db,'SELECT public.project_cost_cross_site_corrected_preview($1,$2::jsonb,$3::jsonb,$4::jsonb,true) v',[destination,j(raw),j(choices),j(contexts)]),destination,calculated.totals);
  await read(db,'SELECT public.record_project_cost_cross_site_review($1,$2,0,$3::jsonb,$4::jsonb,$5::jsonb,$6,true) v',[id(7),destination,j(raw),j(choices),j(contexts),'Destination reviewed']);
  const header=parseCrossSiteSavedHeader(await read(db,'SELECT public.project_cost_cross_site_review($1,NULL) v',[destination]),destination);if(!header.found)throw Error('Missing review');const saved=verifyCrossSiteSaved(header,sources);verifyCrossSiteOverview(null,saved);expect(saved.totals.total).toBe(10000n);
  if(!a.found||!b.found)throw Error('Missing source review');expect(a.totals.historical+a.totals.correction+b.totals.historical+b.totals.correction+saved.totals.correction).toBe(60000n);
  // A later case is separate from the saved original and invalidates both the
  // case binding's freshness and the earlier cross-site review.
  await read(db,"SELECT public.open_paid_period_assertion_case($1,'external_worker',$2,$3::jsonb,20,'Later evidence') v",[id(8),id(1),j(initial.snapshot)]);
  expect(await read(db,'SELECT public.historical_attribution_case_binding($1) v',[id(1)])).toMatchObject({cases_changed:true});
  const stale=await read(db,'SELECT public.project_cost_cross_site_review($1,NULL) v',[destination]) as {freshness:string};expect(['changed','unavailable']).toContain(stale.freshness);
  await db.exec('RESET ROLE');expect((await db.query("SELECT count(*)::int n FROM public.payroll WHERE period_start='2024-11-03'")).rows[0]).toEqual({n:0});expect((await db.query('SELECT count(*)::int n FROM public.advances')).rows[0]).toEqual({n:0});
 }finally{await db.close();}},60000);
 it('groups distinct signed sibling cases and rejects omission, overlap assertions and stale data',async()=>{const db=await setup();try{
  const review=await read(db,"SELECT public.historical_external_worker_review($1,'2024-11-03') v",[worker]) as {worker:unknown};
  await read(db,"SELECT public.record_historical_external_worker_payroll($1,$2,'2024-11-03','2024-11-09',600,100,0,500,'Original ledger',$3::jsonb,true) v",[id(21),worker,j(review.worker)]);
  const source=await read(db,'SELECT public.historical_external_worker_lookup($1) v',[id(21)]);
  const initial=await read(db,"SELECT public.paid_period_assertion_case_list('external_worker',$1) v",[id(21)]) as {snapshot:unknown};
  for(const n of [22,23]) {await read(db,"SELECT public.open_paid_period_assertion_case($1,'external_worker',$2,$3::jsonb,30,'Distinct correction') v",[id(n),id(21),j(initial.snapshot)]);await read(db,"SELECT public.resolve_paid_period_assertion_case($1,'no_transfer',NULL,'Reallocation only',true) v",[id(n)]);}
  const cases=await read(db,"SELECT public.paid_period_assertion_case_list('external_worker',$1) v",[id(21)]);
  await read(db,'SELECT public.record_historical_attribution_with_cases($1,$2,$3::jsonb,$4::jsonb,$5,true,$6::jsonb) v',[id(24),id(21),j(source),j([{project_id:site,gross:'400.00'},{project_id:other,gross:'200.00'}]),'Original reviewed',j(cases)]);
  for(const [n,a] of [[22,150],[23,-50]] as const){const evidence=await read(db,"SELECT public.project_cost_correction_attribution('external_worker',$1,NULL) v",[id(n)]) as {case:unknown};await read(db,"SELECT public.record_project_cost_correction_attribution($1,'external_worker',$2,0,$3::jsonb,0,$4::jsonb,'Distinct site effects',true) v",[id(n+10),id(n),j(evidence.case),j([{project_id:site,gross_change:(-a).toFixed(2)},{project_id:destination,gross_change:a.toFixed(2)}])]);}
  const partialRaw=await inventory(db,site),partialInv=parseCorrectedInventory(partialRaw,site);
  const partial={expenses:Object.fromEntries(partialInv.historical.base.expenses.map(e=>[e.id,{decision:'include',reason:null}])),historical:Object.fromEntries(partialInv.historical.historical.map(h=>[h.requestId,{decision:'include',reason:null}])),corrections:Object.fromEntries(partialInv.cases.map(c=>[c.key,{decision:c.id===id(22)?'include':'exclude',reason:'Review only first case'}]))};
  calculateCorrected(partialInv,partial);
  await read(db,'SELECT public.record_project_cost_corrected_review($1,$2,0,$3::jsonb,$4::jsonb,$5,true) v',[id(45),site,j(partialRaw),j(partial),'Partial source review']);
  await saveSource(db,other,id(41));
  await expect(read(db,"SELECT public.project_cost_cross_site_review_context($1,'external_worker',$2) v",[destination,id(22)])).rejects.toThrow(/sibling/);
  const sourceA=await saveSource(db,site,id(40),1),sourceB=await read(db,'SELECT public.project_cost_corrected_review($1,NULL) v',[other]);
  const raw=await inventory(db,destination),inv=parseCorrectedInventory(raw,destination),keys=[22,23].map(n=>`external_worker:${id(n)}`),sourceKey=`external_worker:${id(21)}`;
  const choices={expenses:{},historical:{},corrections:Object.fromEntries(keys.map(key=>[key,{decision:'include',reason:'Reviewed original sites'}])),source_reviews:{[sourceKey]:{case_ids:keys,note:'Distinct correction effects',non_overlapping:true}}};
  const contexts:Record<string,unknown>={},sources:Record<string,unknown>={};
  for(const [i,n] of [22,23].entries()){contexts[keys[i]]=await read(db,"SELECT public.project_cost_cross_site_review_context($1,'external_worker',$2) v",[destination,id(n)]);sources[keys[i]]={[site]:sourceA,[other]:sourceB};}
  const ordinary={expenses:{},historical:{},corrections:Object.fromEntries(keys.map(key=>[key,{decision:'exclude',reason:'Reviewed original sites'}]))};
  const ordinaryCalc=calculateCorrected(inv,ordinary);verifyCorrectedTotals(await read(db,'SELECT public.project_cost_corrected_preview($1,$2::jsonb,$3::jsonb,true) v',[destination,j(raw),j(ordinary)]),destination,ordinaryCalc.totals);
  await read(db,'SELECT public.record_project_cost_corrected_review($1,$2,0,$3::jsonb,$4::jsonb,$5,true) v',[id(44),destination,j(raw),j(ordinary),'Destination ordinary review']);
  const ordinarySaved=parseCorrectedSaved(await read(db,'SELECT public.project_cost_corrected_review($1,NULL) v',[destination]),destination);if(!ordinarySaved.found)throw Error('Missing ordinary review');
  const result=calculateCrossSite(inv,choices,contexts,sources);expect(result.totals.total).toBe(10000n);
  verifyCrossSiteTotals(await read(db,'SELECT public.project_cost_cross_site_corrected_preview($1,$2::jsonb,$3::jsonb,$4::jsonb,true) v',[destination,j(raw),j(choices),j(contexts)]),destination,result.totals);
  const omitted=structuredClone(choices);omitted.corrections[keys[1]].decision='exclude';delete omitted.source_reviews[sourceKey];
  expect(()=>calculateCrossSite(inv,omitted,{[keys[0]]:contexts[keys[0]]},{[keys[0]]:sources[keys[0]]})).toThrow();
  await expect(read(db,'SELECT public.project_cost_cross_site_corrected_preview($1,$2::jsonb,$3::jsonb,$4::jsonb,true) v',[destination,j(raw),j(omitted),j({[keys[0]]:contexts[keys[0]]})])).rejects.toThrow();
  const overlap=structuredClone(choices);overlap.source_reviews[sourceKey].non_overlapping=false;
  expect(()=>calculateCrossSite(inv,overlap,contexts,sources)).toThrow();
  await expect(read(db,'SELECT public.project_cost_cross_site_corrected_preview($1,$2::jsonb,$3::jsonb,$4::jsonb,true) v',[destination,j(raw),j(overlap),j(contexts)])).rejects.toThrow();
  await read(db,'SELECT public.record_project_cost_cross_site_review($1,$2,0,$3::jsonb,$4::jsonb,$5::jsonb,$6,true) v',[id(42),destination,j(raw),j(result.choices),j(contexts),'Destination reviewed']);
  const header=parseCrossSiteSavedHeader(await read(db,'SELECT public.project_cost_cross_site_review($1,NULL) v',[destination]),destination);if(!header.found)throw Error('Missing review');const saved=verifyCrossSiteSaved(header,sources);verifyCrossSiteOverview(ordinarySaved,saved);
  const a=parseCorrectedSaved(sourceA,site),b=parseCorrectedSaved(sourceB,other);if(!a.found||!b.found)throw Error('Missing original');expect(a.totals.historical+a.totals.correction+b.totals.historical+b.totals.correction+saved.totals.correction).toBe(60000n);
  await read(db,"SELECT public.open_paid_period_assertion_case($1,'external_worker',$2,$3::jsonb,20,'Later correction') v",[id(43),id(21),j(initial.snapshot)]);
  const stale=await read(db,'SELECT public.project_cost_cross_site_review($1,NULL) v',[destination]) as {freshness:string};expect(['changed','unavailable']).toContain(stale.freshness);
  await expect(read(db,"SELECT public.project_cost_cross_site_review_context($1,'external_worker',$2) v",[destination,id(22)])).rejects.toThrow();
 }finally{await db.close();}},60000);

});
