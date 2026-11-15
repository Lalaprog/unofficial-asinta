import {sameAttributionEvidence} from '@/lib/payroll/historicalAttribution';
import {parseRecordedCostCoverage} from './recordedCostCoverage';
import {hasUnsupportedLegacyIncoming,legacyCostMatchesBase,parseLegacyCostSaved,type LegacyCostSaved} from './legacyVoucherCostReview';
import {parseAtomicCrossSiteOverview} from './crossSiteReviewLedger';
import {parseSimpleRecordedCost} from './simpleRecordedCost';

/** All readers in this response share the same statement snapshot. */
export function parseLegacyRecordedCoverage(raw:unknown,projectId:string){
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Invalid legacy coverage');const v=raw as Record<string,unknown>,base=parseRecordedCostCoverage(raw,projectId);
 const count=(x:unknown):number=>{if(typeof x!=='number'||!Number.isSafeInteger(x)||x<0)throw Error('Invalid legacy coverage count');return x;};
 const siteAttributions=count(v.legacy_site_attributions),changedAttributions=count(v.changed_legacy_attributions),review=parseLegacyCostSaved(v.legacy_review,projectId);
 if(review.found&&review.revision!==review.latestRevision)throw Error('Not latest legacy review');
 if(review.found&&review.freshness==='matches'&&review.inventory.legacy.length!==siteAttributions)throw Error('Legacy site evidence differs');
 return {...base,siteAttributions,changedAttributions,legacyReview:review};
}
/** Use the simple amount only when the same snapshot confirms that this site
 * has no older voucher split or incoming legacy correction. */
export function parseLegacyRecordedSnapshot(raw:unknown,projectId:string){
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Invalid legacy recorded snapshot');const v=raw as Record<string,unknown>;
 if(Object.keys(v).sort().join(',')!=='legacy,ordinary,project_id'||v.project_id!==projectId||!v.legacy||typeof v.legacy!=='object'||Array.isArray(v.legacy)||!v.ordinary||typeof v.ordinary!=='object'||Array.isArray(v.ordinary))throw Error('Invalid legacy snapshot scope');
 const legacyRaw=v.legacy as Record<string,unknown>,ordinary=v.ordinary as Record<string,unknown>;
 if(!ordinary.coverage||typeof ordinary.coverage!=='object'||Array.isArray(ordinary.coverage))throw Error('Missing ordinary coverage');
 const coverageRaw=ordinary.coverage as Record<string,unknown>,legacy=parseLegacyRecordedCoverage(legacyRaw,projectId),base=parseRecordedCostCoverage(coverageRaw,projectId);
 if(legacy.capturedAt!==base.capturedAt||legacy.inconsistentAllocations!==base.inconsistentAllocations||legacy.unattributedHistory!==base.unattributedHistory||!sameAttributionEvidence(legacyRaw.review,coverageRaw.review))throw Error('Coverage snapshots differ');
 if(legacy.siteAttributions>0)return {legacy,simple:null};
 // Valid older splits elsewhere should not look like unallocated vouchers.
 // The legacy coverage and ordinary inventory were captured together.
 const simple=parseSimpleRecordedCost({...ordinary,coverage:legacyRaw},projectId);
 if(legacy.changedAttributions>0)return {legacy,simple:{...simple,totals:null,issues:[...simple.issues,'An older voucher split or its corrections changed and needs investigation.']}};
 return {legacy,simple};
}

/** The legacy-coverage and ordinary cross-site results must share one RPC. */
export function parseLegacyCrossSiteOverview(raw:unknown,projectId:string){
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Invalid combined overview');const v=raw as Record<string,unknown>;
 if(Object.keys(v).sort().join(',')!=='legacy,ordinary,project_id'||v.project_id!==projectId||!v.legacy||typeof v.legacy!=='object'||Array.isArray(v.legacy)||!v.ordinary||typeof v.ordinary!=='object'||Array.isArray(v.ordinary))throw Error('Invalid combined overview scope');
 const legacyRaw=v.legacy as Record<string,unknown>,ordinaryRaw=v.ordinary as Record<string,unknown>,ordinaryCoverage=ordinaryRaw.coverage;
 if(!ordinaryCoverage||typeof ordinaryCoverage!=='object'||Array.isArray(ordinaryCoverage))throw Error('Missing ordinary coverage');
 const coverageRaw=ordinaryCoverage as Record<string,unknown>,legacy=parseLegacyRecordedCoverage(legacyRaw,projectId);
 if(legacyRaw.captured_at!==coverageRaw.captured_at||!sameAttributionEvidence(legacyRaw.review,coverageRaw.review))throw Error('Coverage snapshots differ');
 if(legacy.changedAttributions>0)return {legacy,cross:null,mixed:null};
 if(legacy.siteAttributions>0){
  const saved=matchingLegacyBase(legacy);
  if(!saved)return {legacy,cross:null,mixed:null};
  // A legacy correction already contained in the corrected older voucher must
  // stay excluded from the cross-site review. Other incoming cases require
  // their normal, independently verified source-site reviews.
  const excluded=new Set<string>();
  for(const c of saved.inventory.base.cases){if(c.sourceInSnapshot)continue;
   if(saved.inventory.legacy.some(v=>v.payrollId===c.sourceId&&c.kind==='voucher'&&v.corrected?.cases.some(x=>x.id===c.id&&sameAttributionEvidence(x.review,c.review))))excluded.add(c.key);
  }
  const atomic=parseAtomicCrossSiteOverview(ordinaryRaw,projectId,excluded);
  if(!atomic.cross)return {legacy,cross:null,mixed:null};
  const total=atomic.cross.totals.total+saved.totals.included;
  if(total>=10000000000000000n)throw Error('Combined total exceeds limit');
  return {legacy,cross:null,mixed:{cross:atomic.cross,legacy:saved,total}};
 }
 const atomic=parseAtomicCrossSiteOverview(ordinaryRaw,projectId);
 return {legacy,cross:atomic.cross,mixed:null};
}

/** Both alternatives must use the same current ordinary evidence and choices. */
export function matchingLegacyBase(coverage:ReturnType<typeof parseLegacyRecordedCoverage>):LegacyCostSaved|null{
 const base=coverage.review,legacy=coverage.legacyReview;
 if(coverage.changedAttributions>0||!base.found||base.revision!==base.latestRevision||base.freshness!=='matches'||!legacy.found||legacy.freshness!=='matches'||!legacyCostMatchesBase(legacy.inventory,base.inventory.raw)||!sameAttributionEvidence(base.choices,legacy.choices))return null;
 return legacy;
}
/** A legacy-only review cannot stand in for unrelated incoming corrections. */
export function matchingLegacyOverview(coverage:ReturnType<typeof parseLegacyRecordedCoverage>):LegacyCostSaved|null{
 const legacy=matchingLegacyBase(coverage),base=coverage.review;
 if(!legacy||!base.found||hasUnsupportedLegacyIncoming(legacy.inventory,base.choices,base.inventory))return null;
 return legacy;
}
