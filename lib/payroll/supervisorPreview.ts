import {supervisorPayrollPeriod} from './periods';

type Day={id:string;date:string;work_status:'present'|'half_day'|'absent';status:'pending'|'approved'};
type Leave={id:string;start:string;end:string;status:'pending'|'approved'};
export type SupervisorPreviewInput={supervisor_id:string;start:string;end:string;as_of:string;days:Day[];leave:Leave[];identity_needs_review:boolean;legacy_count:number;overlapping_vouchers:number};
export type SupervisorOption={id:string;name:string};
const validDate=(s:unknown):s is string=>{if(typeof s!=='string'||s<'1900-01-01'||s>'9998-12-31')return false;try{supervisorPayrollPeriod(s);return true;}catch{return false;}};
const integer=(x:unknown):x is number=>typeof x==='number'&&Number.isSafeInteger(x)&&x>=0;
const text=(x:unknown):x is string=>typeof x==='string'&&x.trim().length>0;
export function parseSupervisorCatalog(raw:unknown):SupervisorOption[]{
 if(!raw||typeof raw!=='object'||!('supervisors' in raw)||!Array.isArray(raw.supervisors)||raw.supervisors.length>2000)throw new Error('Invalid Supervisor catalog');
 const seen=new Set<string>();
 for(const item of raw.supervisors){if(!item||!text(item.id)||!text(item.name)||seen.has(item.id))throw new Error('Invalid Supervisor catalog');seen.add(item.id);}
 return raw.supervisors;
}
export function parseSupervisorPreview(raw:unknown,id:string,start:string):SupervisorPreviewInput {
 const period=supervisorPayrollPeriod(start);
 if(period.start!==start||!raw||typeof raw!=='object')throw new Error('Invalid Supervisor period');
 const v=raw as SupervisorPreviewInput;
 if(v.supervisor_id!==id||v.start!==start||v.end!==period.end||!validDate(v.as_of)||!Array.isArray(v.days)||v.days.length>100||!Array.isArray(v.leave)||v.leave.length>100||typeof v.identity_needs_review!=='boolean'||!integer(v.legacy_count)||!integer(v.overlapping_vouchers))throw new Error('Invalid or outdated Supervisor preview');
 const ids=new Set<string>(),dates=new Set<string>();
 for(const d of v.days){
  if(!d||!text(d.id)||ids.has(d.id)||!validDate(d.date)||d.date<start||d.date>period.end||dates.has(d.date)||!['present','half_day','absent'].includes(d.work_status)||!['pending','approved'].includes(d.status))throw new Error('Invalid Supervisor day records');
  ids.add(d.id);dates.add(d.date);
 }
 ids.clear();
 for(const l of v.leave){if(!l||!text(l.id)||ids.has(l.id)||!validDate(l.start)||!validDate(l.end)||l.start>l.end||l.start>period.end||l.end<start||!['pending','approved'].includes(l.status))throw new Error('Invalid Supervisor leave records');ids.add(l.id);}
 return v;
}
export function supervisorPeriodDates(start:string):string[]{
 const p=supervisorPayrollPeriod(start);if(p.start!==start||!validDate(start)||!validDate(p.end))throw new Error('Invalid Supervisor period');
 const d=new Date(`${start}T00:00:00Z`),end=new Date(`${p.end}T00:00:00Z`),result:string[]=[];
 while(d<=end){result.push(d.toISOString().slice(0,10));d.setUTCDate(d.getUTCDate()+1);}
 return result;
}
export function parseDailyRate(s:string):bigint|null {
 if(!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(s))return null;
 const [whole,part='']=s.split('.'),value=BigInt(whole)*100n+BigInt(part.padEnd(2,'0'));
 return value>0n?value:null;
}
const money=(v:bigint)=>`${v/100n}.${String(v%100n).padStart(2,'0')}`;
export type SupervisorPreviewDay={date:string;label:string;unmarked:boolean};
/** Illustrative gross from an explicitly entered daily rate, never net or a voucher. */
export function buildSupervisorPreview(v:SupervisorPreviewInput,rate:string,today:string){
 if(!validDate(today))throw new Error('Invalid current date');
 const daily=parseDailyRate(rate),reasons:string[]=[];let units=0n,known=0,unmarkedPast=0;
 if(daily===null)reasons.push('Enter a positive daily rate with at most two decimals');
 if(v.as_of!==today)reasons.push('Device and server Philippine dates differ; verify the clock and reload');
 const asOf=v.as_of;
 if(v.identity_needs_review)reasons.push('Supervisor identity requires review');
 if(v.legacy_count>0)reasons.push('Possible legacy site attendance overlaps this period');
 if(v.overlapping_vouchers>0)reasons.push('Possible overlapping payroll voucher requires review');
 const days:SupervisorPreviewDay[]=supervisorPeriodDates(v.start).map(date=>{
  const d=v.days.find(x=>x.date===date),leaves=v.leave.filter(x=>x.start<=date&&x.end>=date);
  const approved=leaves.filter(x=>x.status==='approved').length,pending=leaves.some(x=>x.status==='pending');
  if(approved>1||(approved&&d))reasons.push('Conflicting attendance or leave records');
  if(pending)reasons.push('Pending leave requires review');
  if(d?.status==='pending')reasons.push('Pending daily attendance requires review');
  // Legitimate approved leave may be scheduled in advance; future attendance
  // cannot be payable work, even if a privileged writer bypassed submission.
  if(d&&date>asOf)reasons.push('Future attendance requires investigation');
  if(approved){if(date<=asOf)known++;return {date,label:date>asOf?'Approved leave · upcoming, unpaid':'Approved leave · unpaid',unmarked:false};}
  if(d){if(d.status==='approved'&&date<=asOf){known++;units+=d.work_status==='present'?2n:d.work_status==='half_day'?1n:0n;}
   return {date,label:`${d.work_status.replace('_',' ')} · ${d.status}`,unmarked:false};}
  if(date<asOf)unmarkedPast++;
  return {date,label:`Unmarked · ${date<asOf?'past':date===asOf?'today':'upcoming'}`,unmarked:true};
 });
 const unique=[...new Set(reasons)];
 const gross=daily!==null&&unique.length===0&&known>0?money((daily*units+1n)/2n):null;
 return {days,gross,halfDayUnits:units,unmarkedPast,reasons:unique,known};
}
