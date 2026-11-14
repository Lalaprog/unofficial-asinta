import type {PaidReviewVoucher} from './paidReview';

export type HistoricalSnapshot={id:string;worker_id:string;period_start:string;period_end:string;status:'paid';gross_pay:string;bale_deduction:string;other_deductions:string;net_pay:string};
export type HistoricalAttempt={kind:'date'|'bale';request:string;snapshot:HistoricalSnapshot;date:string;note:string;project:string|null};
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const date=(v:unknown):v is string=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(`${v}T00:00:00Z`))&&new Date(`${v}T00:00:00Z`).toISOString().slice(0,10)===v&&v>='1900-01-01'&&v<='9998-12-31';
const money=(v:unknown):v is string=>typeof v==='string'&&/^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/.test(v);
const cents=(v:string)=>{const [whole,fraction='']=v.split('.');return BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0'));};
/** Exact database snapshot for the server, without JS float conversions. */
export function parseHistoricalSnapshot(raw:unknown):HistoricalSnapshot {
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Invalid voucher snapshot');
 const s=raw as HistoricalSnapshot;
 const keys=['id','worker_id','period_start','period_end','status','gross_pay','bale_deduction','other_deductions','net_pay'];
 if(Object.keys(raw).sort().join(',')!==keys.sort().join(',')||!uuid(s.id)||!uuid(s.worker_id)||!date(s.period_start)||!date(s.period_end)||s.period_start>s.period_end||s.status!=='paid'||![s.gross_pay,s.bale_deduction,s.other_deductions,s.net_pay].every(money))throw Error('Invalid voucher snapshot');
 return s;
}
export function snapshotMatchesVoucher(s:HistoricalSnapshot,v:PaidReviewVoucher):boolean {
 return s.id===v.id&&s.worker_id===v.worker_id&&s.period_start===v.period_start&&s.period_end===v.period_end&&(['gross_pay','bale_deduction','other_deductions','net_pay'] as const).every(k=>money(v[k])&&cents(s[k])===cents(v[k]));
}
export function parseHistoricalAttempt(raw:unknown,v:PaidReviewVoucher):HistoricalAttempt {
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Invalid saved request');const a=raw as HistoricalAttempt;const s=parseHistoricalSnapshot(a.snapshot);
 if(!uuid(a.request)||!['date','bale'].includes(a.kind)||!date(a.date)||typeof a.note!=='string'||a.note!==a.note.trim()||a.note.length<1||a.note.length>500||s.id!==v.id||s.worker_id!==v.worker_id||s.period_start!==v.period_start||s.period_end!==v.period_end)throw Error('Invalid saved request');
 if(a.kind==='date'&&(a.project!==null||a.date<s.period_start))throw Error('Invalid date request');
 if(a.kind==='bale'&&(!uuid(a.project)||a.date<s.period_start||a.date>s.period_end||cents(s.bale_deduction)<=0n||cents(s.bale_deduction)>=10000000000n))throw Error('Invalid Bale request');
 return {kind:a.kind,request:a.request,snapshot:s,date:a.date,note:a.note,project:a.project};
}
export function historicalArguments(a:HistoricalAttempt){
 return a.kind==='date'?{p_request:a.request,p_payroll:a.snapshot.id,p_expected:a.snapshot,p_date:a.date,p_note:a.note}:{p_request:a.request,p_payroll:a.snapshot.id,p_expected:a.snapshot,p_project:a.project,p_release_date:a.date,p_amount:a.snapshot.bale_deduction,p_note:a.note};
}
export function verifyHistoricalResult(raw:unknown,a:HistoricalAttempt):void {
 if(!raw||typeof raw!=='object')throw Error('Unverified response');const r=raw as Record<string,unknown>;
 if(r.request_id!==a.request||r.payroll_id!==a.snapshot.id||typeof r.replayed!=='boolean'||(a.kind==='date'&&r.payment_date!==a.date))throw Error('Unverified response');
}
export function isSundayWeek(start:string,end:string):boolean {return date(start)&&date(end)&&new Date(`${start}T00:00:00Z`).getUTCDay()===0&&Date.parse(`${end}T00:00:00Z`)-Date.parse(`${start}T00:00:00Z`)===6*86400000;}
