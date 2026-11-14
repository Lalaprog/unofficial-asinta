import {parseHistoricalCostSnapshot,type HistoricalCostSnapshot} from './projectCostHistoricalReview';
import {costCents,formatCostCents,type CostChoice} from './projectCostReconciliation';
import {parseAdjustmentList,type PaidAdjustment} from '@/lib/payroll/paidAdjustments';
import {parsePeriodCases,parsePeriodSnapshot,type PeriodCase} from '@/lib/payroll/paidPeriodCases';
import {correctionAmount,parseCorrectionReview,relatedCorrectionCases,type CorrectionKind,type CorrectionReview} from '@/lib/payroll/projectCostCorrection';
import type {ReviewDecision} from './projectCostReview';
const obj=(x:unknown):x is Record<string,unknown>=>!!x&&typeof x==='object'&&!Array.isArray(x);
const uuid=(x:unknown):x is string=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);
const text=(x:unknown,max:number):x is string=>typeof x==='string'&&x===x.trim()&&x.length>0&&x.length<=max&&!/[\u0000-\u001f\u007f-\u009f]/.test(x);
const revision=(x:unknown):x is number=>typeof x==='number'&&Number.isSafeInteger(x)&&x>=0&&x<=2147483647;
const total=(x:unknown):bigint=>{if(typeof x!=='string'||!/^(?:0|[1-9]\d{0,13})\.\d{2}$/.test(x))throw Error('Invalid corrected total');const [a,b]=x.split('.');return BigInt(a)*100n+BigInt(b);};
const signedTotal=(x:unknown):bigint=>{if(typeof x!=='string')throw Error('Invalid signed total');return x.startsWith('-')?-total(x.slice(1)):total(x);};
export type CorrectedCase={key:string;kind:CorrectionKind;id:string;sourceId:string;sourceInSnapshot:boolean;status:string;reason:string;difference:string;siteChange:string|null;review:CorrectionReview;pendingSibling:boolean};
export type CorrectedInventory={raw:unknown;historical:HistoricalCostSnapshot;cases:CorrectedCase[]};
export type CorrectedChoices={expenses:Record<string,ReviewDecision>;historical:Record<string,ReviewDecision>;corrections:Record<string,ReviewDecision>};
export type CorrectedTotals={expenses:bigint;excludedExpenses:bigint;paid:bigint;historical:bigint;excludedHistorical:bigint;correction:bigint;excludedCases:number;total:bigint};
export const formatSignedCost=(n:bigint)=>n<0n?`−${formatCostCents(-n)}`:formatCostCents(n);
/** Validate all bounded evidence; missing or malformed case data is not zero. */
export function parseCorrectedInventory(raw:unknown,projectId:string):CorrectedInventory{
 if(!uuid(projectId)||!obj(raw)||raw.project_id!==projectId||!Array.isArray(raw.corrections)||raw.corrections.length>500||JSON.stringify(raw).length>2097152)throw Error('Invalid correction inventory');
 const historical=parseHistoricalCostSnapshot(raw.historical_review,projectId),keys=new Set<string>();
 const cases=raw.corrections.map((row:unknown):CorrectedCase=>{
  if(!obj(row)||!['voucher','external_worker'].includes(String(row.kind))||!uuid(row.case_id)||typeof row.source_in_snapshot!=='boolean'||!obj(row.evidence)||row.evidence.source_kind!==row.kind||row.evidence.case_id!==row.case_id||!obj(row.evidence.case)||row.evidence.case.id!==row.case_id)throw Error('Invalid correction case');
  const kind=row.kind as CorrectionKind,c=row.evidence.case;let item:PaidAdjustment|PeriodCase,sourceId:string;
  if(kind==='voucher'){
   if(!uuid(c.payroll_id))throw Error('Invalid voucher source');sourceId=c.payroll_id;item=parseAdjustmentList({total:1,offset:0,items:[c]},sourceId,0).items[0];
  }else{
   const original=parsePeriodSnapshot(c.original_snapshot);if(original.kind!=='external_worker'||c.external_worker_id!==original.id||c.source_kind!=='external_worker'||c.supervisor_payroll_id!==null)throw Error('Invalid historical correction source');sourceId=original.id;item=parsePeriodCases({snapshot:original,total:1,items:[{...c,source_id:sourceId}]},original)[0];
   const h=historical.historical.find(x=>x.sourceId===sourceId);if(h&&(h.workerId!==original.person_id||h.start!==original.start||h.end!==original.end||h.paidOn!==original.paid_on||costCents(h.originalGross)!==costCents(original.gross)))throw Error('Historical original differs');
  }
  const related=relatedCorrectionCases(c),key=`${kind}:${row.case_id}`;if(keys.has(key))throw Error('Duplicate correction case');keys.add(key);
  const originalPresent=kind==='voucher'?historical.base.paid.some(p=>p.payrollId===sourceId):historical.historical.some(h=>h.sourceId===sourceId);
  if(row.source_in_snapshot!==originalPresent)throw Error('Correction source signal differs');
  if(kind==='voucher'&&originalPresent){
   const signal=historical.base.adjustments.find(x=>x.id===row.case_id),paid=historical.base.paid.find(x=>x.payrollId===sourceId),v=item as PaidAdjustment,o=v.original_voucher;
   if(!signal||!paid||signal.payrollId!==sourceId||signal.workerId!==v.worker_id||signal.status!==v.status||signal.difference!==v.difference||signal.reason!==v.reason||signal.createdAt!==v.created_at||signal.createdBy!==v.created_by||signal.resolvedAt!==v.resolved_at||signal.resolvedBy!==v.resolved_by||signal.settledOn!==v.settled_on||signal.resolutionNote!==v.resolution_note||paid.workerId!==v.worker_id||paid.start!==o.period_start||paid.end!==o.period_end||correctionAmount(o.gross_pay).cents!==costCents(paid.voucherGross)||correctionAmount(o.bale_deduction).cents!==costCents(paid.voucherBale)||correctionAmount(o.other_deductions).cents!==costCents(paid.voucherOther)||correctionAmount(o.net_pay).cents!==costCents(paid.voucherNet))throw Error('Voucher case signal differs');
  }
  let review:CorrectionReview;
  if(item.status==='pending'){
   if(row.evidence.latest_revision!==0||row.evidence.attribution!==null)throw Error('Pending case has unexpected attribution');
   review={case:c,latest_revision:0,attribution:null};
  }else review=parseCorrectionReview(row.evidence,kind,item);
  let siteChange:string|null=null;
  if(review.attribution){const amount=review.attribution.split.find(x=>x.project_id===projectId.toLowerCase())?.gross_change??'0.00';if(row.site_gross_change!==amount)throw Error('Correction site split differs');siteChange=amount;}
  else if(row.site_gross_change!==null)throw Error('Missing correction evidence is not zero');
  if(!originalPresent&&(siteChange===null||correctionAmount(siteChange).cents===0n))throw Error('Unlinked correction lacks site evidence');
  return {key,kind,id:row.case_id,sourceId,sourceInSnapshot:originalPresent,status:item.status,reason:item.reason,difference:item.difference,siteChange,review,pendingSibling:related.some(x=>x.status==='pending')};
 });
 if(historical.base.adjustments.some(a=>!keys.has(`voucher:${a.id}`)))throw Error('Missing voucher correction case');
 for(const h of historical.historical)if(cases.filter(c=>c.kind==='external_worker'&&c.sourceId===h.sourceId&&c.sourceInSnapshot).length!==h.caseCount)throw Error('Missing historical correction cases');
 return {raw,historical,cases};
}
function decision(raw:unknown,correction:boolean):ReviewDecision{
 if(!obj(raw)||Object.keys(raw).sort().join(',')!=='decision,reason'||!['include','exclude'].includes(String(raw.decision)))throw Error('Review every item');
 if(raw.decision==='include'&&!correction){if(raw.reason!==null)throw Error('Invalid inclusion reason');}
 else if(!text(raw.reason,300))throw Error('Explain the decision');
 return {decision:raw.decision as CostChoice,reason:raw.reason as string|null};
}
/** Independent exact-cent verification of the server's deliberately incomplete preview. */
export function calculateCorrected(inv:CorrectedInventory,raw:unknown):{choices:CorrectedChoices;totals:CorrectedTotals}{
 if(!obj(raw)||Object.keys(raw).sort().join(',')!=='corrections,expenses,historical'||!obj(raw.expenses)||!obj(raw.historical)||!obj(raw.corrections))throw Error('Review every item');
 const choices:CorrectedChoices={expenses:{},historical:{},corrections:{}};
 if(Object.keys(raw.expenses).length!==inv.historical.base.expenses.length||Object.keys(raw.historical).length!==inv.historical.historical.length||Object.keys(raw.corrections).length!==inv.cases.length)throw Error('Review every item');
 let expenses=0n,excludedExpenses=0n,paid=0n,historical=0n,excludedHistorical=0n,correction=0n,excludedCases=0;
 for(const e of inv.historical.base.expenses){const d=decision(raw.expenses[e.id],false);choices.expenses[e.id]=d;if(d.decision==='include')expenses+=costCents(e.amount);else excludedExpenses+=costCents(e.amount);}
 for(const p of inv.historical.base.paid)paid+=costCents(p.gross);
 for(const h of inv.historical.historical){const d=decision(raw.historical[h.requestId],false);choices.historical[h.requestId]=d;if(d.decision==='include'){if(h.overlappingVouchers)throw Error('Investigate historical voucher overlap');historical+=costCents(h.siteGross);}else excludedHistorical+=costCents(h.siteGross);}
 const included=new Set<string>();
 for(const c of inv.cases){const d=decision(raw.corrections[c.key],true);choices.corrections[c.key]=d;if(d.decision==='exclude'){excludedCases++;continue;}
  if(!c.sourceInSnapshot||c.status==='pending'||c.pendingSibling||!c.review.attribution||c.review.attribution.case_changed||c.siteChange===null)throw Error('Correction requires current resolved source evidence');
  const source=`${c.kind}:${c.sourceId}`;if(included.has(source))throw Error('Multiple included corrections for one original');included.add(source);
  const original=c.kind==='voucher'?inv.historical.base.paid.find(p=>p.payrollId===c.sourceId)?.gross:inv.historical.historical.find(h=>h.sourceId===c.sourceId&&choices.historical[h.requestId]?.decision==='include'&&h.overlappingVouchers===0)?.siteGross;
  if(original===undefined)throw Error('Correction original is not included');const effect=correctionAmount(c.siteChange).cents;if(costCents(original)+effect<0n)throw Error('Correction exceeds original site cost');correction+=effect;
 }
 const result=expenses+paid+historical+correction;if(result<0n||result>=10000000000000000n)throw Error('Invalid corrected total');
 return {choices,totals:{expenses,excludedExpenses,paid,historical,excludedHistorical,correction,excludedCases,total:result}};
}
export function verifyCorrectedTotals(raw:unknown,projectId:string,expected:CorrectedTotals):CorrectedTotals{
 if(!obj(raw)||raw.project_id!==projectId||raw.incomplete!==true||raw.excluded_cases!==expected.excludedCases||total(raw.included_expenses)!==expected.expenses||total(raw.excluded_expenses)!==expected.excludedExpenses||total(raw.paid_gross)!==expected.paid||total(raw.historical_gross)!==expected.historical||total(raw.excluded_historical)!==expected.excludedHistorical||total(raw.incomplete_total)!==expected.total||signedTotal(raw.correction_gross)!==expected.correction)throw Error('Corrected total differs from evidence');return expected;
}
export type CorrectedSaved={found:true;latestRevision:number;revision:number;requestId:string;actorId:string;recordedAt:string;note:string;freshness:'matches'|'changed'|'unavailable';inventory:CorrectedInventory;choices:CorrectedChoices;totals:CorrectedTotals};
export function parseCorrectedSaved(raw:unknown,projectId:string):{found:false;latestRevision:0}|CorrectedSaved{
 if(!obj(raw)||raw.project_id!==projectId||!uuid(projectId)||typeof raw.found!=='boolean'||!revision(raw.latest_revision))throw Error('Invalid corrected review');
 if(!raw.found){if(raw.latest_revision!==0)throw Error('Invalid empty corrected review');return {found:false,latestRevision:0};}
 if(!revision(raw.revision)||raw.revision<1||raw.revision>raw.latest_revision||!uuid(raw.request_id)||!uuid(raw.actor_id)||typeof raw.recorded_at!=='string'||!Number.isFinite(Date.parse(raw.recorded_at))||!text(raw.note,500)||!['matches','changed','unavailable'].includes(String(raw.freshness)))throw Error('Invalid corrected review metadata');
 const inventory=parseCorrectedInventory(raw.snapshot,projectId),calculated=calculateCorrected(inventory,raw.choices);verifyCorrectedTotals(raw.result,projectId,calculated.totals);
 return {found:true,latestRevision:raw.latest_revision,revision:raw.revision,requestId:raw.request_id,actorId:raw.actor_id,recordedAt:raw.recorded_at,note:raw.note,freshness:raw.freshness as CorrectedSaved['freshness'],inventory,choices:calculated.choices,totals:calculated.totals};
}
