import type {PaidReviewVoucher} from './paidReview';

export type PaidVoucherSnapshot={id:string;worker_id:string;period_start:string;period_end:string;status:'paid';gross_pay:string;bale_deduction:string;other_deductions:string;net_pay:string};
export type AdjustmentStatus='pending'|'settled_external'|'no_transfer';
export type PaidAdjustment={id:string;payroll_id:string;worker_id:string;original_voucher:PaidVoucherSnapshot;difference:string;reason:string;status:AdjustmentStatus;created_at:string;created_by:string;resolved_at:string|null;resolved_by:string|null;settled_on:string|null;resolution_note:string|null};
export type AdjustmentList={total:number;offset:number;items:PaidAdjustment[]};
const unsigned=/^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/;
const differencePattern=/^-?(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/;
const date=(v:unknown):v is string=>{if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v))return false;const d=new Date(`${v}T00:00:00Z`);return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===v;};
const timestamp=(v:unknown):v is string=>typeof v==='string'&&Number.isFinite(Date.parse(v));
const text=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=500;
export function validDifference(value:string):boolean {
 if(!differencePattern.test(value))return false;
 const [whole,part='']=value.replace('-','').split('.');
 return BigInt(whole)*100n+BigInt(part.padEnd(2,'0'))>0n;
}
export function snapshotFromReview(v:PaidReviewVoucher):PaidVoucherSnapshot {
 return {id:v.id,worker_id:v.worker_id,period_start:v.period_start,period_end:v.period_end,status:'paid',gross_pay:v.gross_pay,bale_deduction:v.bale_deduction,other_deductions:v.other_deductions,net_pay:v.net_pay};
}
export function isPaidVoucherSnapshot(value:unknown):value is PaidVoucherSnapshot {
 if(!value||typeof value!=='object')return false;
 const v=value as PaidVoucherSnapshot;
 return text(v.id)&&text(v.worker_id)&&date(v.period_start)&&date(v.period_end)&&v.period_start<=v.period_end&&v.status==='paid'&&[v.gross_pay,v.bale_deduction,v.other_deductions,v.net_pay].every(x=>typeof x==='string'&&unsigned.test(x));
}
export function sameSnapshot(a:PaidVoucherSnapshot,b:PaidVoucherSnapshot):boolean {
 return (Object.keys(b) as (keyof PaidVoucherSnapshot)[]).every(key=>a[key]===b[key]);
}
/** Refuse malformed, duplicated or silently truncated response pages. */
export function parseAdjustmentList(raw:unknown,voucherId:string,expectedOffset:number):AdjustmentList {
 if(!raw||typeof raw!=='object')throw new Error('Invalid adjustment history');
 const result=raw as AdjustmentList;
 if(!Number.isSafeInteger(result.total)||result.total<0||result.offset!==expectedOffset||!Array.isArray(result.items)||result.items.length!==Math.min(100,Math.max(0,result.total-expectedOffset)))throw new Error('Incomplete adjustment history');
 const ids=new Set<string>();
 for(const item of result.items){
  if(!item||!text(item.id)||ids.has(item.id)||item.payroll_id!==voucherId||!text(item.worker_id)||!isPaidVoucherSnapshot(item.original_voucher)||item.original_voucher.id!==voucherId||item.original_voucher.worker_id!==item.worker_id||typeof item.difference!=='string'||!validDifference(item.difference)||!text(item.reason)||!timestamp(item.created_at)||!text(item.created_by)||!['pending','settled_external','no_transfer'].includes(item.status))throw new Error('Invalid adjustment case');
  if(item.status==='pending'){
   if(item.resolved_at!==null||item.resolved_by!==null||item.settled_on!==null||item.resolution_note!==null)throw new Error('Invalid adjustment decision');
  }else if(!timestamp(item.resolved_at)||!text(item.resolved_by)||!text(item.resolution_note)||(item.status==='settled_external'?!date(item.settled_on):item.settled_on!==null))throw new Error('Invalid adjustment decision');
  ids.add(item.id);
 }
 return result;
}

/** Exact, tab-local retry data; it is sensitive and not a financial ledger. */
export type AdjustmentAttempt =
 | {kind:'open';id:string;snapshot:PaidVoucherSnapshot;difference:string;reason:string}
 | {kind:'resolve';id:string;snapshot:PaidVoucherSnapshot;resolution:'settled_external'|'no_transfer';settled_on:string|null;note:string};
export function parseAdjustmentAttempt(raw:unknown,voucher:PaidReviewVoucher):AdjustmentAttempt {
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Invalid saved case request');
 const a=raw as AdjustmentAttempt;
 if(!text(a.id)||!isPaidVoucherSnapshot(a.snapshot)||a.snapshot.id!==voucher.id||a.snapshot.worker_id!==voucher.worker_id||a.snapshot.period_start!==voucher.period_start||a.snapshot.period_end!==voucher.period_end)throw Error('Invalid saved case scope');
 if(a.kind==='open'){
  if(!validDifference(a.difference)||!text(a.reason)||a.reason!==a.reason.trim())throw Error('Invalid saved case request');
  return {kind:'open',id:a.id,snapshot:a.snapshot,difference:a.difference,reason:a.reason};
 }
 if(a.kind==='resolve'){
  if(!['settled_external','no_transfer'].includes(a.resolution)||!text(a.note)||a.note!==a.note.trim()||(a.resolution==='settled_external'?(!date(a.settled_on)||a.settled_on<a.snapshot.period_start):a.settled_on!==null))throw Error('Invalid saved resolution');
  return {kind:'resolve',id:a.id,snapshot:a.snapshot,resolution:a.resolution,settled_on:a.settled_on,note:a.note};
 }
 throw Error('Invalid saved case request');
}
export function adjustmentAttemptArguments(a:AdjustmentAttempt){
 return a.kind==='open'?{p_id:a.id,p_payroll_id:a.snapshot.id,p_expected:a.snapshot,p_difference:a.difference,p_reason:a.reason}:{p_id:a.id,p_resolution:a.resolution,p_settled_on:a.settled_on,p_note:a.note};
}
export function verifyAdjustmentAttempt(raw:unknown,a:AdjustmentAttempt):void {
 if(!raw||typeof raw!=='object')throw Error('Unverified case response');const r=raw as Record<string,unknown>;
 if(r.id!==a.id||typeof r.replayed!=='boolean'||(a.kind==='open'?(!['pending','settled_external','no_transfer'].includes(String(r.status))||(r.replayed===false&&r.status!=='pending')):r.status!==a.resolution))throw Error('Unverified case response');
}
