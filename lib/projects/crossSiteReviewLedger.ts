import {CROSS_SITE_SOURCE_REVIEW_BYTES,calculateCrossSite,calculateHistoricalCrossSite,parseCrossSiteContext,verifyCrossSiteTotals,type CrossSiteTotals} from './crossSiteCostReview';
import {parseCorrectedInventory,parseCorrectedSaved,type CorrectedChoices,type CorrectedInventory,type CorrectedSaved} from './correctedCostReview';
import {sameAttributionEvidence} from '@/lib/payroll/historicalAttribution';
import {parseReviewMarker,validReviewNote,type ReviewMarker} from './projectCostReview';
import {parseRecordedCostCoverage} from './recordedCostCoverage';

const obj=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const integer=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=2147483647;
const size=(v:unknown)=>new TextEncoder().encode(JSON.stringify(v)).length;
export type SourceRefs=Record<string,{projectId:string;revision:number}[]>;
export type CrossSiteSavedHeader={found:true;revision:number;latestRevision:number;requestId:string;actorId:string;recordedAt:string;note:string;freshness:'matches'|'changed'|'unavailable';inventory:CorrectedInventory;choices:unknown;contexts:Record<string,unknown>;result:unknown;refs:SourceRefs};
export type CrossSiteSaved=CrossSiteSavedHeader&{choices:CorrectedChoices;totals:CrossSiteTotals;sourceFreshness:'matches'|'changed'|'unavailable'};
export type CrossSiteAttempt={marker:ReviewMarker;raw:unknown;choices:CorrectedChoices;contexts:Record<string,unknown>;sourceReviews:Record<string,unknown>;note:string};
/** Parse saved metadata and source references without accepting unverified totals. */
export function parseCrossSiteSavedHeader(raw:unknown,projectId:string):{found:false;latestRevision:0}|CrossSiteSavedHeader{
 if(!obj(raw)||!uuid(projectId)||raw.project_id!==projectId||typeof raw.found!=='boolean'||!integer(raw.latest_revision))throw Error('Invalid cross-site review');
 if(!raw.found){if(raw.latest_revision!==0)throw Error('Invalid empty cross-site history');return {found:false,latestRevision:0};}
 if(!integer(raw.revision)||raw.revision<1||raw.revision>raw.latest_revision||!uuid(raw.request_id)||!uuid(raw.actor_id)||typeof raw.recorded_at!=='string'||!Number.isFinite(Date.parse(raw.recorded_at))||typeof raw.note!=='string'||!validReviewNote(raw.note)||!['matches','changed','unavailable'].includes(String(raw.freshness))||!obj(raw.cross_sites)||size(raw.cross_sites)>500000||!obj(raw.choices)||!obj(raw.choices.corrections))throw Error('Invalid cross-site review metadata');
 const inventory=parseCorrectedInventory(raw.snapshot,projectId),refs:SourceRefs={};
 for(const c of inventory.cases){const choice=raw.choices.corrections[c.key];if(c.sourceInSnapshot||!obj(choice)||choice.decision!=='include')continue;
  const ctx=parseCrossSiteContext(raw.cross_sites[c.key],projectId,c);refs[c.key]=ctx.sources.map(s=>({projectId:s.projectId,revision:s.revision}));
 }
 if(Object.keys(refs).length!==Object.keys(raw.cross_sites).length)throw Error('Unexpected saved contexts');
 return {found:true,revision:raw.revision,latestRevision:raw.latest_revision,requestId:raw.request_id,actorId:raw.actor_id,recordedAt:raw.recorded_at,note:raw.note,freshness:raw.freshness as CrossSiteSavedHeader['freshness'],inventory,choices:raw.choices,contexts:raw.cross_sites,result:raw.result,refs};
}
/** Independently check the exact immutable source revisions and saved totals.
 * Freshness is a separate server-reported point-in-time signal, never inferred
 * from this historical calculation. */
export function verifyCrossSiteSaved(header:CrossSiteSavedHeader,sourceReviews:unknown):CrossSiteSaved{
 const calc=calculateHistoricalCrossSite(header.inventory,header.choices,header.contexts,sourceReviews);
 verifyCrossSiteTotals(header.result,header.inventory.historical.base.projectId,calc.totals);
 let sourceFreshness:CrossSiteSaved['sourceFreshness']='matches';
 if(!obj(sourceReviews))throw Error('Missing source reviews');
 for(const [caseKey,refs] of Object.entries(header.refs)){const group=sourceReviews[caseKey];if(!obj(group))throw Error('Missing source reviews');for(const ref of refs){const saved=parseCorrectedSaved(group[ref.projectId],ref.projectId);if(!saved.found)throw Error('Missing source revision');if(saved.freshness==='unavailable')sourceFreshness='unavailable';else if(sourceFreshness!=='unavailable'&&(saved.freshness==='changed'||saved.latestRevision!==saved.revision))sourceFreshness='changed';}}
 return {...header,choices:calc.choices,totals:calc.totals,sourceFreshness};
}
/** The destination review is an alternative calculation, not an amount to add
 * to the ordinary review. Require identical evidence and all other decisions,
 * and require every incoming item to be included in the cross-site review. */
export function verifyCrossSiteOverview(ordinary:CorrectedSaved|null,cross:CrossSiteSaved):void{
 if(cross.revision!==cross.latestRevision||cross.freshness!=='matches'||cross.sourceFreshness!=='matches')throw Error('Review is not current');
 const incoming=cross.inventory.cases.filter(c=>!c.sourceInSnapshot);
 if(!incoming.length||cross.totals.crossSiteCases!==incoming.length||incoming.some(c=>cross.choices.corrections[c.key]?.decision!=='include'))throw Error('Incoming corrections are incomplete');
 if(!ordinary)return;
 if(ordinary.revision!==ordinary.latestRevision||ordinary.freshness!=='matches')throw Error('Review is not current');
 if(!sameAttributionEvidence(withoutCapture(ordinary.inventory.raw),withoutCapture(cross.inventory.raw)))throw Error('Review evidence differs');
 const ordinaryChoices=structuredClone(ordinary.choices),crossChoices=structuredClone(cross.choices);
 for(const c of incoming){
  if(ordinaryChoices.corrections[c.key]?.decision!=='exclude'||crossChoices.corrections[c.key]?.decision!=='include')throw Error('Incoming correction is not included');
  delete ordinaryChoices.corrections[c.key];delete crossChoices.corrections[c.key];
 }
 // The distinct-effects assertion for incoming cases has no counterpart in
 // the ordinary review, where those cases are deliberately excluded.
 for(const c of incoming)delete crossChoices.source_reviews?.[`${c.kind}:${c.sourceId}`];
 if(crossChoices.source_reviews&&Object.keys(crossChoices.source_reviews).length===0)delete crossChoices.source_reviews;
 if(ordinaryChoices.source_reviews&&Object.keys(ordinaryChoices.source_reviews).length===0)delete ordinaryChoices.source_reviews;
 if(!sameAttributionEvidence(ordinaryChoices,crossChoices))throw Error('Review decisions differ');
}
/** All evidence here must come from the single-statement overview RPC. */
export function parseAtomicCrossSiteOverview(raw:unknown,projectId:string){
 if(!obj(raw)||Object.keys(raw).sort().join(',')!=='coverage,cross,project_id,sources'||raw.project_id!==projectId||!obj(raw.sources)||size(raw.sources)>CROSS_SITE_SOURCE_REVIEW_BYTES)throw Error('Invalid cross-site overview');
 const coverage=parseRecordedCostCoverage(raw.coverage,projectId),header=parseCrossSiteSavedHeader(raw.cross,projectId);
 if(!header.found){if(Object.keys(raw.sources).length)throw Error('Unexpected cross-site source evidence');return {coverage,cross:null};}
 if(Object.values(header.refs).reduce((sum,refs)=>sum+refs.length,0)>100)throw Error('Too many source revisions');
 const cross=verifyCrossSiteSaved(header,raw.sources);verifyCrossSiteOverview(coverage.review.found?coverage.review:null,cross);
 return {coverage,cross};
}
const canonical=(v:unknown):unknown=>Array.isArray(v)?v.map(canonical):obj(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const equal=(a:unknown,b:unknown)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
function withoutCapture(value:unknown):unknown{const copy=JSON.parse(JSON.stringify(value));delete copy.historical_review.base.captured_at;return copy;}
export function savedMatchesCrossSiteAttempt(saved:CrossSiteSaved,a:CrossSiteAttempt):boolean{
 return saved.revision===a.marker.expectedRevision+1&&saved.requestId===a.marker.requestId&&saved.actorId===a.marker.actorId&&saved.note===a.note&&equal(saved.inventory.raw&&withoutCapture(saved.inventory.raw),withoutCapture(a.raw))&&equal(saved.choices,a.choices)&&equal(saved.contexts,a.contexts);
}
/** Retry evidence is sensitive and bounded. It must be validated before storage
 * and revalidated on load; storage failure must prevent sending any request. */
export function parseStoredCrossSiteAttempt(serialized:string,projectId:string,actorId:string):CrossSiteAttempt{
 if(serialized.length>11000000)throw Error('Retry evidence too large');const v:unknown=JSON.parse(serialized);
 if(!obj(v)||Object.keys(v).sort().join(',')!=='choices,contexts,marker,note,raw,sourceReviews,version'||v.version!==1||typeof v.note!=='string'||!validReviewNote(v.note)||!obj(v.contexts)||!obj(v.sourceReviews))throw Error('Invalid retry evidence');
 const marker=parseReviewMarker(v.marker,projectId,actorId),inv=parseCorrectedInventory(v.raw,projectId),calc=calculateHistoricalCrossSite(inv,v.choices,v.contexts,v.sourceReviews);
 if(calc.totals.crossSiteCases<1)throw Error('Missing incoming review');
 return {marker,raw:v.raw,choices:calc.choices,contexts:v.contexts,sourceReviews:v.sourceReviews,note:v.note};
}
export function serializeCrossSiteAttempt(a:CrossSiteAttempt,projectId:string,actorId:string):string{
 // New requests must validate current source freshness; retries are historical.
 const inv=parseCorrectedInventory(a.raw,projectId);const current=calculateCrossSite(inv,a.choices,a.contexts,a.sourceReviews);
 if(current.totals.crossSiteCases<1)throw Error('Missing incoming review');
 const serialized=JSON.stringify({version:1,...a,choices:current.choices});parseStoredCrossSiteAttempt(serialized,projectId,actorId);return serialized;
}
