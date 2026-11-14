import {correctionAmount,correctionCase,correctionSplit,type CorrectionKind} from '@/lib/payroll/projectCostCorrection';
import {parseAdjustmentList} from '@/lib/payroll/paidAdjustments';
import {parsePeriodCases,parsePeriodSnapshot} from '@/lib/payroll/paidPeriodCases';
import {sameAttributionEvidence} from '@/lib/payroll/historicalAttribution';
const obj=(x:unknown):x is Record<string,unknown>=>!!x&&typeof x==='object'&&!Array.isArray(x);
const uuid=(x:unknown):x is string=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);
export type ProjectCorrectionEvidence={requestId:string;caseId:string;kind:CorrectionKind;revision:number;siteChange:string;totalChange:string;caseDifference:string;caseStatus:string;reason:string;note:string;recordedBy:string;recordedAt:string;caseChanged:boolean};
/** Validates the bounded server response. Site evidence is not a cost total. */
export function parseProjectCorrectionEvidence(raw:unknown,projectId:string):ProjectCorrectionEvidence[]{
 if(!uuid(projectId)||!obj(raw)||raw.project_id!==projectId||!Array.isArray(raw.items)||raw.items.length>500)throw Error('Invalid correction site evidence');
 const seen=new Set<string>();return raw.items.map((value:unknown)=>{
  if(!obj(value)||!uuid(value.request_id)||!uuid(value.case_id)||!['voucher','external_worker'].includes(String(value.source_kind))||!Number.isSafeInteger(value.revision)||Number(value.revision)<1||!uuid(value.recorded_by)||typeof value.recorded_at!=='string'||!Number.isFinite(Date.parse(value.recorded_at))||typeof value.case_changed!=='boolean'||typeof value.note!=='string'||!value.note.trim()||value.note!==value.note.trim()||value.note.length>500||/[\x00-\x1f\x7f]/.test(value.note)||!obj(value.case))throw Error('Invalid correction evidence');
  const kind=value.source_kind as CorrectionKind,c=value.case;let item;
  if(kind==='voucher'){
   if(!uuid(c.payroll_id))throw Error('Invalid voucher source');item=parseAdjustmentList({total:1,offset:0,items:[c]},c.payroll_id,0).items[0];
  }else{
   const original=parsePeriodSnapshot(c.original_snapshot);if(original.kind!=='external_worker'||!uuid(c.external_worker_id))throw Error('Invalid external source');
   if(c.source_kind!=='external_worker'||c.external_worker_id!==original.id||c.supervisor_payroll_id!==null)throw Error('Invalid external case');
   item=parsePeriodCases({snapshot:original,total:1,items:[{...c,source_id:c.external_worker_id}]},original)[0];
  }
  if(item.id!==value.case_id||item.status==='pending')throw Error('Wrong or unresolved correction case');if(kind==='voucher')correctionCase(c,kind,item);
  const gross=correctionAmount(value.total_gross_change),site=correctionAmount(value.site_gross_change),split=correctionSplit(value.split,gross.text);
  if(site.cents===0n||!sameAttributionEvidence(split,value.split)||split.find(x=>x.project_id===projectId.toLowerCase())?.gross_change!==site.text)throw Error('Correction split differs');
  const unique=`${kind}:${item.id}`;if(seen.has(unique))throw Error('Duplicate correction case');seen.add(unique);
  return {requestId:value.request_id,caseId:item.id,kind,revision:Number(value.revision),siteChange:site.text,totalChange:gross.text,caseDifference:item.difference,caseStatus:item.status,reason:item.reason,note:value.note,recordedBy:value.recorded_by,recordedAt:value.recorded_at,caseChanged:value.case_changed};
 });
}
