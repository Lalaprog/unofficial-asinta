import {workerPayrollPeriod} from './periods';
export type ExternalWorker={id:string;name:string;position:string;active:boolean};
export type ExternalReview={worker:ExternalWorker;start:string;end:string;as_of:string;possible_supervisor:boolean;possible_worker_duplicate:boolean;overlapping_vouchers:number;period_advances:number;older_open_advances:number;existing_assertions:number};
export type ExternalAttempt={request:string;actor:string;worker:ExternalWorker;start:string;paid_on:string;gross:string;bale:string;other:string;net:string;note:string};
export type ExternalRow={request_id:string;worker_id:string;period_start:string;period_end:string;paid_on:string;gross:string;bale:string;other_deductions:string;net:string;evidence_note:string;worker_snapshot:ExternalWorker;recorded_by:string;recorded_at:string};
const uuid=(x:unknown):x is string=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);
const date=(x:unknown):x is string=>{if(typeof x!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(x)||x<'1900-01-01'||x>'9998-12-31')return false;const d=new Date(`${x}T00:00:00Z`);return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===x;};
const cents=(x:unknown):bigint=>{if(typeof x!=='string'||!/^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/.test(x))throw Error('Invalid money');const [whole,part='']=x.split('.');return BigInt(whole)*100n+BigInt(part.padEnd(2,'0'));};
const count=(x:unknown):x is number=>typeof x==='number'&&Number.isSafeInteger(x)&&x>=0;
export function parseExternalWorker(raw:unknown):ExternalWorker{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Invalid worker');const w=raw as ExternalWorker;
 if(Object.keys(raw).sort().join(',')!=='active,id,name,position'||!uuid(w.id)||typeof w.name!=='string'||!w.name.trim()||typeof w.position!=='string'||typeof w.active!=='boolean')throw Error('Invalid worker');return w;
}
export function parseExternalCatalog(raw:unknown):ExternalWorker[]{
 if(!raw||typeof raw!=='object'||!('workers' in raw)||!Array.isArray(raw.workers)||raw.workers.length>2000)throw Error('Invalid catalog');const seen=new Set<string>();return raw.workers.map((x:unknown)=>{const w=parseExternalWorker(x);if(seen.has(w.id))throw Error('Duplicate worker');seen.add(w.id);return w;});
}
export function parseExternalReview(raw:unknown,worker:ExternalWorker,start:string):ExternalReview{
 if(!raw||typeof raw!=='object')throw Error('Invalid review');const r=raw as ExternalReview;const w=parseExternalWorker(r.worker),period=workerPayrollPeriod(start);
 if(period.start!==start||r.start!==start||r.end!==period.end||!date(r.as_of)||w.id!==worker.id||w.name!==worker.name||w.position!==worker.position||w.active!==worker.active||typeof r.possible_supervisor!=='boolean'||typeof r.possible_worker_duplicate!=='boolean'||![r.overlapping_vouchers,r.period_advances,r.older_open_advances,r.existing_assertions].every(count))throw Error('Worker or period changed; reload');return r;
}
export function parseExternalAttempt(raw:unknown,actor:string):ExternalAttempt{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Invalid saved request');const x=raw as ExternalAttempt,w=parseExternalWorker(x.worker);
 if(!uuid(x.request)||!uuid(x.actor)||x.actor!==actor||!date(x.start)||workerPayrollPeriod(x.start).start!==x.start||!date(x.paid_on)||x.paid_on<x.start||typeof x.note!=='string'||x.note!==x.note.trim()||x.note.length<1||x.note.length>500)throw Error('Invalid saved request');
 if(cents(x.gross)-cents(x.bale)-cents(x.other)!==cents(x.net))throw Error('Amounts do not reconcile');
 return {request:x.request,actor:x.actor,worker:w,start:x.start,paid_on:x.paid_on,gross:x.gross,bale:x.bale,other:x.other,net:x.net,note:x.note};
}
export function externalArguments(a:ExternalAttempt){return {p_request:a.request,p_worker:a.worker.id,p_start:a.start,p_paid_on:a.paid_on,p_gross:a.gross,p_bale:a.bale,p_other:a.other,p_net:a.net,p_note:a.note,p_expected_worker:a.worker,p_ack:true};}
export function externalRowMatchesAttempt(row:ExternalRow,a:ExternalAttempt):boolean{
 const w=row.worker_snapshot;return row.request_id===a.request&&row.worker_id===a.worker.id&&row.recorded_by===a.actor&&row.period_start===a.start&&row.paid_on===a.paid_on&&w.id===a.worker.id&&w.name===a.worker.name&&w.position===a.worker.position&&w.active===a.worker.active&&row.evidence_note===a.note&&cents(row.gross)===cents(a.gross)&&cents(row.bale)===cents(a.bale)&&cents(row.other_deductions)===cents(a.other)&&cents(row.net)===cents(a.net);
}
export function parseExternalList(raw:unknown,workerId:string):{total:number;items:ExternalRow[]}{
 if(!raw||typeof raw!=='object')throw Error('Invalid history');const v=raw as {total:number;offset:number;items:ExternalRow[]};
 if(!count(v.total)||v.offset!==0||!Array.isArray(v.items)||v.items.length!==Math.min(v.total,100))throw Error('Incomplete history');const ids=new Set<string>();
 for(const r of v.items){if(!r||!uuid(r.request_id)||ids.has(r.request_id)||r.worker_id!==workerId||!date(r.period_start)||workerPayrollPeriod(r.period_start).start!==r.period_start||r.period_end!==workerPayrollPeriod(r.period_start).end||!date(r.paid_on)||r.paid_on<r.period_start||!uuid(r.recorded_by)||typeof r.recorded_at!=='string'||!Number.isFinite(Date.parse(r.recorded_at))||typeof r.evidence_note!=='string'||!r.evidence_note.trim()||r.evidence_note.length>500||parseExternalWorker(r.worker_snapshot).id!==workerId||cents(r.gross)-cents(r.bale)-cents(r.other_deductions)!==cents(r.net))throw Error('Invalid history item');ids.add(r.request_id);}
 return {total:v.total,items:v.items};
}
