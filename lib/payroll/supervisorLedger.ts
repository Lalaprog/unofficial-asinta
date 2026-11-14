import {parseSupervisorPreview,parseDailyRate,type SupervisorPreviewInput} from './supervisorPreview';
import {supervisorPayrollPeriod} from './periods';
export type PreparedSupervisor={person:{id:string;name:string;role:'supervisor'};linked_worker:{id:string;name:string;position:string;active:boolean};input:SupervisorPreviewInput;historical_worker_conflicts:number};
export type SupervisorLedgerRow={id:string;supervisor_id:string;supervisor_name:string;period_start:string;period_end:string;daily_rate:string;half_day_units:number;gross:string;status:'draft'|'approved'|'paid';unmarked_dates:string[];source_fingerprint:string;paid_on:string|null;created_by:string;created_at:string;approved_by:string|null;approved_at:string|null;paid_by:string|null;recorded_paid_at:string|null;source_changed:boolean;as_of:string;revision?:string};
type Scope={actor:string;request:string;supervisor:string;start:string};
export type SupervisorLedgerAttempt=({kind:'create';rate:string;prepared:PreparedSupervisor}&Scope)|({kind:'approved'|'recorded_paid';payroll:string;paid_on:string|null}&Scope)|({version:2;kind:'refresh'|'return_to_draft'|'approved'|'recorded_paid';payroll:string;revision:string;rate:string|null;prepared:PreparedSupervisor|null;reason:string|null;paid_on:string|null}&Scope);
export const validSupervisorRevision=(v:unknown):v is string=>typeof v==='string'&&/^(0|[1-9][0-9]{0,18})$/.test(v)&&BigInt(v)<9223372036854775807n;
export type CompanyEvidence={from:string;to:string;total:string;count:number;items:{id:string;supervisor_id:string;supervisor_name:string;period_start:string;period_end:string;paid_on:string;gross:string}[]};
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const text=(v:unknown):v is string=>typeof v==='string'&&v.trim().length>0;
const date=(v:unknown):v is string=>{if(typeof v!=='string'||v<'1900-01-01'||v>'9998-12-31'||!/^\d{4}-\d{2}-\d{2}$/.test(v))return false;const d=new Date(`${v}T00:00:00Z`);return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===v;};
const stamp=(v:unknown):v is string=>typeof v==='string'&&Number.isFinite(Date.parse(v));
const integer=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
const cents=(v:unknown,maxDigits=8)=>{if(typeof v!=='string'||!new RegExp(`^(?:0|[1-9]\\d{0,${maxDigits-1}})(?:\\.\\d{1,2})?$`).test(v))throw Error('Invalid money');const [a,b='']=v.split('.');return BigInt(a)*100n+BigInt(b.padEnd(2,'0'));};
export function parseSupervisorPrepared(raw:unknown,id:string,start:string):PreparedSupervisor{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Invalid Supervisor preparation');const v=raw as PreparedSupervisor;
 if(!v.person||v.person.id!==id||!uuid(id)||!text(v.person.name)||v.person.role!=='supervisor'||!v.linked_worker||v.linked_worker.id!==id||!text(v.linked_worker.name)||typeof v.linked_worker.position!=='string'||typeof v.linked_worker.active!=='boolean')throw Error('Invalid Supervisor identity');
 const input=parseSupervisorPreview(v.input,id,start);if(!integer(v.historical_worker_conflicts)||input.days.some(d=>!uuid(d.id))||input.leave.some(l=>!uuid(l.id)))throw Error('Invalid source identity');return {person:v.person,linked_worker:v.linked_worker,input,historical_worker_conflicts:v.historical_worker_conflicts};
}
export function parseSupervisorLedgerRow(raw:unknown,id:string,start:string,revisionRequired=false):SupervisorLedgerRow|null{
 if(raw===null)return null;if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Invalid Supervisor ledger');const r=raw as SupervisorLedgerRow;const period=supervisorPayrollPeriod(start),rate=cents(r.daily_rate),gross=cents(r.gross);
 if(!uuid(r.id)||!uuid(id)||r.supervisor_id!==id||!text(r.supervisor_name)||period.start!==start||r.period_start!==start||r.period_end!==period.end||rate<=0n||!integer(r.half_day_units)||r.half_day_units>62||gross!==(rate*BigInt(r.half_day_units)+1n)/2n||!['draft','approved','paid'].includes(r.status)||!Array.isArray(r.unmarked_dates)||new Set(r.unmarked_dates).size!==r.unmarked_dates.length||r.unmarked_dates.some(d=>!date(d)||d<start||d>period.end)||typeof r.source_fingerprint!=='string'||!/^[0-9a-f]{64}$/.test(r.source_fingerprint)||!uuid(r.created_by)||!stamp(r.created_at)||typeof r.source_changed!=='boolean'||!date(r.as_of))throw Error('Invalid Supervisor ledger');
 if(revisionRequired&&!validSupervisorRevision(r.revision))throw Error('Invalid Supervisor revision');
 if(r.status==='draft'&&(r.approved_by!==null||r.approved_at!==null||r.paid_on!==null||r.paid_by!==null||r.recorded_paid_at!==null))throw Error('Invalid draft');
 if(r.status!=='draft'&&(!uuid(r.approved_by)||!stamp(r.approved_at)))throw Error('Invalid approval');
 if(r.status==='approved'&&(r.paid_on!==null||r.paid_by!==null||r.recorded_paid_at!==null))throw Error('Invalid payment');
 if(r.status==='paid'&&(!date(r.paid_on)||r.paid_on<start||r.paid_on>r.as_of||!uuid(r.paid_by)||!stamp(r.recorded_paid_at)))throw Error('Invalid payment');return r;
}
export function parseSupervisorLedgerAttempt(raw:unknown,actor:string):SupervisorLedgerAttempt{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Invalid saved request');const a=raw as SupervisorLedgerAttempt;
 if(!uuid(a.actor)||a.actor!==actor||!uuid(a.request)||!uuid(a.supervisor)||!date(a.start)||supervisorPayrollPeriod(a.start).start!==a.start)throw Error('Invalid saved scope');
 if(a.kind==='create'){
  const p=parseSupervisorPrepared(a.prepared,a.supervisor,a.start);if(parseDailyRate(a.rate)===null||cents(a.rate)<=0n||!p.linked_worker.active||p.person.name.trim().toLowerCase()!==p.linked_worker.name.trim().toLowerCase())throw Error('Invalid saved draft');return {kind:a.kind,actor:a.actor,request:a.request,supervisor:a.supervisor,start:a.start,rate:a.rate,prepared:p};
 }
 if('version' in a){
  if(a.version!==2||!uuid(a.payroll)||!validSupervisorRevision(a.revision)||!['refresh','return_to_draft','approved','recorded_paid'].includes(a.kind))throw Error('Invalid revision action');
  if(a.kind==='refresh'){
   if(typeof a.rate!=='string'||parseDailyRate(a.rate)===null||cents(a.rate)<=0n||typeof a.reason!=='string'||!a.reason.trim()||a.reason.trim().length>500||a.paid_on!==null)throw Error('Invalid refresh');
   const prepared=parseSupervisorPrepared(a.prepared,a.supervisor,a.start);return {...a,prepared};
  }
  if(a.rate!==null||a.prepared!==null)throw Error('Unexpected revision arguments');
  if(a.kind==='return_to_draft'){
   if(typeof a.reason!=='string'||!a.reason.trim()||a.reason.trim().length>500||a.paid_on!==null)throw Error('Invalid return');
  }else if(a.reason!==null||(a.kind==='approved'&&a.paid_on!==null)||(a.kind==='recorded_paid'&&(!date(a.paid_on)||a.paid_on<a.start)))throw Error('Invalid revision decision');
  return a;
 }
 if(!['approved','recorded_paid'].includes(a.kind)||!uuid(a.payroll)||(a.kind==='approved'&&a.paid_on!==null)||(a.kind==='recorded_paid'&&(!date(a.paid_on)||a.paid_on<a.start)))throw Error('Invalid saved decision');return {kind:a.kind,actor:a.actor,request:a.request,supervisor:a.supervisor,start:a.start,payroll:a.payroll,paid_on:a.paid_on};
}
export function supervisorLedgerArguments(a:SupervisorLedgerAttempt){
 if(a.kind==='create')return {p_id:a.request,p_supervisor:a.supervisor,p_start:a.start,p_rate:a.rate,p_expected:a.prepared};
 if('version' in a)return {p_request:a.request,p_id:a.payroll,p_revision:a.revision,p_action:a.kind,p_rate:a.rate,p_expected:a.prepared,p_reason:a.reason,p_paid_on:a.paid_on,p_ack:true};
 return {p_request:a.request,p_id:a.payroll,p_action:a.kind,p_paid_on:a.paid_on,p_ack:true};
}
export function parseCompanyEvidence(raw:unknown,from:string,to:string):CompanyEvidence{
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||!date(from)||!date(to)||to<from||(Date.parse(`${to}T00:00:00Z`)-Date.parse(`${from}T00:00:00Z`))/86400000>365)throw Error('Invalid evidence range');const r=raw as CompanyEvidence;
 if(r.from!==from||r.to!==to||!integer(r.count)||r.count>500||!Array.isArray(r.items)||r.items.length!==r.count)throw Error('Incomplete evidence');let sum=0n;const ids=new Set<string>();
 for(const x of r.items){if(!x||!uuid(x.id)||ids.has(x.id)||!uuid(x.supervisor_id)||!text(x.supervisor_name)||!date(x.period_start)||supervisorPayrollPeriod(x.period_start).start!==x.period_start||x.period_end!==supervisorPayrollPeriod(x.period_start).end||!date(x.paid_on)||x.paid_on<from||x.paid_on>to||x.paid_on<x.period_start)throw Error('Invalid paid evidence');ids.add(x.id);sum+=cents(x.gross);}
 if(cents(r.total,12)!==sum)throw Error('Evidence total mismatch');return r;
}

export type SupervisorRevisionEvent={request_id:string;actor_id:string;action:'refresh'|'return_to_draft'|'approved'|'recorded_paid';revision:string;occurred_at:string;reason:string|null;before_status:string;after_status:string;before_rate:string;after_rate:string;before_gross:string;after_gross:string;paid_on:string|null};
export function parseSupervisorRevisionHistory(raw:unknown,payroll:string,before:string|null):{items:SupervisorRevisionEvent[];has_more:boolean}{
 if(!uuid(payroll)||(before!==null&&!validSupervisorRevision(before))||!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Invalid history');
 const result=raw as {payroll_id:unknown;items:unknown;has_more:unknown};
 if(result.payroll_id!==payroll||!Array.isArray(result.items)||result.items.length>50||typeof result.has_more!=='boolean'||(result.has_more&&result.items.length!==50))throw Error('Incomplete history');
 const seen=new Set<string>();let last=before===null?null:BigInt(before);
 const items=result.items.map((x:unknown)=>{if(!x||typeof x!=='object'||Array.isArray(x))throw Error('Invalid event');const e=x as SupervisorRevisionEvent;
  if(!uuid(e.request_id)||seen.has(e.request_id)||!uuid(e.actor_id)||!['refresh','return_to_draft','approved','recorded_paid'].includes(e.action)||!validSupervisorRevision(e.revision)||!stamp(e.occurred_at)||!(e.reason===null||typeof e.reason==='string'&&e.reason.length<=500)||!['draft','approved','paid'].includes(e.before_status)||!['draft','approved','paid'].includes(e.after_status)||!(e.paid_on===null||date(e.paid_on)))throw Error('Invalid event');
  cents(e.before_rate);cents(e.after_rate);cents(e.before_gross);cents(e.after_gross);const revision=BigInt(e.revision);if(last!==null&&revision>=last)throw Error('History order changed');last=revision;seen.add(e.request_id);return e;
 });return {items,has_more:result.has_more};
}
