import {sameAttributionEvidence} from './historicalAttribution';
import {correctionAmount,parseCorrectionReview,relatedCorrectionCases,type CorrectionCase,type CorrectionKind,type CorrectionReview} from './projectCostCorrection';
import type {PaidAdjustment} from './paidAdjustments';
import type {PeriodCase} from './paidPeriodCases';

type Line={project_id:string;original_gross:string;gross_change:string;corrected_gross:string};
export type CrossSiteIllustration={source_kind:CorrectionKind;case_id:string;source_id:string;original_gross:string;gross_change:string;corrected_gross:string;sites:Line[];incomplete:true};
export type CrossSiteEvidence={raw:Record<string,unknown>;illustration:CrossSiteIllustration};
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const fixed=(x:unknown,signed=false):bigint=>{if(typeof x!=='string'||!(signed?/^-?(?:0|[1-9]\d{0,9})\.\d{2}$/:/^(?:0|[1-9]\d{0,9})\.\d{2}$/).test(x))throw Error('Invalid site amount');return correctionAmount(x).cents;};
const format=(x:bigint)=>{const n=x<0n?-x:x;return `${x<0n?'-':''}${n/100n}.${String(n%100n).padStart(2,'0')}`;};

/** Separately recompute a single-source illustration in integer centavos. This
 * cannot prove the original records, inclusion decisions, or later freshness. */
export function parseCrossSiteEvidence(raw:unknown,kind:CorrectionKind,item:CorrectionCase,expectedReview:CorrectionReview):CrossSiteEvidence{
 if(!object(raw)||new TextEncoder().encode(JSON.stringify(raw)).length>262144||raw.source_kind!==kind||raw.case_id!==item.id||!object(raw.original)||!object(raw.correction))throw Error('Invalid cross-site evidence');
 const original=raw.original,review=parseCorrectionReview(raw.correction,kind,item),attribution=review.attribution;
 if(!sameAttributionEvidence(review,expectedReview)||!attribution||attribution.case_changed||relatedCorrectionCases(review.case).length!==1||!sameAttributionEvidence(original.case_snapshot,review.case)||original.source_kind!==kind||original.case_id!==item.id||typeof original.case_fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(original.case_fingerprint))throw Error('Current single-case evidence required');
 const expected=kind==='voucher'?(item as PaidAdjustment).original_voucher:(item as PeriodCase).original_snapshot;
 const source=kind==='voucher'?(item as PaidAdjustment).payroll_id:(item as PeriodCase).source_id;
 const worker=kind==='voucher'?(item as PaidAdjustment).worker_id:(item as PeriodCase).original_snapshot.person_id;
 const start=kind==='voucher'?(item as PaidAdjustment).original_voucher.period_start:(item as PeriodCase).original_snapshot.start;
 const end=kind==='voucher'?(item as PaidAdjustment).original_voucher.period_end:(item as PeriodCase).original_snapshot.end;
 const gross=kind==='voucher'?(expected as PaidAdjustment['original_voucher']).gross_pay:(expected as PeriodCase['original_snapshot']).gross;
 if(!uuid(source)||!uuid(worker)||original.source_id!==source||original.worker_id!==worker||original.period_start!==start||original.period_end!==end||fixed(original.original_gross)!==correctionAmount(gross).cents||!Array.isArray(original.sites)||original.sites.length<1||original.sites.length>50)throw Error('Original source differs');
 const map=new Map<string,{original:bigint;change:bigint}>();let originalTotal=0n,changeTotal=0n;
 for(const value of original.sites){if(!object(value)||!uuid(value.project_id)||map.has(value.project_id))throw Error('Invalid original site');const amount=fixed(value.gross);map.set(value.project_id,{original:amount,change:0n});originalTotal+=amount;}
 for(const line of attribution.split){const amount=fixed(line.gross_change,true);if(amount===0n||!uuid(line.project_id))throw Error('Invalid correction site');const entry=map.get(line.project_id)??{original:0n,change:0n};entry.change=amount;map.set(line.project_id,entry);changeTotal+=amount;}
 const grossTotal=fixed(original.original_gross),grossChange=fixed(attribution.gross_change,true);
 if(originalTotal!==grossTotal||changeTotal!==grossChange||grossTotal+grossChange<0n)throw Error('Site totals differ');
 const sites=[...map.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([project_id,x])=>{if(x.original+x.change<0n)throw Error('Site cost is negative');return {project_id,original_gross:format(x.original),gross_change:format(x.change),corrected_gross:format(x.original+x.change)};});
 return {raw,illustration:{source_kind:kind,case_id:item.id,source_id:source,original_gross:format(grossTotal),gross_change:format(grossChange),corrected_gross:format(grossTotal+grossChange),sites,incomplete:true}};
}
export function verifyCrossSiteIllustration(raw:unknown,expected:CrossSiteIllustration):CrossSiteIllustration{
 if(!sameAttributionEvidence(raw,expected))throw Error('Cross-site preview differs from reviewed evidence');return expected;
}
