import {describe,expect,it} from 'vitest';
import {parseCorrectedInventory,type CorrectedChoices} from '@/lib/projects/correctedCostReview';
import {calculateCrossSite,parseCrossSiteContext,verifyCrossSiteSources,verifyCrossSiteTotals} from '@/lib/projects/crossSiteCostReview';
import {crossFixture,key} from './helpers/cross-site-cost-review-fixture';
import {makeExternalEvidence,externalItem,expected} from './helpers/cross-site-illustration-fixture';
function calculate(f= crossFixture()){const inv=parseCorrectedInventory(f.destination,f.ids.other);return calculateCrossSite(inv,f.destinationChoices,f.contexts,f.sourceReviews);}
describe('incoming cross-site review client verification',()=>{
 it('requires verified original inclusion and computes only the incoming signed cents',()=>{const f=crossFixture(),parsed=calculate(f);expect(parsed.totals).toMatchObject({total:10025n,correction:10025n,excludedCases:0,crossSiteGross:10025n,crossSiteCases:1});expect(parsed.choices).toEqual(f.destinationChoices);expect(verifyCrossSiteTotals(f.destinationResult,f.ids.other,parsed.totals)).toEqual(parsed.totals);});
 it('rejects a changed, missing, excluded or superseded source review',()=>{
  for(const change of ['missing','freshness','revision','actor','excluded','amount','evidence']){const f=crossFixture(),saved=f.sourceSaved;
   if(change==='missing')delete (f.sourceReviews[key] as Record<string,unknown>)[f.ids.site];
   if(change==='freshness')saved.freshness='changed';if(change==='revision')saved.latest_revision=2;if(change==='actor')saved.actor_id=f.ids.other;
   if(change==='excluded')saved.choices.corrections[key]={decision:'exclude',reason:'Not included'};
   if(change==='amount')saved.snapshot.historical_review.base.paid_allocations[0].gross='599.00';
   if(change==='evidence')saved.snapshot.corrections[0].evidence.attribution.note='Changed';
   expect(()=>calculate(f),change).toThrow();
  }
 });
 it('fails closed on missing, malformed, extra, duplicate, or changed context',()=>{
  for(const change of ['missing','extra','destination','amount','case','duplicate','original']){const f=crossFixture();
   if(change==='missing')delete (f.contexts as Record<string,unknown>)[key];
   if(change==='extra')(f.contexts as Record<string,unknown>).extra={};
   if(change==='destination')f.context.destination=f.ids.site;
   if(change==='amount')f.context.illustration.sites[1].gross_change='100.24';
   if(change==='case')f.context.source_evidence.correction.case_id=f.ids.other;
   if(change==='duplicate')f.context.original_site_reviews.push({...f.context.original_site_reviews[0]});
   if(change==='original')f.context.source_evidence.original.sites[0].gross='599.00';
   expect(()=>calculate(f),change).toThrow();
  }
 });
 it('requires exact server totals, decisions and positive incoming amounts',()=>{const f=crossFixture(),v=calculate(f);
  expect(()=>verifyCrossSiteTotals({...f.destinationResult,cross_site_gross:'99.00'},f.ids.other,v.totals)).toThrow();expect(()=>verifyCrossSiteTotals({...f.destinationResult,incomplete_total:'999.00'},f.ids.other,v.totals)).toThrow();
  f.destinationChoices.corrections[key].reason='';expect(()=>calculate(f)).toThrow();
  const other=crossFixture();other.destinationChoices.corrections[key].decision='exclude';expect(()=>calculate(other)).toThrow();
 });
 it('requires explicit original inclusion and no voucher overlap for an externally paid worker',()=>{
  const f=crossFixture(),e=makeExternalEvidence(),externalKey=`external_worker:${f.ids.caseId}`;
  const source=structuredClone(f.sourceInventory);source.historical_review.base.paid_allocations=[];source.historical_review.base.adjustment_cases=[];
  const h=source.historical_review.historical[0];Object.assign(h,{source_id:externalItem.source_id,worker_id:externalItem.original_snapshot.person_id,worker_name:'Worker',period_start:'2024-12-01',period_end:'2024-12-07',paid_on:'2024-12-07',original_gross:'600.00',site_gross:'600.00',case_count:1,overlapping_vouchers:0});
  source.corrections[0]={kind:'external_worker',case_id:f.ids.caseId,source_in_snapshot:true,site_gross_change:'-100.25',evidence:e.correction} as unknown as typeof source.corrections[0];
  const sourceChoices:CorrectedChoices={expenses:f.sourceSaved.choices.expenses,historical:{[h.request_id]:{decision:'include',reason:null}},corrections:{[externalKey]:{decision:'include',reason:'Reviewed'}}};
  const saved={...f.sourceSaved,snapshot:source,choices:sourceChoices,result:{...f.sourceResult,paid_gross:'0.00',historical_gross:'600.00',incomplete_total:'550.00'}};
  const destination=structuredClone(f.destination);destination.corrections[0]={kind:'external_worker',case_id:f.ids.caseId,source_in_snapshot:false,site_gross_change:'100.25',evidence:e.correction} as unknown as typeof destination.corrections[0];
  const context={...f.context,source_kind:'external_worker',source_evidence:e,illustration:{...expected,source_kind:'external_worker'}};
  const selection={expenses:{},historical:{},corrections:{[externalKey]:{decision:'include',reason:'Reviewed'}}};
  const inv=parseCorrectedInventory(destination,f.ids.other);const contexts={[externalKey]:context},reviews={[externalKey]:{[f.ids.site]:saved}};
  expect(calculateCrossSite(inv,selection,contexts,reviews).totals.total).toBe(10025n);
  saved.choices.historical[h.request_id]={decision:'exclude',reason:'Not included'};expect(()=>calculateCrossSite(inv,selection,contexts,reviews)).toThrow();
 });
 it('never treats a superseded historical revision as current',()=>{const f=crossFixture(),c=parseCorrectedInventory(f.destination,f.ids.other).cases[0],context=parseCrossSiteContext(f.context,f.ids.other,c);f.sourceSaved.latest_revision=2;f.sourceSaved.freshness='changed';expect(()=>verifyCrossSiteSources(context,c,f.sourceReviews[key])).toThrow();});
});
