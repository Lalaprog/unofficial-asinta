import {sameAttributionEvidence,attributionMoney} from '@/lib/payroll/historicalAttribution';
import {parseLegacyStatus,type LegacyStatus} from '@/lib/payroll/legacyVoucherAttribution';
import type {PaidReviewVoucher} from '@/lib/payroll/paidReview';
import {calculateCorrected,parseCorrectedInventory,verifyCorrectedTotals,type CorrectedChoices,type CorrectedInventory,type CorrectedTotals} from './correctedCostReview';
import {parseReviewMarker,validReviewNote,type ReviewDecision,type ReviewMarker} from './projectCostReview';

const obj=(x:unknown):x is Record<string,unknown>=>!!x&&typeof x==='object'&&!Array.isArray(x);
const uuid=(x:unknown):x is string=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);
const int=(x:unknown):x is number=>typeof x==='number'&&Number.isSafeInteger(x)&&x>=0&&x<=2147483647;
const text=(x:unknown,max:number):x is string=>typeof x==='string'&&x===x.trim()&&x.length>0&&x.length<=max&&!/[\x00-\x1f\x7f-\x9f]/.test(x);
const cents=(v:unknown):bigint=>{if(typeof v!=='string'||!/^(?:0|[1-9]\d{0,13})\.\d{2}$/.test(v))throw Error('Invalid legacy review total');const [a,b]=v.split('.');return BigInt(a)*100n+BigInt(b);};
export type LegacyVoucherItem={requestId:string;payrollId:string;siteGross:string;status:Extract<LegacyStatus,{found:true}>};
export type LegacyCostInventory={raw:unknown;base:CorrectedInventory;legacy:LegacyVoucherItem[]};
export type LegacyCostTotals={base:CorrectedTotals;included:bigint;excluded:bigint;excludedCount:number;total:bigint};
export type LegacyCostChoices=Record<string,ReviewDecision>;
/** Validate all source identities and amounts before using a server result. */
export function parseLegacyCostInventory(raw:unknown,projectId:string):LegacyCostInventory{
 if(!obj(raw)||raw.project_id!==projectId||!uuid(projectId)||!Array.isArray(raw.legacy_vouchers)||raw.legacy_vouchers.length>500)throw Error('Invalid legacy inventory');
 const base=parseCorrectedInventory(raw.base,projectId),seenRequests=new Set<string>(),seenPayroll=new Set<string>();
 const legacy=raw.legacy_vouchers.map((row:unknown)=>{
  if(!obj(row)||!uuid(row.request_id)||!uuid(row.payroll_id)||!obj(row.status)||!obj(row.status.voucher))throw Error('Invalid legacy voucher');
  const v=row.status.voucher;
  // The status parser independently validates this paid snapshot and exact split;
  // the review has no other voucher scope, so identity is additionally checked below.
  const scope={...v,worker_name:row.status.worker_name} as unknown as PaidReviewVoucher;
  const status=parseLegacyStatus(row.status,scope);
  if(!status.found||status.source_changed||status.case_count!==0||status.request_id!==row.request_id||status.snapshot.id!==row.payroll_id||status.voucher.id!==row.payroll_id)throw Error('Legacy voucher changed or has corrections');
  if(seenRequests.has(row.request_id)||seenPayroll.has(row.payroll_id)||base.historical.base.paid.some(p=>p.payrollId===row.payroll_id))throw Error('Duplicate legacy voucher');
  seenRequests.add(row.request_id);seenPayroll.add(row.payroll_id);
  const site=status.split.find(s=>s.project_id===projectId.toLowerCase());if(!site||attributionMoney(row.site_gross).cents!==attributionMoney(site.gross).cents)throw Error('Legacy site amount differs');
  return {requestId:row.request_id,payrollId:row.payroll_id,siteGross:site.gross,status};
 });
 return {raw,base,legacy};
}
export function calculateLegacyCost(inv:LegacyCostInventory,baseChoices:unknown,legacyChoices:unknown):{choices:CorrectedChoices;legacyChoices:LegacyCostChoices;totals:LegacyCostTotals}{
 if(!obj(legacyChoices)||Object.keys(legacyChoices).length!==inv.legacy.length)throw Error('Review every legacy voucher');
 const base=calculateCorrected(inv.base,baseChoices),choices:LegacyCostChoices={};let included=0n,excluded=0n,excludedCount=0;
 for(const row of inv.legacy){const d=legacyChoices[row.requestId];if(!obj(d)||Object.keys(d).sort().join(',')!=='decision,reason'||(d.decision!=='include'&&d.decision!=='exclude')||(d.decision==='include'?d.reason!==null:!text(d.reason,300)))throw Error('Invalid legacy decision');
  choices[row.requestId]={decision:d.decision,reason:d.reason as string|null};const amount=attributionMoney(row.siteGross).cents;if(d.decision==='include')included+=amount;else{excluded+=amount;excludedCount++;}}
 const total=base.totals.total+included;if(total>=10000000000000000n)throw Error('Legacy cost exceeds limit');
 return {choices:base.choices,legacyChoices:choices,totals:{base:base.totals,included,excluded,excludedCount,total}};
}
export function verifyLegacyCostTotals(raw:unknown,projectId:string,expected:LegacyCostTotals):LegacyCostTotals{
 if(!obj(raw)||raw.project_id!==projectId||raw.incomplete!==true||raw.legacy_excluded_count!==expected.excludedCount||cents(raw.legacy_included_gross)!==expected.included||cents(raw.legacy_excluded_gross)!==expected.excluded||cents(raw.incomplete_total)!==expected.total)throw Error('Legacy cost differs');
 verifyCorrectedTotals(raw.base,projectId,expected.base);return expected;
}
export type LegacyCostSaved={found:true;revision:number;latestRevision:number;requestId:string;actorId:string;recordedAt:string;note:string;freshness:'matches'|'changed'|'unavailable';inventory:LegacyCostInventory;choices:CorrectedChoices;legacyChoices:LegacyCostChoices;totals:LegacyCostTotals};
export function parseLegacyCostSaved(raw:unknown,projectId:string):{found:false;latestRevision:0}|LegacyCostSaved{
 if(!obj(raw)||raw.project_id!==projectId||!uuid(projectId)||typeof raw.found!=='boolean'||!int(raw.latest_revision))throw Error('Invalid legacy review');
 if(!raw.found){if(raw.latest_revision!==0)throw Error('Invalid empty review');return {found:false,latestRevision:0};}
 if(!int(raw.revision)||raw.revision<1||raw.revision>raw.latest_revision||!uuid(raw.request_id)||!uuid(raw.actor_id)||!text(raw.note,500)||typeof raw.recorded_at!=='string'||!Number.isFinite(Date.parse(raw.recorded_at))||!['matches','changed','unavailable'].includes(String(raw.freshness)))throw Error('Invalid legacy review metadata');
 const inventory=parseLegacyCostInventory(raw.snapshot,projectId),calc=calculateLegacyCost(inventory,raw.choices,raw.legacy_choices);verifyLegacyCostTotals(raw.result,projectId,calc.totals);
 return {found:true,latestRevision:raw.latest_revision,revision:raw.revision,requestId:raw.request_id,actorId:raw.actor_id,recordedAt:raw.recorded_at,note:raw.note,freshness:raw.freshness as LegacyCostSaved['freshness'],inventory,...calc};
}
export type LegacyCostAttempt={marker:ReviewMarker;raw:unknown;choices:CorrectedChoices;legacyChoices:LegacyCostChoices;note:string};
export function parseLegacyCostAttempt(serialized:string,projectId:string,actorId:string):LegacyCostAttempt{
 if(serialized.length>3000000)throw Error('Saved review too large');const value:unknown=JSON.parse(serialized);
 if(!obj(value)||Object.keys(value).sort().join(',')!=='choices,legacyChoices,marker,note,raw,version'||value.version!==1||typeof value.note!=='string'||!validReviewNote(value.note))throw Error('Invalid retry evidence');
 const marker=parseReviewMarker(value.marker,projectId,actorId),inventory=parseLegacyCostInventory(value.raw,projectId),calc=calculateLegacyCost(inventory,value.choices,value.legacyChoices);
 return {marker,raw:value.raw,choices:calc.choices,legacyChoices:calc.legacyChoices,note:value.note};
}
function noCapture(raw:unknown){const copy=JSON.parse(JSON.stringify(raw));delete copy.base.historical_review.base.captured_at;return copy;}
export function legacyCostMatchesAttempt(saved:LegacyCostSaved,a:LegacyCostAttempt):boolean{
 return saved.requestId===a.marker.requestId&&saved.actorId===a.marker.actorId&&saved.revision===a.marker.expectedRevision+1&&saved.note===a.note&&sameAttributionEvidence(noCapture(saved.inventory.raw),noCapture(a.raw))&&sameAttributionEvidence(saved.choices,a.choices)&&sameAttributionEvidence(saved.legacyChoices,a.legacyChoices);
}
export function legacyCostMatchesBase(inv:LegacyCostInventory,rawBase:unknown):boolean{
 const copy=JSON.parse(JSON.stringify(rawBase));delete copy.historical_review.base.captured_at;return sameAttributionEvidence(noCapture(inv.raw).base,copy);
}
