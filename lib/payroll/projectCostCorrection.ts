import {parseAdjustmentList,validDifference,type PaidAdjustment} from './paidAdjustments';
import {parsePeriodCases,type PeriodCase} from './paidPeriodCases';
import {sameAttributionEvidence} from './historicalAttribution';

export type CorrectionKind='voucher'|'external_worker';
export type CorrectionCase=PaidAdjustment|PeriodCase;
export type CorrectionSplit={project_id:string;gross_change:string};
export type CorrectionAttempt={actor:string;request:string;kind:CorrectionKind;case_id:string;expected_revision:number;expected_case:Record<string,unknown>;gross_change:string;split:CorrectionSplit[];note:string};
export type CorrectionAttribution={request_id:string;revision:number;case_snapshot:Record<string,unknown>;case_changed:boolean;gross_change:string;split:CorrectionSplit[];note:string;recorded_by:string;recorded_at:string};
export type CorrectionReview={case:Record<string,unknown>;latest_revision:number;attribution:CorrectionAttribution|null};
const obj=(x:unknown):x is Record<string,unknown>=>!!x&&typeof x==='object'&&!Array.isArray(x);
const uuid=(x:unknown):x is string=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);
const note=(x:unknown):x is string=>typeof x==='string'&&x===x.trim()&&x.length>0&&x.length<=500&&!/[\x00-\x1f\x7f]/.test(x);
const revision=(x:unknown):x is number=>typeof x==='number'&&Number.isSafeInteger(x)&&x>=0&&x<=2147483647;
export function correctionAmount(value:unknown):{text:string;cents:bigint}{
 if(typeof value!=='string'||!/^(-?)(0|[1-9]\d{0,9})(?:\.(\d{1,2}))?$/.test(value))throw Error('Enter an amount with at most two decimal places');
 const m=value.match(/^(-?)(\d+)(?:\.(\d{1,2}))?$/)!;let cents=BigInt(m[2])*100n+BigInt((m[3]||'').padEnd(2,'0'));
 if(cents>=1000000000000n)throw Error('Amount is too large');if(m[1])cents=-cents;
 return {cents,text:`${cents<0n?'-':''}${m[2]}.${(m[3]||'').padEnd(2,'0')}`};
}
export function correctionSplit(raw:unknown,gross:string):CorrectionSplit[]{
 if(!Array.isArray(raw)||raw.length>50)throw Error('Use at most 50 sites');const ids=new Set<string>();let sum=0n;
 const values=raw.map((item:unknown)=>{if(!obj(item)||Object.keys(item).sort().join(',')!=='gross_change,project_id'||!uuid(item.project_id)||ids.has(item.project_id.toLowerCase()))throw Error('Choose each site only once');
  const amount=correctionAmount(item.gross_change);if(amount.cents===0n)throw Error('Remove zero-value site entries');ids.add(item.project_id.toLowerCase());sum+=amount.cents;return {project_id:item.project_id.toLowerCase(),gross_change:amount.text};});
 if(sum!==correctionAmount(gross).cents)throw Error('Site changes must add up to the total gross change');return values.sort((a,b)=>a.project_id.localeCompare(b.project_id));
}
export type RelatedCorrectionCase={id:string;status:string;difference:string;reason:string;resolution_note:string|null};
export function relatedCorrectionCases(raw:Record<string,unknown>):RelatedCorrectionCase[]{
 if(!Array.isArray(raw.related_cases)||raw.related_cases.length<1||raw.related_cases.length>100)throw Error('Incomplete related case history');
 const ids=new Set<string>();const cases=raw.related_cases.map((c:unknown)=>{
  if(!obj(c)||!uuid(c.id)||ids.has(c.id.toLowerCase())||typeof c.status!=='string'||!['pending','settled_external','no_transfer'].includes(c.status)||typeof c.difference!=='string'||!validDifference(c.difference)||typeof c.reason!=='string'||!c.reason.trim()||c.reason.length>500||typeof c.original_fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(c.original_fingerprint)||(c.resolution_note!==null&&(typeof c.resolution_note!=='string'||!c.resolution_note.trim()||c.resolution_note.length>500)))throw Error('Invalid related case');
  ids.add(c.id.toLowerCase());return {id:c.id,status:c.status,difference:c.difference,reason:c.reason,resolution_note:c.resolution_note as string|null};
 });
 const own=cases.find(c=>c.id===raw.id);if(!own||own.status!==raw.status||own.difference!==raw.difference||own.reason!==raw.reason||own.resolution_note!==raw.resolution_note)throw Error('Related case differs');return cases;
}
/** Check backend evidence against the exact parent case being reviewed. */
export function correctionCase(raw:unknown,kind:CorrectionKind,expected:CorrectionCase):Record<string,unknown>{
 if(!obj(raw)||JSON.stringify(raw).length>65536||raw.id!==expected.id)throw Error('Invalid correction case');
 relatedCorrectionCases(raw);
 if(kind==='voucher'){
  const e=expected as PaidAdjustment;
  const parsed=parseAdjustmentList({total:1,offset:0,items:[raw]},e.payroll_id,0).items[0];
  const comparable=Object.fromEntries(Object.keys(e).map(key=>[key,raw[key]]));
  if(!sameAttributionEvidence(comparable,e)||parsed.status==='pending')throw Error('Correction case changed');
 }else{
  const e=expected as PeriodCase;if(e.source_kind!=='external_worker'||raw.source_kind!=='external_worker'||raw.external_worker_id!==e.source_id||raw.supervisor_payroll_id!==null)throw Error('Wrong original worker period');
  const normalized={...raw,source_id:raw.external_worker_id};
  const parsed=parsePeriodCases({snapshot:e.original_snapshot,total:1,items:[normalized]},e.original_snapshot)[0];
  const comparable=Object.fromEntries(Object.keys(e).map(key=>[key,normalized[key as keyof typeof normalized]]));
  if(!sameAttributionEvidence(comparable,e)||parsed.status==='pending')throw Error('Correction case changed');
 }
 return raw;
}
export function parseCorrectionReview(raw:unknown,kind:CorrectionKind,expected:CorrectionCase):CorrectionReview{
 if(!obj(raw)||raw.source_kind!==kind||raw.case_id!==expected.id||!revision(raw.latest_revision))throw Error('Invalid correction review');
 const c=correctionCase(raw.case,kind,expected),rev=raw.latest_revision;
 if(raw.attribution===null){if(rev!==0)throw Error('Missing correction revision');return {case:c,latest_revision:0,attribution:null};}
 const a=raw.attribution;if(!obj(a)||!uuid(a.request_id)||a.revision!==rev||rev===0||!obj(a.case_snapshot)||typeof a.case_changed!=='boolean'||!note(a.note)||!uuid(a.recorded_by)||typeof a.recorded_at!=='string'||!Number.isFinite(Date.parse(a.recorded_at)))throw Error('Invalid correction attribution');
 const gross=correctionAmount(a.gross_change).text,split=correctionSplit(a.split,gross);
 if(!sameAttributionEvidence(split,a.split)||a.case_changed!==!sameAttributionEvidence(a.case_snapshot,c))throw Error('Changed or malformed attribution');
 return {case:c,latest_revision:rev,attribution:{request_id:a.request_id,revision:rev,case_snapshot:a.case_snapshot,case_changed:a.case_changed,gross_change:gross,split,note:a.note,recorded_by:a.recorded_by,recorded_at:a.recorded_at}};
}
export function parseCorrectionAttempt(raw:unknown,actor:string,kind:CorrectionKind,expected:CorrectionCase):CorrectionAttempt{
 if(!obj(raw)||Object.keys(raw).sort().join(',')!=='actor,case_id,expected_case,expected_revision,gross_change,kind,note,request,split'||!uuid(raw.actor)||raw.actor!==actor||!uuid(raw.request)||raw.kind!==kind||raw.case_id!==expected.id||!revision(raw.expected_revision)||raw.expected_revision>=2147483647||!note(raw.note))throw Error('Invalid saved correction');
 const expectedCase=correctionCase(raw.expected_case,kind,expected),gross=correctionAmount(raw.gross_change).text,split=correctionSplit(raw.split,gross);
 return {actor,request:raw.request,kind,case_id:expected.id,expected_revision:raw.expected_revision,expected_case:expectedCase,gross_change:gross,split,note:raw.note};
}
export function correctionArguments(a:CorrectionAttempt){return {p_request:a.request,p_kind:a.kind,p_case:a.case_id,p_expected_revision:a.expected_revision,p_expected_case:a.expected_case,p_gross_change:a.gross_change,p_split:a.split,p_note:a.note,p_ack:true};}
