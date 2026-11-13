import {workerPayrollPeriod,supervisorPayrollPeriod} from './periods';
import {validDifference} from './paidAdjustments';
import type {SupervisorLedgerRow} from './supervisorLedger';
import type {ExternalRow,ExternalWorker} from './historicalExternalWorker';
type Common={id:string;person_id:string;name:string;start:string;end:string;paid_on:string;gross:string;net:string};
export type PeriodSnapshot=(Common&{kind:'supervisor';status:'paid';details:{daily_rate:string;half_day_units:number;created_by:string;created_at:string;approved_by:string;approved_at:string;paid_by:string;recorded_paid_at:string}})|(Common&{kind:'external_worker';status:'paid_assertion';details:{bale:string;other_deductions:string;worker_snapshot:ExternalWorker;evidence_note:string;recorded_by:string;recorded_at:string}});
export type PeriodCase={id:string;source_kind:PeriodSnapshot['kind'];source_id:string;original_snapshot:PeriodSnapshot;difference:string;reason:string;status:'pending'|'settled_external'|'no_transfer';created_by:string;created_at:string;resolved_by:string|null;resolved_at:string|null;settled_on:string|null;resolution_note:string|null};
export type PeriodAttempt={kind:'open';actor:string;id:string;snapshot:PeriodSnapshot;difference:string;reason:string}|{kind:'resolve';actor:string;id:string;snapshot:PeriodSnapshot;resolution:'settled_external'|'no_transfer';settled_on:string|null;note:string};
const uuid=(x:unknown):x is string=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);
const date=(v:unknown):v is string=>{if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v)||v<'1900-01-01'||v>'9998-12-31')return false;const d=new Date(`${v}T00:00:00Z`);return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===v;};
const money=(x:unknown):bigint=>{if(typeof x!=='string'||!/^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/.test(x))throw Error('Invalid money');const [a,b='']=x.split('.');return BigInt(a)*100n+BigInt(b.padEnd(2,'0'));};
const stamp=(x:unknown):x is string=>typeof x==='string'&&Number.isFinite(Date.parse(x));
const text=(x:unknown):x is string=>typeof x==='string'&&x.trim().length>0&&x===x.trim()&&x.length<=500;
const canonical=(v:unknown):string=>{if(Array.isArray(v))return `[${v.map(canonical).join(',')}]`;if(v&&typeof v==='object')return `{${Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>`${JSON.stringify(k)}:${canonical(x)}`).join(',')}}`;return JSON.stringify(v);};
export const samePeriodSnapshot=(a:PeriodSnapshot,b:PeriodSnapshot)=>canonical(a)===canonical(b);
export function parsePeriodSnapshot(raw:unknown):PeriodSnapshot{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Invalid original period');const s=raw as PeriodSnapshot;
 if(Object.keys(raw).sort().join(',')!=='details,end,gross,id,kind,name,net,paid_on,person_id,start,status'||!uuid(s.id)||!uuid(s.person_id)||typeof s.name!=='string'||!s.name.trim()||!date(s.start)||!date(s.end)||!date(s.paid_on)||s.paid_on<s.start)throw Error('Invalid original period');
 const gross=money(s.gross),net=money(s.net);
 if(s.kind==='supervisor'){
  const p=supervisorPayrollPeriod(s.start),d=s.details;if(s.status!=='paid'||p.start!==s.start||p.end!==s.end||!d||Object.keys(d).sort().join(',')!=='approved_at,approved_by,created_at,created_by,daily_rate,half_day_units,paid_by,recorded_paid_at'||!uuid(d.created_by)||!stamp(d.created_at)||!uuid(d.approved_by)||!stamp(d.approved_at)||!uuid(d.paid_by)||!stamp(d.recorded_paid_at)||!Number.isSafeInteger(d.half_day_units)||d.half_day_units<0||d.half_day_units>62||money(d.daily_rate)<=0n||gross!==(money(d.daily_rate)*BigInt(d.half_day_units)+1n)/2n||net!==gross)throw Error('Invalid Supervisor original');
 }else if(s.kind==='external_worker'){
  const p=workerPayrollPeriod(s.start),d=s.details,w=d?.worker_snapshot;if(s.status!=='paid_assertion'||p.start!==s.start||p.end!==s.end||!d||Object.keys(d).sort().join(',')!=='bale,evidence_note,other_deductions,recorded_at,recorded_by,worker_snapshot'||!text(d.evidence_note)||!uuid(d.recorded_by)||!stamp(d.recorded_at)||!w||Object.keys(w).sort().join(',')!=='active,id,name,position'||w.id!==s.person_id||w.name!==s.name||typeof w.position!=='string'||typeof w.active!=='boolean'||gross-money(d.bale)-money(d.other_deductions)!==net)throw Error('Invalid external worker original');
 }else throw Error('Invalid period kind');return s;
}
export function snapshotFromSupervisor(r:SupervisorLedgerRow):PeriodSnapshot{
 return parsePeriodSnapshot({kind:'supervisor',id:r.id,person_id:r.supervisor_id,name:r.supervisor_name,start:r.period_start,end:r.period_end,paid_on:r.paid_on,gross:r.gross,net:r.gross,status:r.status,details:{daily_rate:r.daily_rate,half_day_units:r.half_day_units,created_by:r.created_by,created_at:r.created_at,approved_by:r.approved_by,approved_at:r.approved_at,paid_by:r.paid_by,recorded_paid_at:r.recorded_paid_at}});
}
export function snapshotFromExternal(r:ExternalRow):PeriodSnapshot{
 return parsePeriodSnapshot({kind:'external_worker',id:r.request_id,person_id:r.worker_id,name:r.worker_snapshot.name,start:r.period_start,end:r.period_end,paid_on:r.paid_on,gross:r.gross,net:r.net,status:'paid_assertion',details:{bale:r.bale,other_deductions:r.other_deductions,worker_snapshot:r.worker_snapshot,evidence_note:r.evidence_note,recorded_by:r.recorded_by,recorded_at:r.recorded_at}});
}
export function parsePeriodCases(raw:unknown,expected:PeriodSnapshot):PeriodCase[]{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Invalid case history');const list=raw as {snapshot:unknown;total:number;items:PeriodCase[]};const snapshot=parsePeriodSnapshot(list.snapshot);
 if(!samePeriodSnapshot(snapshot,expected)||!Number.isSafeInteger(list.total)||list.total<0||list.total>100||!Array.isArray(list.items)||list.items.length!==list.total)throw Error('Incomplete or changed original period');const seen=new Set<string>();
 for(const c of list.items){if(!c||!uuid(c.id)||seen.has(c.id)||c.source_kind!==expected.kind||c.source_id!==expected.id||!validDifference(c.difference)||!text(c.reason)||!uuid(c.created_by)||!stamp(c.created_at)||!['pending','settled_external','no_transfer'].includes(c.status))throw Error('Invalid case history');const old=parsePeriodSnapshot(c.original_snapshot);if(old.kind!==expected.kind||old.id!==expected.id)throw Error('Invalid case source');
  if(c.status==='pending'&&(c.resolved_by!==null||c.resolved_at!==null||c.settled_on!==null||c.resolution_note!==null))throw Error('Invalid pending case');
  if(c.status!=='pending'&&(!uuid(c.resolved_by)||!stamp(c.resolved_at)||!text(c.resolution_note)||(c.status==='no_transfer'&&c.settled_on!==null)||(c.status==='settled_external'&&(!date(c.settled_on)||c.settled_on<old.paid_on))))throw Error('Invalid final case');seen.add(c.id);
 }
 if(list.items.filter(x=>x.status==='pending').length>1)throw Error('Multiple pending cases');return list.items;
}
export function parsePeriodAttempt(raw:unknown,actor:string,expected:PeriodSnapshot):PeriodAttempt{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Invalid saved case action');const a=raw as PeriodAttempt;if(!uuid(a.actor)||a.actor!==actor||!uuid(a.id)||!samePeriodSnapshot(parsePeriodSnapshot(a.snapshot),expected))throw Error('Invalid saved scope');
 if(a.kind==='open'){if(!validDifference(a.difference)||!text(a.reason))throw Error('Invalid case details');return {kind:a.kind,actor:a.actor,id:a.id,snapshot:a.snapshot,difference:a.difference,reason:a.reason};}
 if(a.kind!=='resolve'||!['settled_external','no_transfer'].includes(a.resolution)||!text(a.note)||(a.resolution==='no_transfer'&&a.settled_on!==null)||(a.resolution==='settled_external'&&(!date(a.settled_on)||a.settled_on<expected.paid_on)))throw Error('Invalid resolution');return {kind:a.kind,actor:a.actor,id:a.id,snapshot:a.snapshot,resolution:a.resolution,settled_on:a.settled_on,note:a.note};
}
export function periodCaseArguments(a:PeriodAttempt){return a.kind==='open'?{p_id:a.id,p_kind:a.snapshot.kind,p_source:a.snapshot.id,p_expected:a.snapshot,p_difference:a.difference,p_reason:a.reason}:{p_id:a.id,p_resolution:a.resolution,p_settled_on:a.settled_on,p_note:a.note,p_ack:true};}
