import type {PaidReviewVoucher} from './paidReview';

type DateEvidence={request_id:string;payment_date:string;note:string;recorded_at:string;recorded_by:string;matches_voucher:boolean};
type BaleEvidence=DateEvidence & {project_id:string;release_date:string;amount:string;payment_date_source:'recorded_payment'|'historical_annotation';context_changed:boolean};
export type HistoricalEvidence={payroll_id:string;worker_id:string;period_start:string;period_end:string;voucher_snapshot:unknown;payment_conflict:boolean;recorded_payment_date:string|null;date_evidence:DateEvidence|null;bale_evidence:BaleEvidence|null};
const date=(s:unknown):s is string=>{if(typeof s!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(s))return false;const d=new Date(`${s}T00:00:00Z`);return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===s;};
const id=(s:unknown):s is string=>typeof s==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const evidence=(x:unknown):x is DateEvidence=>{
 if(!x||typeof x!=='object')return false;const v=x as DateEvidence;
 return id(v.request_id)&&id(v.recorded_by)&&date(v.payment_date)&&typeof v.note==='string'&&v.note.length>0&&v.note.length<=500&&typeof v.recorded_at==='string'&&Number.isFinite(Date.parse(v.recorded_at))&&typeof v.matches_voucher==='boolean';
};
/** Validate the complete response and target, withholding all data on mismatch. */
export function parseHistoricalEvidence(raw:unknown,voucher:PaidReviewVoucher):HistoricalEvidence {
 if(!raw||typeof raw!=='object')throw new Error('Invalid historical evidence');const v=raw as HistoricalEvidence;
 if(v.payroll_id!==voucher.id||v.worker_id!==voucher.worker_id||v.period_start!==voucher.period_start||v.period_end!==voucher.period_end||typeof v.payment_conflict!=='boolean'||(v.recorded_payment_date!==null&&!date(v.recorded_payment_date))||(v.date_evidence!==null&&!evidence(v.date_evidence))||(v.bale_evidence!==null&&!evidence(v.bale_evidence)))throw new Error('Invalid or mismatched historical evidence');
 if(v.payment_conflict!==(v.recorded_payment_date!==null&&v.date_evidence!==null))throw new Error('Inconsistent payment evidence');
 const b=v.bale_evidence;
 if(b&&(!id(b.project_id)||!date(b.release_date)||b.release_date<v.period_start||b.release_date>v.period_end||b.payment_date<b.release_date||typeof b.amount!=='string'||!/^(?:0|[1-9]\d{0,7})\.\d{2}$/.test(b.amount)||b.amount==='0.00'||!['recorded_payment','historical_annotation'].includes(b.payment_date_source)||typeof b.context_changed!=='boolean'))throw new Error('Invalid Bale evidence');
 return v;
}
