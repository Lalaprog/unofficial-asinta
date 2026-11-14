import {sameAttributionEvidence} from '@/lib/payroll/historicalAttribution';
import {parseAdjustmentList} from '@/lib/payroll/paidAdjustments';
import {parsePeriodCases,parsePeriodSnapshot} from '@/lib/payroll/paidPeriodCases';
import {correctionAmount,type CorrectionCase} from '@/lib/payroll/projectCostCorrection';
import {parseCrossSiteEvidence,verifyCrossSiteIllustration,type CrossSiteIllustration} from '@/lib/payroll/crossSiteIllustration';
import {calculateCorrected,parseCorrectedSaved,verifyCorrectedTotals,type CorrectedCase,type CorrectedChoices,type CorrectedInventory,type CorrectedTotals} from './correctedCostReview';

const obj=(x:unknown):x is Record<string,unknown>=>!!x&&typeof x==='object'&&!Array.isArray(x);
const uuid=(x:unknown):x is string=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(x);
const bytes=(x:unknown)=>new TextEncoder().encode(JSON.stringify(x)).length;
export const CROSS_SITE_SOURCE_REVIEW_BYTES=8*1024*1024;
export type CrossSiteSource={projectId:string;originalGross:string;grossChange:string;requestId:string;revision:number;actorId:string;recordedAt:string};
export type CrossSiteContext={raw:Record<string,unknown>;caseKey:string;illustration:CrossSiteIllustration;sources:CrossSiteSource[];incoming:bigint};
export type CrossSiteTotals=CorrectedTotals&{crossSiteGross:bigint;crossSiteCases:number};
function caseItem(c:CorrectedCase):CorrectionCase{
 const v=c.review.case;
 if(c.kind==='voucher')return parseAdjustmentList({total:1,offset:0,items:[v]},c.sourceId,0).items[0];
 const original=parsePeriodSnapshot(v.original_snapshot);
 if(original.kind!=='external_worker'||v.external_worker_id!==c.sourceId)throw Error('Invalid incoming original');
 return parsePeriodCases({snapshot:original,total:1,items:[{...v,source_id:c.sourceId}]},original)[0];
}
/** Validate the bounded one-case context and recompute its full illustration.
 * Source review metadata is not sufficient to prove inclusion: callers must
 * also fetch and verify every original-site revision before using it. */
export function parseCrossSiteContext(raw:unknown,projectId:string,c:CorrectedCase):CrossSiteContext{
 if(!uuid(projectId)||!obj(raw)||bytes(raw)>524288||raw.destination!==projectId||raw.source_kind!==c.kind||raw.case_id!==c.id||raw.incomplete!==true||c.sourceInSnapshot||c.siteChange===null||!obj(raw.source_evidence)||!obj(raw.source_evidence.original)||!Array.isArray(raw.original_site_reviews))throw Error('Invalid incoming context');
 const source=raw.source_evidence,parsed=parseCrossSiteEvidence(source,c.kind,caseItem(c),c.review);
 const illustration=verifyCrossSiteIllustration(raw.illustration,parsed.illustration);
 const original=source.original as Record<string,unknown>;
 if(!Array.isArray(original.sites)||original.sites.some((v:unknown)=>obj(v)&&v.project_id===projectId))throw Error('Destination has an original allocation');
 const destination=illustration.sites.find(x=>x.project_id===projectId);
 const incoming=correctionAmount(c.siteChange).cents;
 if(!destination||incoming<=0n||destination.original_gross!=='0.00'||destination.gross_change!==c.siteChange||destination.corrected_gross!==c.siteChange)throw Error('Incoming amount differs');
 if(raw.original_site_reviews.length!==original.sites.length)throw Error('Missing original-site review');
 const seen=new Set<string>();
 const sources=raw.original_site_reviews.map((x:unknown,index:number):CrossSiteSource=>{
  const site=original.sites instanceof Array?original.sites[index]:null;
  if(!obj(x)||!obj(site)||!uuid(x.project_id)||x.project_id!==site.project_id||seen.has(x.project_id)||!uuid(x.request_id)||!uuid(x.actor_id)||!Number.isSafeInteger(x.revision)||Number(x.revision)<1||Number(x.revision)>2147483647||typeof x.recorded_at!=='string'||!Number.isFinite(Date.parse(x.recorded_at))||typeof x.original_gross!=='string'||x.original_gross!==site.gross||typeof x.gross_change!=='string')throw Error('Invalid original-site review');
  const line=illustration.sites.find(v=>v.project_id===x.project_id);if(!line||line.original_gross!==x.original_gross||line.gross_change!==x.gross_change)throw Error('Original-site amount differs');
  seen.add(x.project_id);return {projectId:x.project_id,originalGross:x.original_gross,grossChange:x.gross_change,requestId:x.request_id,revision:Number(x.revision),actorId:x.actor_id,recordedAt:x.recorded_at};
 });
 return {raw,caseKey:c.key,illustration,sources,incoming};
}
/** Require actual saved original-site revisions, their explicit decisions and
 * the same correction evidence; metadata alone is never treated as inclusion. */
function verifySources(context:CrossSiteContext,c:CorrectedCase,reviews:unknown,requireCurrent:boolean):void{
 if(!obj(reviews)||bytes(reviews)>CROSS_SITE_SOURCE_REVIEW_BYTES||Object.keys(reviews).length!==context.sources.length||context.caseKey!==c.key)throw Error('Missing original reviews');
 for(const source of context.sources){
  const saved=parseCorrectedSaved(reviews[source.projectId],source.projectId);
  if(!saved.found||saved.revision!==source.revision||saved.requestId!==source.requestId||saved.actorId!==source.actorId||saved.recordedAt!==source.recordedAt||(requireCurrent&&(saved.freshness!=='matches'||saved.latestRevision!==saved.revision)))throw Error('Original review changed');
  const own=saved.inventory.cases.find(x=>x.key===c.key);
  if(!own||!own.sourceInSnapshot||own.sourceId!==c.sourceId||own.siteChange!==source.grossChange||!sameAttributionEvidence(own.review,c.review)||saved.choices.corrections[c.key]?.decision!=='include')throw Error('Original correction inclusion differs');
  if(c.kind==='voucher'){
   const paid=saved.inventory.historical.base.paid.find(x=>x.payrollId===c.sourceId);
   if(!paid||paid.gross!==source.originalGross)throw Error('Original voucher inclusion differs');
  }else{
   const h=saved.inventory.historical.historical.find(x=>x.sourceId===c.sourceId);
   if(!h||h.siteGross!==source.originalGross||h.overlappingVouchers!==0||saved.choices.historical[h.requestId]?.decision!=='include')throw Error('Original historical inclusion differs');
  }
 }
}
/** Current evidence is mandatory for a new review. */
export function verifyCrossSiteSources(context:CrossSiteContext,c:CorrectedCase,reviews:unknown):void{
 verifySources(context,c,reviews,true);
}
/** Apply the existing complete decision checks with incoming cases temporarily
 * excluded; add back only individually verified positive incoming effects. */
function calculate(inv:CorrectedInventory,rawChoices:unknown,contexts:unknown,sourceReviews:unknown,requireCurrent:boolean):{choices:CorrectedChoices;totals:CrossSiteTotals;contexts:Record<string,CrossSiteContext>}{
 if(!obj(rawChoices)||!obj(rawChoices.corrections)||!obj(contexts)||!obj(sourceReviews)||bytes(sourceReviews)>CROSS_SITE_SOURCE_REVIEW_BYTES||bytes(contexts)>500000)throw Error('Invalid incoming choices');
 const choices=structuredClone(rawChoices),baseCorrections=choices.corrections as Record<string,unknown>,verified:Record<string,CrossSiteContext>={};let incoming=0n,count=0;
 for(const c of inv.cases){const decision=baseCorrections[c.key];if(c.sourceInSnapshot||!obj(decision)||decision.decision!=='include')continue;
  const context=parseCrossSiteContext(contexts[c.key],inv.historical.base.projectId,c);verifySources(context,c,sourceReviews[c.key],requireCurrent);verified[c.key]=context;incoming+=context.incoming;count++;
  baseCorrections[c.key]={...decision,decision:'exclude'};
 }
 if(Object.keys(contexts).length!==count||Object.keys(sourceReviews).length!==count)throw Error('Unexpected or missing incoming context');
 const base=calculateCorrected(inv,choices);const normalized=structuredClone(base.choices);
 for(const key of Object.keys(verified))normalized.corrections[key]={...normalized.corrections[key],decision:'include'};
 const total=base.totals.total+incoming,correction=base.totals.correction+incoming,excludedCases=base.totals.excludedCases-count;
 if(total<0n||total>=10000000000000000n||correction<=-10000000000000000n||correction>=10000000000000000n||excludedCases<0)throw Error('Invalid incoming total');
 return {choices:normalized,totals:{...base.totals,total,correction,excludedCases,crossSiteGross:incoming,crossSiteCases:count},contexts:verified};
}
export function calculateCrossSite(inv:CorrectedInventory,rawChoices:unknown,contexts:unknown,sourceReviews:unknown){
 return calculate(inv,rawChoices,contexts,sourceReviews,true);
}
/** Only for immutable historical reads and checking an already-sent attempt.
 * A validated historical result MUST NOT be used to authorize a new write. */
export function calculateHistoricalCrossSite(inv:CorrectedInventory,rawChoices:unknown,contexts:unknown,sourceReviews:unknown){
 return calculate(inv,rawChoices,contexts,sourceReviews,false);
}
export function verifyCrossSiteTotals(raw:unknown,projectId:string,expected:CrossSiteTotals):CrossSiteTotals{
 verifyCorrectedTotals(raw,projectId,expected);
 if(!obj(raw)||typeof raw.cross_site_gross!=='string'||!/^(?:0|[1-9]\d{0,13})\.\d{2}$/.test(raw.cross_site_gross)||raw.cross_site_cases!==expected.crossSiteCases)throw Error('Invalid incoming total');
 const [a,b]=raw.cross_site_gross.split('.');if(BigInt(a)*100n+BigInt(b)!==expected.crossSiteGross)throw Error('Incoming total differs');return expected;
}
