import { workerPayrollPeriod } from './periods';
import { estimateProjectGross } from './projectCostEstimate';

type Worker={id:string;name:string;position:string;active:boolean;pay_rate:string;pay_rate_type:'daily'|'hourly';linked_supervisor:boolean;possible_supervisor:boolean};
type TimeDetail={regular_hours:string;overtime_hours:string;stale:boolean};
type Entry={id:string;worker_id:string;project_id:string;date:string;status:'present'|'half_day'|'absent'|'leave';hours_worked:string;time_detail:TimeDetail|null};
type Voucher={id:string;worker_id:string;status:'draft'|'reviewed'|'approved'|'paid';period_start:string;period_end:string};
type Allowance={id:string;worker_id:string;project_id:string;description:string;amount:string;status:'pending'|'approved'|'rejected';date:string;stale:boolean};
type Advance={id:string;worker_id:string;project_id:string;date:string;amount:string;deducted:string;status:'active'|'partially_deducted'|'fully_deducted'|'cancelled';linked_release:boolean};
type OlderAdvance={id:string;worker_id:string;amount:string;deducted:string;status:'active'|'partially_deducted'};
export type WeeklyInput={start:string;end:string;workers:Worker[];attendance:Entry[];vouchers:Voucher[];allowances:Allowance[];advances:Advance[];older_advances:OlderAdvance[]};
const decimal=/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/;
const cents=(s:string)=>{if(!decimal.test(s))throw new Error('Invalid numeric value in weekly preview');const [whole,part='']=s.split('.');return BigInt(whole)*100n+BigInt(part.padEnd(2,'0'));};
const roundDivide=(n:bigint,d:bigint)=>(n+d/2n)/d;
export function centsText(value:bigint):string {return `${value/100n}.${String(value%100n).padStart(2,'0')}`;}
export function weekDates(start:string):string[]{const w=workerPayrollPeriod(start);if(w.start!==start)throw new Error('Expected a Sunday');return Array.from({length:7},(_,i)=>{const d=new Date(`${start}T00:00:00Z`);d.setUTCDate(d.getUTCDate()+i);return d.toISOString().slice(0,10)});}
function validDate(s:unknown):s is string {try {return typeof s==='string' && !!workerPayrollPeriod(s);} catch {return false;}}

/** Fail closed: missing arrays can indicate an old or partially deployed RPC. */
export function parseWeeklyInput(raw:unknown,start:string):WeeklyInput {
 const week=workerPayrollPeriod(start),dates=weekDates(start);
 if(!raw || typeof raw!=='object') throw new Error('Invalid weekly preview');
 const v=raw as WeeklyInput;
 if(v.start!==start || v.end!==week.end || !Array.isArray(v.workers) || !Array.isArray(v.attendance) || !Array.isArray(v.vouchers) || !Array.isArray(v.allowances) || !Array.isArray(v.advances) || !Array.isArray(v.older_advances) || v.workers.length>2000 || [v.attendance,v.vouchers,v.allowances,v.advances,v.older_advances].some(x=>x.length>10000))throw new Error('Invalid or outdated weekly preview response');
 const ids=new Set<string>();
 for(const w of v.workers){
  if(!w || typeof w.id!=='string'||!w.id||ids.has(w.id)||typeof w.name!=='string'||typeof w.position!=='string'||typeof w.active!=='boolean'||typeof w.linked_supervisor!=='boolean'||typeof w.possible_supervisor!=='boolean'||typeof w.pay_rate!=='string'||!['daily','hourly'].includes(w.pay_rate_type))throw new Error('Invalid worker in weekly preview');
  cents(w.pay_rate);ids.add(w.id);
 }
 const unique=(id:string,seen:Set<string>,worker:string)=>{if(typeof id!=='string'||!id||seen.has(id)||!ids.has(worker))throw new Error('Invalid or duplicated weekly preview record');seen.add(id);};
 const entryIds=new Set<string>();
 for(const a of v.attendance){
  if(!a||typeof a.project_id!=='string'||!a.project_id||!dates.includes(a.date)||!['present','half_day','absent','leave'].includes(a.status)||typeof a.hours_worked!=='string'||a.time_detail===undefined)throw new Error('Invalid attendance in weekly preview');
  unique(a.id,entryIds,a.worker_id);cents(a.hours_worked);
  if(a.time_detail!==null){const d=a.time_detail;if(typeof d!=='object'||typeof d.regular_hours!=='string'||typeof d.overtime_hours!=='string'||typeof d.stale!=='boolean'||cents(d.regular_hours)>800n||cents(d.regular_hours)+cents(d.overtime_hours)>2400n)throw new Error('Invalid detailed hours in weekly preview');}
 }
 const voucherIds=new Set<string>();
 for(const p of v.vouchers){if(!p||!['draft','reviewed','approved','paid'].includes(p.status)||!validDate(p.period_start)||!validDate(p.period_end)||p.period_start>p.period_end||p.period_start>week.end||p.period_end<start)throw new Error('Invalid voucher in weekly preview');unique(p.id,voucherIds,p.worker_id);}
 const allowanceIds=new Set<string>();
 for(const a of v.allowances){if(!a||typeof a.project_id!=='string'||!a.project_id||typeof a.description!=='string'||!a.description.trim()||!dates.includes(a.date)||!['pending','approved','rejected'].includes(a.status)||typeof a.amount!=='string'||cents(a.amount)<=0n||typeof a.stale!=='boolean')throw new Error('Invalid allowance in weekly preview');unique(a.id,allowanceIds,a.worker_id);}
 const advanceIds=new Set<string>();
 for(const a of v.advances){if(!a||typeof a.project_id!=='string'||!a.project_id||!dates.includes(a.date)||!['active','partially_deducted','fully_deducted','cancelled'].includes(a.status)||typeof a.amount!=='string'||typeof a.deducted!=='string'||typeof a.linked_release!=='boolean')throw new Error('Invalid Bale in weekly preview');cents(a.amount);cents(a.deducted);unique(a.id,advanceIds,a.worker_id);}
 for(const a of v.older_advances){if(!a||!['active','partially_deducted'].includes(a.status)||typeof a.amount!=='string'||typeof a.deducted!=='string')throw new Error('Invalid older Bale in weekly preview');cents(a.amount);cents(a.deducted);unique(a.id,advanceIds,a.worker_id);}
 return v;
}
export type WeeklyProjectEstimate={projectId:string;wage:string;allowance:string;gross:string};
export type WeeklyRow={projectEstimates:WeeklyProjectEstimate[]|null;worker:Worker;days:{date:string;entries:Entry[];unmarked:'past'|'today'|'upcoming'|null}[];vouchers:Voucher[];wage:string|null;gross:string|null;allowance:string;pendingAllowances:number;bale:string;olderBalance:string;net:string|null;regularHours:string;otHours:string;review:boolean;reviewReasons:string[];pastUnmarked:boolean;excess:boolean};
export function buildWeeklyPreview(input:WeeklyInput,today:string):{rows:WeeklyRow[];linkedSupervisors:number} {
 const dates=weekDates(input.start);workerPayrollPeriod(today);
 const group=<T extends {worker_id:string}>(items:T[])=>{const m=new Map<string,T[]>();for(const x of items){const list=m.get(x.worker_id);if(list)list.push(x);else m.set(x.worker_id,[x]);}return m;};
 const attendance=group(input.attendance),vouchers=group(input.vouchers),allowances=group(input.allowances),advances=group(input.advances),older=group(input.older_advances);
 const rows=input.workers.filter(w=>!w.linked_supervisor).map(worker=>{
  const att=attendance.get(worker.id)||[],pays=vouchers.get(worker.id)||[],allow=allowances.get(worker.id)||[],bales=advances.get(worker.id)||[],previous=older.get(worker.id)||[];
  const days=dates.map(date=>{const entries=att.filter(a=>a.date===date);return {date,entries,unmarked:entries.length?null:date<today?'past' as const:date===today?'today' as const:'upcoming' as const};});
  const reasons:string[]=[];
  if(worker.possible_supervisor)reasons.push('Possible Supervisor identity');
  if(att.some(a=>a.date>today)||allow.some(a=>a.status!=='rejected'&&a.date>today)||bales.some(a=>a.status!=='cancelled'&&a.date>today))reasons.push('Future-dated attendance, allowance or Bale requires review');
  if(pays.length>1 || pays.some(p=>p.period_start!==input.start||p.period_end!==input.end))reasons.push('Multiple or overlapping vouchers');
  if(days.some(d=>d.entries.length>1 || d.entries.some(a=>a.time_detail?.stale || ((a.status==='present'||a.status==='half_day') ? (a.time_detail ? cents(a.time_detail.regular_hours)+cents(a.time_detail.overtime_hours)===0n : (cents(a.hours_worked)>800n || cents(a.hours_worked)===0n)) : (cents(a.hours_worked)!==0n || Boolean(a.time_detail))))))reasons.push('Attendance conflicts, unusual hours or stale time details');
  if(allow.some(a=>a.status!=='rejected'&&a.stale))reasons.push('Allowance attendance changed');
  // A non-stale flag alone does not prove that the preview also contains the
  // corresponding worked day/site. Never use such an allowance in a net.
  if(allow.some(a=>a.status==='approved'&&!a.stale&&!att.some(entry=>entry.project_id===a.project_id&&entry.date===a.date&&(entry.status==='present'||entry.status==='half_day'))))reasons.push('Approved allowance has no matching worked attendance');
  const repeated=(keys:string[])=>new Set(keys).size!==keys.length;
  if(repeated(allow.filter(a=>a.status!=='rejected').map(a=>JSON.stringify([a.date,a.project_id,cents(a.amount).toString(),a.description.trim().toLowerCase()]))))reasons.push('Possible duplicate allowance entries');
  const pendingAllowances=allow.filter(a=>a.status==='pending').length;
  if(pendingAllowances)reasons.push('Allowance awaiting Founder decision');
  const includedAllow=allow.filter(a=>a.status==='approved'&&!a.stale).reduce((sum,a)=>sum+cents(a.amount),0n);
  const bale=bales.filter(a=>a.status!=='cancelled').reduce((sum,a)=>sum+cents(a.amount),0n);
  if(repeated(bales.filter(a=>a.status!=='cancelled').map(a=>JSON.stringify([a.date,a.project_id,cents(a.amount).toString()]))))reasons.push('Possible duplicate Bale records');
  if(bales.some(a=>a.status==='cancelled'?cents(a.deducted)>0n:(!a.linked_release || a.status!=='active' || cents(a.deducted)!==0n || new Date(`${a.date}T00:00:00Z`).getUTCDay()!==3)))reasons.push('Bale release, timing or previous deduction needs reconciliation');
  const olderBalance=previous.reduce((sum,a)=>sum+(cents(a.amount)>cents(a.deducted)?cents(a.amount)-cents(a.deducted):0n),0n);
  if(previous.length)reasons.push('Older outstanding Bale requires separate review; not carried forward');
  const worked=att.filter(a=>a.status==='present'||a.status==='half_day');
  const regular=worked.reduce((sum,a)=>sum+cents(a.time_detail?.regular_hours ?? a.hours_worked),0n),overtime=worked.reduce((sum,a)=>sum+cents(a.time_detail?.overtime_hours ?? '0'),0n);
  const finalized=pays.some(p=>p.status==='paid'||p.status==='approved');
  // Recorded absence/leave can yield zero earnings; a completely unmarked
  // week is still unknown, not proof of zero attendance or a zero payout.
  const wage=!reasons.length&&!finalized&&att.length?roundDivide(cents(worker.pay_rate)*(regular+overtime),worker.pay_rate_type==='daily'?800n:100n):null;
  const excess=wage!==null && bale>wage+includedAllow;
  if(excess)reasons.push('Recorded Bale exceeds estimated earnings');
  const net=wage!==null&&!excess?centsText(wage+includedAllow-bale):null;
  const projectEstimates = net===null || wage===null ? null : estimateProjectGross({
   wageCents:wage,
   worked:worked.map(a=>({projectId:a.project_id,date:a.date,hundredthsOfHour:cents(a.time_detail?.regular_hours ?? a.hours_worked)+cents(a.time_detail?.overtime_hours ?? '0')})),
   allowances:allow.filter(a=>a.status==='approved'&&!a.stale).map(a=>({projectId:a.project_id,date:a.date,amountCents:cents(a.amount)})),
  })?.map(p=>({projectId:p.projectId,wage:centsText(p.wageCents),allowance:centsText(p.allowanceCents),gross:centsText(p.grossCents)})) ?? null;
  return {projectEstimates,worker,days,vouchers:pays,wage:wage===null?null:centsText(wage),gross:wage===null?null:centsText(wage+includedAllow),allowance:centsText(includedAllow),pendingAllowances,bale:centsText(bale),olderBalance:centsText(olderBalance),net,regularHours:centsText(regular),otHours:centsText(overtime),review:reasons.length>0,reviewReasons:reasons,pastUnmarked:days.some(d=>d.unmarked==='past'),excess};
 });
 return {rows,linkedSupervisors:input.workers.filter(w=>w.linked_supervisor).length};
}

/** Partial subtotal only; excluded rows are never implicitly treated as zero. */
export function summarizeWeekly(rows:WeeklyRow[]):{count:number;excluded:number;gross:string;net:string}{
 const included=rows.filter(row=>row.net!==null&&row.gross!==null);
 return {count:included.length,excluded:rows.length-included.length,gross:centsText(included.reduce((sum,row)=>sum+cents(row.gross!),0n)),net:centsText(included.reduce((sum,row)=>sum+cents(row.net!),0n))};
}

/** Hours are hundredths; display equivalent eight-hour days rounded to 0.01. */
export function regularDayEquivalent(hours: string): string {
 return centsText(roundDivide(cents(hours), 8n));
}

/** Only rows with an illustrative net are counted; excluded rows are not zero. */
export function summarizeWeeklyColumns(rows: WeeklyRow[]): {
 count:number; excluded:number; regularHours:string; otHours:string; wage:string;
 allowance:string; bale:string; gross:string; net:string;
} {
 const included=rows.filter(row=>row.net!==null&&row.gross!==null&&row.wage!==null);
 const sum=(get:(row:WeeklyRow)=>string)=>centsText(included.reduce((total,row)=>total+cents(get(row)),0n));
 return {count:included.length,excluded:rows.length-included.length,
  regularHours:sum(row=>row.regularHours),otHours:sum(row=>row.otHours),wage:sum(row=>row.wage!),
  allowance:sum(row=>row.allowance),bale:sum(row=>row.bale),gross:sum(row=>row.gross!),net:sum(row=>row.net!)};
}
