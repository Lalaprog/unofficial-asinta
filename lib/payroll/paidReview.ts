export type PaidReviewVoucher = {
 id:string; worker_id:string; worker_name:string|null; period_start:string; period_end:string;
 gross_pay:string; bale_deduction:string; other_deductions:string; net_pay:string;
 overlapping_paid:boolean; period_bale_total:string; period_bale_count:number; unlinked_period_bale_count:number;
};
export type PaidReview = {start:string;end:string;vouchers:PaidReviewVoucher[]};
const money=/^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/;
function moneyCents(s:string):bigint {if(!money.test(s))throw new Error('Invalid amount in paid review');const [a,b='']=s.split('.');return BigInt(a)*100n+BigInt(b.padEnd(2,'0'));}
function validDate(s:unknown):s is string {if(typeof s!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(s))return false;const d=new Date(`${s}T00:00:00Z`);return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===s;}
export function validReviewRange(start:string,end:string):boolean {
 return validDate(start)&&validDate(end)&&start>='1900-01-01'&&end<='9998-12-31'&&start<=end&&(Date.parse(`${end}T00:00:00Z`)-Date.parse(`${start}T00:00:00Z`))/86400000<=92;
}
/** Unrecognized or truncated responses are never presented as a clean ledger. */
export function parsePaidReview(raw:unknown,start:string,end:string):PaidReview {
 if(!validReviewRange(start,end)||!raw||typeof raw!=='object')throw new Error('Invalid paid review response');
 const v=raw as PaidReview;
 if(v.start!==start||v.end!==end||!Array.isArray(v.vouchers)||v.vouchers.length>500)throw new Error('Invalid paid review response');
 const ids=new Set<string>();
 for(const p of v.vouchers){
  if(!p||typeof p.id!=='string'||!p.id||ids.has(p.id)||typeof p.worker_id!=='string'||!p.worker_id||(p.worker_name!==null&&typeof p.worker_name!=='string')||!validDate(p.period_start)||!validDate(p.period_end)||p.period_start>p.period_end||p.period_start>end||p.period_end<start||typeof p.overlapping_paid!=='boolean'||!Number.isSafeInteger(p.period_bale_count)||p.period_bale_count<0||p.period_bale_count>10000||!Number.isSafeInteger(p.unlinked_period_bale_count)||p.unlinked_period_bale_count<0||p.unlinked_period_bale_count>p.period_bale_count)throw new Error('Invalid voucher in paid review');
  for(const value of [p.gross_pay,p.bale_deduction,p.other_deductions,p.net_pay,p.period_bale_total]){if(typeof value!=='string')throw new Error('Invalid amount in paid review');moneyCents(value);}
  ids.add(p.id);
 }
 return v;
}
export function paidReviewSignals(v:PaidReviewVoucher):string[]{
 const signals:string[]=[];
 if(v.overlapping_paid)signals.push('Another paid voucher overlaps this worker and period.');
 if(moneyCents(v.bale_deduction)!==moneyCents(v.period_bale_total))signals.push('Voucher Bale deduction differs from recorded non-cancelled Bale dated within the period.');
 if(v.unlinked_period_bale_count>0)signals.push(`${v.unlinked_period_bale_count} period Bale record(s) have no matching issued request.`);
 return signals;
}
