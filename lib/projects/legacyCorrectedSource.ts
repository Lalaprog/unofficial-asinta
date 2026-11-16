import {sameAttributionEvidence} from '@/lib/payroll/historicalAttribution';
import {parseAdjustmentList} from '@/lib/payroll/paidAdjustments';
import {correctionAmount,parseCorrectionReview,relatedCorrectionCases,type CorrectionReview} from '@/lib/payroll/projectCostCorrection';
import type {LegacyStatus} from '@/lib/payroll/legacyVoucherAttribution';

const obj=(x:unknown):x is Record<string,unknown>=>!!x&&typeof x==='object'&&!Array.isArray(x);
const uuid=(x:unknown):x is string=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(x);
export type LegacyCorrectedCase={id:string;review:CorrectionReview};
export type LegacyCorrectedSource={cases:LegacyCorrectedCase[];siteGross:string;originalSiteGross:string;siteChange:string};
/** Independently reconcile every case and every affected site using cents. */
export function parseLegacyCorrectedSource(raw:unknown,status:Extract<LegacyStatus,{found:true}>,projectId:string):LegacyCorrectedSource{
 if(!obj(raw)||raw.payroll_id!==status.voucher.id||raw.incomplete!==true||!obj(raw.original)||!Array.isArray(raw.cases)||raw.cases.length!==status.case_count||raw.cases.length>100||!Array.isArray(raw.sites)||raw.sites.length<1||raw.sites.length>150)throw Error('Invalid corrected legacy source');
 const original=correctionAmount(status.snapshot.gross_pay).cents,sites=new Map<string,{before:bigint;effect:bigint}>();
 for(const line of status.split)sites.set(line.project_id,{before:correctionAmount(line.gross).cents,effect:0n});
 const ids=new Set<string>();let totalEffect=0n;
 const cases=raw.cases.map((x:unknown)=>{
  if(!obj(x)||!uuid(x.case_id)||ids.has(x.case_id)||!obj(x.evidence)||!obj(x.evidence.case))throw Error('Invalid legacy case');ids.add(x.case_id);
  const item=parseAdjustmentList({total:1,offset:0,items:[x.evidence.case]},status.voucher.id,0).items[0];
  if(item.id!==x.case_id||!sameAttributionEvidence(item.original_voucher,status.snapshot))throw Error('Legacy case original differs');
  const review=parseCorrectionReview(x.evidence,'voucher',item),attr=review.attribution;
  if(!attr||attr.case_changed||!['settled_external','no_transfer'].includes(item.status))throw Error('Correction is unresolved or stale');
  totalEffect+=correctionAmount(attr.gross_change).cents;
  for(const line of attr.split){const entry=sites.get(line.project_id)??{before:0n,effect:0n};entry.effect+=correctionAmount(line.gross_change).cents;sites.set(line.project_id,entry);}
  return {id:x.case_id,review};
 });
 const sorted=[...ids].sort();for(const c of cases){const related=relatedCorrectionCases(c.review.case);if(JSON.stringify(related.map(r=>r.id).sort())!==JSON.stringify(sorted)||related.some(r=>!['settled_external','no_transfer'].includes(r.status)))throw Error('Related legacy cases differ');}
 if(raw.sites.length!==sites.size)throw Error('Corrected site list differs');let beforeTotal=0n,effectTotal=0n,afterTotal=0n;const seen=new Set<string>();let selected:LegacyCorrectedSource|null=null;
 for(const line of raw.sites){if(!obj(line)||!uuid(line.project_id)||seen.has(line.project_id))throw Error('Duplicate corrected site');seen.add(line.project_id);const expected=sites.get(line.project_id);if(!expected)throw Error('Unexpected corrected site');const before=correctionAmount(line.original_gross),effect=correctionAmount(line.gross_change),after=correctionAmount(line.corrected_gross);if(before.cents!==expected.before||effect.cents!==expected.effect||after.cents!==expected.before+expected.effect||after.cents<0n)throw Error('Corrected legacy site differs');beforeTotal+=before.cents;effectTotal+=effect.cents;afterTotal+=after.cents;
  if(line.project_id===projectId.toLowerCase())selected={cases,siteGross:after.text,originalSiteGross:before.text,siteChange:effect.text};}
 if(!selected||beforeTotal!==original||effectTotal!==totalEffect||afterTotal!==original+totalEffect||correctionAmount(raw.original_gross).cents!==original||correctionAmount(raw.gross_change).cents!==totalEffect||correctionAmount(raw.corrected_gross).cents!==afterTotal)throw Error('Corrected legacy totals differ');return selected;
}
