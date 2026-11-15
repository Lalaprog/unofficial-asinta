import {attributionMoney,parseAttributionSplit,sameAttributionEvidence,type AttributionSplit} from './historicalAttribution';
import {isPaidVoucherSnapshot,type PaidVoucherSnapshot} from './paidAdjustments';
import type {PaidReviewVoucher} from './paidReview';

export type LegacyWorker={id:string;name:string;position:string|null;active:boolean};
export type LegacyAttempt={version:1;request:string;actor:string;voucher:PaidVoucherSnapshot;worker:LegacyWorker;split:AttributionSplit[];note:string};
export type LegacyStatus={found:false;voucher:PaidVoucherSnapshot;worker:LegacyWorker;eligible:boolean;risks:string[]}|{found:true;voucher:PaidVoucherSnapshot;worker:LegacyWorker;eligible:false;risks:string[];request_id:string;snapshot:PaidVoucherSnapshot;recorded_worker:LegacyWorker;split:AttributionSplit[];note:string;actor_id:string;recorded_at:string;source_changed:boolean;case_count:number};
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const note=(v:unknown):v is string=>typeof v==='string'&&v===v.trim()&&v.length>0&&v.length<=500&&!/[\x00-\x1f\x7f]/.test(v);
const allowedRisks=['not_paid','invalid_amounts','invalid_period','generated_or_allocated','possible_supervisor','possible_duplicate_worker','overlapping_payroll','correction_cases'];
function worker(v:unknown,id:string):LegacyWorker{
 if(!object(v)||Object.keys(v).sort().join(',')!=='active,id,name,position'||v.id!==id||!uuid(v.id)||typeof v.name!=='string'||!v.name.trim()||v.name.length>500||(v.position!==null&&typeof v.position!=='string')||typeof v.active!=='boolean')throw Error('Invalid worker evidence');return v as LegacyWorker;
}
function voucher(v:unknown,scope:PaidReviewVoucher):PaidVoucherSnapshot{
 if(!object(v)||Object.keys(v).sort().join(',')!=='bale_deduction,gross_pay,id,net_pay,other_deductions,period_end,period_start,status,worker_id'||!isPaidVoucherSnapshot(v)||!uuid(v.id)||!uuid(v.worker_id)||v.id!==scope.id||v.worker_id!==scope.worker_id||v.period_start!==scope.period_start||v.period_end!==scope.period_end)throw Error('Invalid voucher evidence');
 const values=[v.gross_pay,v.bale_deduction,v.other_deductions,v.net_pay].map(attributionMoney);const reviewed=[scope.gross_pay,scope.bale_deduction,scope.other_deductions,scope.net_pay].map(attributionMoney);
 if(values.some((amount,i)=>amount.cents!==reviewed[i].cents)||values[0].cents<=0n||values[0].cents-values[1].cents-values[2].cents!==values[3].cents)throw Error('Voucher amounts changed');return v;
}
export function parseLegacyStatus(raw:unknown,scope:PaidReviewVoucher):LegacyStatus{
 if(!object(raw)||raw.payroll_id!==scope.id||typeof raw.found!=='boolean'||typeof raw.eligible!=='boolean'||!Array.isArray(raw.risks)||raw.risks.some(r=>typeof r!=='string'||!allowedRisks.includes(r))||new Set(raw.risks).size!==raw.risks.length)throw Error('Invalid attribution status');
 const current=voucher(raw.voucher,scope),currentWorker=worker(raw.worker,scope.worker_id);if(raw.worker_name!==currentWorker.name)throw Error('Worker identity differs');
 if(!raw.found){if(raw.eligible!==(raw.risks.length===0))throw Error('Invalid eligibility');return {found:false,voucher:current,worker:currentWorker,eligible:raw.eligible,risks:raw.risks as string[]};}
 if(raw.eligible!==false||!uuid(raw.request_id)||!uuid(raw.actor_id)||!note(raw.note)||typeof raw.recorded_at!=='string'||!Number.isFinite(Date.parse(raw.recorded_at))||typeof raw.source_changed!=='boolean'||!Number.isSafeInteger(raw.case_count)||Number(raw.case_count)<0)throw Error('Invalid attribution evidence');
 const original=voucher(raw.snapshot,scope),originalWorker=worker(raw.recorded_worker,scope.worker_id),split=parseAttributionSplit(raw.split,original.gross_pay);
 if(!raw.source_changed&&(!sameAttributionEvidence(current,original)||!sameAttributionEvidence(currentWorker,originalWorker)||raw.risks.length>0||raw.case_count!==0))throw Error('Changed source was not flagged');
 return {found:true,voucher:current,worker:currentWorker,eligible:false,risks:raw.risks as string[],request_id:raw.request_id,snapshot:original,recorded_worker:originalWorker,split,note:raw.note,actor_id:raw.actor_id,recorded_at:raw.recorded_at,source_changed:raw.source_changed,case_count:Number(raw.case_count)};
}
export function parseLegacyAttempt(raw:unknown,actor:string,scope:PaidReviewVoucher):LegacyAttempt{
 if(!object(raw)||Object.keys(raw).sort().join(',')!=='actor,note,request,split,version,voucher,worker'||raw.version!==1||!uuid(raw.request)||raw.actor!==actor||!uuid(actor)||!note(raw.note))throw Error('Invalid saved request');
 const source=voucher(raw.voucher,scope),person=worker(raw.worker,scope.worker_id),split=parseAttributionSplit(raw.split,source.gross_pay);
 return {version:1,request:raw.request,actor,voucher:source,worker:person,split,note:raw.note};
}
export function legacyStatusMatches(status:LegacyStatus,attempt:LegacyAttempt):boolean{
 return status.found&&!status.source_changed&&status.request_id===attempt.request&&status.actor_id===attempt.actor&&status.note===attempt.note&&sameAttributionEvidence(status.snapshot,attempt.voucher)&&sameAttributionEvidence(status.recorded_worker,attempt.worker)&&sameAttributionEvidence(status.split,attempt.split);
}
export function legacyArguments(a:LegacyAttempt){return {p_request:a.request,p_payroll:a.voucher.id,p_expected:a.voucher,p_expected_worker:a.worker,p_split:a.split,p_note:a.note,p_ack:true};}
