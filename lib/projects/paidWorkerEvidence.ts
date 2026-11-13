import {workerPayrollPeriod} from '@/lib/payroll/periods';
export type PaidWorkerEvidence={payrollId:string;workerId:string;workerName:string;start:string;end:string;paymentDate:string;hours:string;wage:string;allowance:string;gross:string};
export type PaidWorkerPage={items:PaidWorkerEvidence[];hasMore:boolean};
const validDate=(s:unknown):s is string=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(s)&&Number.isFinite(Date.parse(`${s}T00:00:00Z`))&&new Date(`${s}T00:00:00Z`).toISOString().slice(0,10)===s;
const units=(s:unknown):bigint=>{if(typeof s!=='string'||!/^(?:0|[1-9]\d{0,9})\.\d{2}$/.test(s))throw new Error('Invalid paid allocation amount');const [a,b]=s.split('.');return BigInt(a)*100n+BigInt(b);};
/** Do not render incomplete, cross-project, out-of-order or inconsistent evidence. */
export function parsePaidWorkerPage(raw:unknown,project:string,cursor?:PaidWorkerEvidence):PaidWorkerPage{
 if(!raw||typeof raw!=='object')throw new Error('Invalid paid allocation page');const page=raw as {project_id?:unknown;items?:unknown;has_more?:unknown};
 if(page.project_id!==project||!Array.isArray(page.items)||page.items.length>25||typeof page.has_more!=='boolean'||(page.has_more&&page.items.length!==25))throw new Error('Invalid paid allocation page');
 const ids=new Set<string>();let previous=cursor;
 const items=page.items.map((raw:unknown):PaidWorkerEvidence=>{
  if(!raw||typeof raw!=='object')throw new Error('Invalid paid allocation');const r=raw as Record<string,unknown>;
  if(typeof r.payroll_id!=='string'||!r.payroll_id||ids.has(r.payroll_id)||typeof r.worker_id!=='string'||!r.worker_id||typeof r.worker_name!=='string'||!r.worker_name||!validDate(r.period_start)||!validDate(r.period_end)||!validDate(r.payment_date))throw new Error('Invalid paid allocation');
  const week=workerPayrollPeriod(r.period_start);if(week.start!==r.period_start||week.end!==r.period_end)throw new Error('Invalid weekly period');
  if(previous&&(r.period_start>previous.start||(r.period_start===previous.start&&r.payroll_id>=previous.payrollId)))throw new Error('Invalid allocation cursor');
  const hours=units(r.hours),wage=units(r.wage),allowance=units(r.allowance),gross=units(r.gross);if(hours===0n||wage+allowance!==gross)throw new Error('Inconsistent paid allocation');
  ids.add(r.payroll_id);const result={payrollId:r.payroll_id,workerId:r.worker_id,workerName:r.worker_name,start:r.period_start,end:r.period_end,paymentDate:r.payment_date,hours:r.hours as string,wage:r.wage as string,allowance:r.allowance as string,gross:r.gross as string};previous=result;return result;
 });return {items,hasMore:page.has_more};
}
