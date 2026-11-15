import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {fixture,roles,candidatePaths,founder,supervisor,site,other,payroll} from './helpers/project-cost-reconciliation-fixture';
import {parseCorrectedInventory,parseCorrectedSaved,calculateCorrected,verifyCorrectedTotals} from '@/lib/projects/correctedCostReview';
import {calculateCrossSite,verifyCrossSiteTotals} from '@/lib/projects/crossSiteCostReview';
import {parseCrossSiteSavedHeader,verifyCrossSiteSaved,verifyCrossSiteOverview,parseAtomicCrossSiteOverview} from '@/lib/projects/crossSiteReviewLedger';

// Real voucher, allocation, expense, correction, inventory, review and
// cross-site functions in an isolated PGlite database. External-history
// dependencies are empty synthetic stubs, not a test of historical payroll.
const sql=(name:string)=>readFileSync(`supabase/drafts/${name}.sql`,'utf8');
const destination='00000000-0000-4000-8000-000000000006';
const id=(n:number)=>`ab000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const read=async(db:PGlite,query:string,args:unknown[])=> (await db.query<{v:unknown}>(query,args)).rows[0].v;
const j=(v:unknown)=>JSON.stringify(v);
async function setup(){
 const db=new PGlite();
 try{
  await db.exec(`${roles} ${fixture}`);
  await db.exec(`INSERT INTO public.projects VALUES('${destination}','Destination');
   CREATE TABLE public.supervisor_period_payroll(id uuid PRIMARY KEY);
   CREATE TABLE public.paid_period_assertion_case_events(id uuid PRIMARY KEY);
   CREATE TABLE public.historical_external_worker_payroll(request_id uuid PRIMARY KEY,original jsonb,gross numeric);
   CREATE TABLE public.attendance(worker_id uuid,project_id uuid,date date);
   CREATE TABLE public.paid_period_assertion_cases(id uuid PRIMARY KEY,source_kind text,external_worker_id uuid,original_snapshot jsonb,difference numeric,status text);
   CREATE TABLE public.historical_worker_attributions(request_id uuid,source_id uuid);
   CREATE TABLE public.historical_worker_attribution_sites(attribution_id uuid,project_id uuid);
   CREATE FUNCTION public.paid_period_assertion_snapshot(p_kind text,p_id uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT original FROM public.historical_external_worker_payroll WHERE request_id=p_id AND p_kind='external_worker'$$;
   CREATE FUNCTION public.project_historical_worker_attributions(p_project uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT jsonb_build_object('project_id',p_project,'items','[]'::jsonb)$$;`);
  for(const path of candidatePaths)await db.exec(`BEGIN;${readFileSync(path,'utf8')} COMMIT;`);
  for(const name of ['project_cost_historical_review','project_cost_correction_attribution','project_cost_correction_inventory','project_cost_corrected_preview','project_cost_corrected_review_ledger','project_cost_correction_original_context','project_cost_cross_site_preview','project_cost_cross_site_review_context','project_cost_cross_site_corrected_preview','project_cost_cross_site_review_ledger'])await db.exec(`BEGIN;${sql(name)} COMMIT;`);
  await db.exec(`BEGIN;SET LOCAL app.cross_site_source_lock_reviewed='yes';${sql('project_cost_cross_site_source_review_serialization')} COMMIT;`);
  await db.exec(`BEGIN;SET LOCAL app.cross_site_attribution_lock_reviewed='yes';${sql('project_cost_cross_site_attribution_serialization')} COMMIT;`);
  const candidate=sql('project_cost_cross_site_all_attribution_serialization');
  await expect(db.exec(`BEGIN;${candidate} COMMIT;`)).rejects.toThrow(/held for synthetic rehearsal/);await db.exec('ROLLBACK');
  await db.exec(`BEGIN;SET LOCAL app.cost_evidence_lock_candidate='synthetic-only';${sql('project_cost_evidence_lock_rehearsal')} COMMIT;`);
  await db.exec(`BEGIN;SET LOCAL app.cross_site_multicase_candidate='synthetic-only';${sql('project_cost_multi_case_upgrade')} COMMIT;`);
  for(const name of ['project_cost_recorded_coverage','project_cost_cross_site_overview'])await db.exec(`BEGIN;${sql(name)} COMMIT;`);
  await db.exec(`SET ROLE authenticated;SET test.uid='${founder}';SET test.assurance='yes'`);
  return db;
 }catch(e){await db.close();throw e;}
}
const inventory=(db:PGlite,project:string)=>read(db,'SELECT public.project_cost_correction_inventory($1) v',[project]);
async function saveOrdinary(db:PGlite,project:string,request:string){
 const raw=await inventory(db,project),parsed=parseCorrectedInventory(raw,project);
 const choices={expenses:Object.fromEntries(parsed.historical.base.expenses.map(e=>[e.id,{decision:'include',reason:null}])),historical:{},corrections:Object.fromEntries(parsed.cases.map(c=>[c.key,{decision:'include',reason:'Reviewed original correction'}]))};
 const grouped=new Map<string,string[]>();for(const c of parsed.cases){const key=`${c.kind}:${c.sourceId}`;grouped.set(key,[...(grouped.get(key)??[]),c.key]);}
 const source_reviews=Object.fromEntries([...grouped].filter(([,ids])=>ids.length>1).map(([key,ids])=>[key,{case_ids:ids.sort(),note:'Distinct correction effects',non_overlapping:true}]));
 const reviewed=Object.keys(source_reviews).length?{...choices,source_reviews}:choices;
 const calc=calculateCorrected(parsed,reviewed);
 const result=await read(db,'SELECT public.project_cost_corrected_preview($1,$2::jsonb,$3::jsonb,true) v',[project,j(raw),j(reviewed)]);verifyCorrectedTotals(result,project,calc.totals);
 await read(db,'SELECT public.record_project_cost_corrected_review($1,$2,0,$3::jsonb,$4::jsonb,$5,true) v',[request,project,j(raw),j(reviewed),'Reviewed source site']);
 return read(db,'SELECT public.project_cost_corrected_review($1,NULL) v',[project]);
}
describe('complete voucher cross-site review chain, isolated synthetic database',()=>{
 it('moves reviewed gross between three sites without modifying paid payroll or adding a second cost',async()=>{const db=await setup();try{
  await db.exec('RESET ROLE');const original=await read(db,'SELECT app_private.paid_adjustment_voucher_snapshot(p) v FROM public.payroll p WHERE id=$1',[payroll]);await db.exec('SET ROLE authenticated');
  await read(db,"SELECT public.open_paid_payroll_adjustment($1,$2,$3::jsonb,1,'Original site correction') v",[id(1),payroll,j(original)]);
  await read(db,"SELECT public.resolve_paid_payroll_adjustment($1,'no_transfer',NULL,'Reallocation only') v",[id(1)]);
  const info=await read(db,"SELECT public.project_cost_correction_attribution('voucher',$1,NULL) v",[id(1)]) as {case:unknown};
  await read(db,"SELECT public.record_project_cost_correction_attribution($1,'voucher',$2,0,$3::jsonb,0,$4::jsonb,'Reviewed site correction',true) v",[id(2),id(1),j(info.case),j([{project_id:site,gross_change:'-100.00'},{project_id:destination,gross_change:'100.00'}])]);
  const sourceA=await saveOrdinary(db,site,id(3)),sourceB=await saveOrdinary(db,other,id(4));
  const a=parseCorrectedSaved(sourceA,site),b=parseCorrectedSaved(sourceB,other);expect(a.found&&a.totals.correction).toBe(-10000n);expect(b.found&&b.totals.correction).toBe(0n);
  const raw=await inventory(db,destination),inv=parseCorrectedInventory(raw,destination),key=`voucher:${id(1)}`;
  const choices={expenses:{},historical:{},corrections:{[key]:{decision:'include',reason:'Reviewed both source sites'}}};
  const context=await read(db,"SELECT public.project_cost_cross_site_review_context($1,'voucher',$2) v",[destination,id(1)]),contexts={[key]:context},sources={[key]:{[site]:sourceA,[other]:sourceB}};
  const calculated=calculateCrossSite(inv,choices,contexts,sources);expect(calculated.totals.total).toBe(10000n);
  const result=await read(db,'SELECT public.project_cost_cross_site_corrected_preview($1,$2::jsonb,$3::jsonb,$4::jsonb,true) v',[destination,j(raw),j(choices),j(contexts)]);verifyCrossSiteTotals(result,destination,calculated.totals);
  await read(db,'SELECT public.record_project_cost_cross_site_review($1,$2,0,$3::jsonb,$4::jsonb,$5::jsonb,$6,true) v',[id(5),destination,j(raw),j(choices),j(contexts),'Reviewed destination']);
  const header=parseCrossSiteSavedHeader(await read(db,'SELECT public.project_cost_cross_site_review($1,NULL) v',[destination]),destination);expect(header.found).toBe(true);if(!header.found)throw Error('Missing review');
  const cross=verifyCrossSiteSaved(header,sources);verifyCrossSiteOverview(null,cross);expect(cross.totals.total).toBe(10000n);expect(cross.freshness).toBe('matches');
  const overview=await read(db,'SELECT public.project_cost_cross_site_overview($1) v',[destination]);expect(parseAtomicCrossSiteOverview(overview,destination).cross?.totals.total).toBe(10000n);
  await db.exec('RESET ROLE');await db.query("UPDATE public.expenses SET description='Changed source expense' WHERE project_id=$1",[site]);await db.exec('SET ROLE authenticated');
  const stale=await read(db,'SELECT public.project_cost_cross_site_overview($1) v',[destination]);expect(()=>parseAtomicCrossSiteOverview(stale,destination)).toThrow(/current/);
  await db.exec('RESET ROLE');expect((await db.query('SELECT status,gross_pay::text gross,net_pay::text net FROM public.payroll WHERE id=$1',[payroll])).rows[0]).toEqual({status:'paid',gross:'750.00',net:'650.00'});expect((await db.query('SELECT sum(gross)::text total FROM public.weekly_worker_paid_allocations WHERE payroll_id=$1',[payroll])).rows[0]).toEqual({total:'750.00'});
  await db.exec(`SET ROLE authenticated;SET test.uid='${supervisor}'`);await expect(inventory(db,destination)).rejects.toThrow(/Founder/);await expect(read(db,'SELECT public.project_cost_cross_site_overview($1) v',[destination])).rejects.toThrow(/Founder/);
 }finally{await db.close();}},60000);
 it('keeps signed voucher sibling effects grouped and rejects a negative destination group',async()=>{const db=await setup();try{
  await db.exec('RESET ROLE');const original=await read(db,'SELECT app_private.paid_adjustment_voucher_snapshot(p) v FROM public.payroll p WHERE id=$1',[payroll]);await db.exec('SET ROLE authenticated');
  for(const n of [20,21]){await read(db,"SELECT public.open_paid_payroll_adjustment($1,$2,$3::jsonb,1,'Distinct correction') v",[id(n),payroll,j(original)]);await read(db,"SELECT public.resolve_paid_payroll_adjustment($1,'no_transfer',NULL,'Reallocation only') v",[id(n)]);}
  for(const [n,a] of [[20,50],[21,-150]] as const){const evidence=await read(db,"SELECT public.project_cost_correction_attribution('voucher',$1,NULL) v",[id(n)]) as {case:unknown};await read(db,"SELECT public.record_project_cost_correction_attribution($1,'voucher',$2,0,$3::jsonb,0,$4::jsonb,'Distinct site effects',true) v",[id(n+10),id(n),j(evidence.case),j([{project_id:site,gross_change:(-a).toFixed(2)},{project_id:destination,gross_change:a.toFixed(2)}])]);}
  const sourceA=await saveOrdinary(db,site,id(40)),sourceB=await saveOrdinary(db,other,id(41));const raw=await inventory(db,destination),inv=parseCorrectedInventory(raw,destination),keys=[20,21].map(n=>`voucher:${id(n)}`),sourceKey=`voucher:${payroll}`;
  const choices={expenses:{},historical:{},corrections:Object.fromEntries(keys.map(key=>[key,{decision:'include',reason:'Reviewed original sites'}])),source_reviews:{[sourceKey]:{case_ids:keys,note:'Distinct correction effects',non_overlapping:true}}};
  const contexts:Record<string,unknown>={},sources:Record<string,unknown>={};for(const [i,n] of [20,21].entries()){contexts[keys[i]]=await read(db,"SELECT public.project_cost_cross_site_review_context($1,'voucher',$2) v",[destination,id(n)]);sources[keys[i]]={[site]:sourceA,[other]:sourceB};}
  expect(()=>calculateCrossSite(inv,choices,contexts,sources)).toThrow(/negative/);
  await expect(read(db,'SELECT public.project_cost_cross_site_corrected_preview($1,$2::jsonb,$3::jsonb,$4::jsonb,true) v',[destination,j(raw),j(choices),j(contexts)])).rejects.toThrow(/negative/);
  await expect(read(db,'SELECT public.record_project_cost_cross_site_review($1,$2,0,$3::jsonb,$4::jsonb,$5::jsonb,$6,true) v',[id(42),destination,j(raw),j(choices),j(contexts),'Destination reviewed'])).rejects.toThrow(/negative/);
 }finally{await db.close();}},60000);

});
