import {sameAttributionEvidence} from '@/lib/payroll/historicalAttribution';
import {parseRecordedCostCoverage} from './recordedCostCoverage';
import {legacyCostMatchesBase,parseLegacyCostSaved,type LegacyCostSaved} from './legacyVoucherCostReview';

/** All readers in this response share the same statement snapshot. */
export function parseLegacyRecordedCoverage(raw:unknown,projectId:string){
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Invalid legacy coverage');const v=raw as Record<string,unknown>,base=parseRecordedCostCoverage(raw,projectId);
 const count=(x:unknown):number=>{if(typeof x!=='number'||!Number.isSafeInteger(x)||x<0)throw Error('Invalid legacy coverage count');return x;};
 const siteAttributions=count(v.legacy_site_attributions),changedAttributions=count(v.changed_legacy_attributions),review=parseLegacyCostSaved(v.legacy_review,projectId);
 if(review.found&&review.revision!==review.latestRevision)throw Error('Not latest legacy review');
 if(review.found&&review.freshness==='matches'&&review.inventory.legacy.length!==siteAttributions)throw Error('Legacy site evidence differs');
 return {...base,siteAttributions,changedAttributions,legacyReview:review};
}
/** A legacy review replaces the ordinary one only if decisions and sources
 * match; do not add two whole reviews or show an out-of-date selection. */
export function matchingLegacyOverview(coverage:ReturnType<typeof parseLegacyRecordedCoverage>):LegacyCostSaved|null{
 const base=coverage.review,legacy=coverage.legacyReview;
 if(!base.found||base.revision!==base.latestRevision||base.freshness!=='matches'||base.inventory.cases.some(c=>!c.sourceInSnapshot)||!legacy.found||legacy.freshness!=='matches'||!legacyCostMatchesBase(legacy.inventory,base.inventory.raw)||!sameAttributionEvidence(base.choices,legacy.choices))return null;
 return legacy;
}
