import { workerPayrollPeriod } from './periods';

type Worker={id:string;name:string;position:string;active:boolean;pay_rate:string;pay_rate_type:'daily'|'hourly';linked_supervisor:boolean;possible_supervisor:boolean};
type TimeDetail={regular_hours:string;overtime_hours:string;stale:boolean};
type Entry={id:string;worker_id:string;project_id:string;date:string;status:'present'|'half_day'|'absent'|'leave';hours_worked:string;time_detail?:TimeDetail|null};
type Voucher={id:string;worker_id:string;status:'draft'|'reviewed'|'approved'|'paid'};
export type WeeklyInput={start:string;end:string;workers:Worker[];attendance:Entry[];vouchers:Voucher[]};
const decimal=/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/;
const money=(s:string)=>{if(!decimal.test(s))throw new Error('Invalid numeric value in weekly preview');const [whole,part='']=s.split('.');return BigInt(whole)*100n+BigInt(part.padEnd(2,'0'));};
const roundDivide=(n:bigint,d:bigint)=>(n+d/2n)/d;
export function centsText(cents:bigint):string {return `${cents/100n}.${String(cents%100n).padStart(2,'0')}`;}

export function parseWeeklyInput(raw:unknown,start:string):WeeklyInput {
 const week=workerPayrollPeriod(start);if(week.start!==start)throw new Error('Expected a Sunday');
 if(!raw || typeof raw!=='object') throw new Error('Invalid weekly preview');
 const v=raw as WeeklyInput;
 if(v.start!==start || v.end!==week.end || !Array.isArray(v.workers) || !Array.isArray(v.attendance) || !Array.isArray(v.vouchers) || v.workers.length>2000 || v.attendance.length>10000 || v.vouchers.length>10000)throw new Error('Invalid weekly preview');
 const ids=new Set<string>();
 for(const w of v.workers){
  if(!w || typeof w.id!=='string'||!w.id||ids.has(w.id)||typeof w.name!=='string'||typeof w.position!=='string'||typeof w.active!=='boolean'||typeof w.linked_supervisor!=='boolean'||typeof w.possible_supervisor!=='boolean'||typeof w.pay_rate!=='string'||!['daily','hourly'].includes(w.pay_rate_type))throw new Error('Invalid worker in weekly preview');
  money(w.pay_rate);ids.add(w.id);
 }
 const entryIds=new Set<string>();
 for(const a of v.attendance){
  if(!a||typeof a.id!=='string'||!a.id||entryIds.has(a.id)||!ids.has(a.worker_id)||typeof a.project_id!=='string'||!a.project_id||typeof a.date!=='string'||!weekDates(start).includes(a.date)||!['present','half_day','absent','leave'].includes(a.status)||typeof a.hours_worked!=='string')throw new Error('Invalid attendance in weekly preview');
  money(a.hours_worked);
  if(a.time_detail!==null && a.time_detail!==undefined){const d=a.time_detail;if(typeof d!=='object'||typeof d.regular_hours!=='string'||typeof d.overtime_hours!=='string'||typeof d.stale!=='boolean'||money(d.regular_hours)>800n||money(d.regular_hours)+money(d.overtime_hours)>2400n)throw new Error('Invalid detailed hours in weekly preview');}
  entryIds.add(a.id);
 }
 const voucherIds=new Set<string>();
 for(const p of v.vouchers){if(!p||typeof p.id!=='string'||!p.id||voucherIds.has(p.id)||!ids.has(p.worker_id)||!['draft','reviewed','approved','paid'].includes(p.status))throw new Error('Invalid voucher in weekly preview');voucherIds.add(p.id);}
 return v;
}
export function weekDates(start:string):string[]{const w=workerPayrollPeriod(start);if(w.start!==start)throw new Error('Expected a Sunday');return Array.from({length:7},(_,i)=>{const d=new Date(`${start}T00:00:00Z`);d.setUTCDate(d.getUTCDate()+i);return d.toISOString().slice(0,10)});}
export type WeeklyRow={worker:Worker;days:{date:string;entries:Entry[];unmarked:'past'|'today'|'upcoming'|null}[];vouchers:Voucher[];estimate:string|null;regularHours:string;otHours:string;review:boolean;pastUnmarked:boolean};
export function buildWeeklyPreview(input:WeeklyInput,today:string):{rows:WeeklyRow[];linkedSupervisors:number} {
 const dates=weekDates(input.start);workerPayrollPeriod(today);
 const grouped=new Map<string,Entry[]>(),vouchers=new Map<string,Voucher[]>();
 for(const a of input.attendance)grouped.set(a.worker_id,[...(grouped.get(a.worker_id)||[]),a]);
 for(const p of input.vouchers)vouchers.set(p.worker_id,[...(vouchers.get(p.worker_id)||[]),p]);
 const rows=input.workers.filter(w=>!w.linked_supervisor).map(worker=>{
  const att=grouped.get(worker.id)||[],pays=vouchers.get(worker.id)||[];
  const days=dates.map(date=>{const entries=att.filter(a=>a.date===date);return {date,entries,unmarked:entries.length?null:date<today?'past' as const:date===today?'today' as const:'upcoming' as const};});
  // Never double count multi-site dates or silently treat unusual legacy hours as regular.
  const review=worker.possible_supervisor || pays.length>1 || days.some(d=>d.entries.length>1 || d.entries.some(a=> a.time_detail?.stale || ((a.status==='present'||a.status==='half_day') ? (a.time_detail ? money(a.time_detail.regular_hours)+money(a.time_detail.overtime_hours)===0n : (money(a.hours_worked)>800n || money(a.hours_worked)===0n)) : (money(a.hours_worked)!==0n || Boolean(a.time_detail)))));
  const worked=att.filter(a=>a.status==='present'||a.status==='half_day');
  const regular=worked.reduce((sum,a)=>sum+money(a.time_detail?.regular_hours ?? a.hours_worked),0n), overtime=worked.reduce((sum,a)=>sum+money(a.time_detail?.overtime_hours ?? '0'),0n),hours=regular+overtime,rate=money(worker.pay_rate);
  const estimate=!review && !pays.some(p=>p.status==='paid'||p.status==='approved') && worked.length?centsText(roundDivide(rate*hours,worker.pay_rate_type==='daily'?800n:100n)):null;
  return {worker,days,vouchers:pays,estimate,regularHours:centsText(regular),otHours:centsText(overtime),review,pastUnmarked:days.some(d=>d.unmarked==='past')};
 });
 return {rows,linkedSupervisors:input.workers.filter(w=>w.linked_supervisor).length};
}
