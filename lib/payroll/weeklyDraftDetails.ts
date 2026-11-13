import {weekDates} from './weeklyPreview';
import {workerPayrollPeriod} from './periods';

type Calculation={regular_hours:string;overtime_hours:string;wage:string;allowance:string;gross:string;bale:string;net:string;unmarked_dates:string[]};
type Allocation={project_id:string;hours:string;wage:string;allowance:string;gross:string};
export type WeeklyDraftDetails={payroll_id:string;worker_id:string;period_start:string;period_end:string;status:'draft'|'approved'|'paid';calculation:Calculation;gross:string;bale:string;other:string;net:string;payment_date:string|null;approved:boolean;allocations:Allocation[]};
const amount=/^(?:0|[1-9]\d{0,9})\.\d{2}$/;
const units=(value:unknown):bigint=>{if(typeof value!=='string'||!amount.test(value))throw new Error('Invalid weekly voucher amount');const [a,b]=value.split('.');return BigInt(a)*100n+BigInt(b);};
const validDate=(value:unknown):value is string=>{try{return typeof value==='string'&&!!workerPayrollPeriod(value);}catch{return false;}};
/** The snapshot lists unmarked dates; this groups them relative to today's date, not its creation date. */
export function classifyUnmarkedDates(dates:string[],today:string):{past:string[];today:string[];upcoming:string[]} {
 if(!validDate(today)||dates.some(d=>!validDate(d)))throw new Error('Invalid calendar date');
 return {past:dates.filter(d=>d<today),today:dates.filter(d=>d===today),upcoming:dates.filter(d=>d>today)};
}
/** Reject incomplete, inconsistent or unexpected responses rather than enabling finance actions. */
export function parseWeeklyDraftDetails(raw:unknown,expected:{id:string;worker:string;start:string}):WeeklyDraftDetails {
 if(!raw||typeof raw!=='object')throw new Error('Invalid weekly voucher details');
 const d=raw as WeeklyDraftDetails, c=d.calculation, week=workerPayrollPeriod(expected.start);
 if(week.start!==expected.start||d.payroll_id!==expected.id||d.worker_id!==expected.worker||d.period_start!==week.start||d.period_end!==week.end||!['draft','approved','paid'].includes(d.status)||typeof d.approved!=='boolean'||!c||typeof c!=='object'||!Array.isArray(c.unmarked_dates)||!Array.isArray(d.allocations)||d.allocations.length>10000)throw new Error('Invalid or mismatched weekly voucher details');
 if((d.status==='draft'&&d.approved)||(d.status!=='draft'&&!d.approved)||(d.status==='paid'?!validDate(d.payment_date):d.payment_date!==null))throw new Error('Inconsistent weekly voucher state');
 const regular=units(c.regular_hours),ot=units(c.overtime_hours),wage=units(c.wage),allowance=units(c.allowance),gross=units(c.gross),bale=units(c.bale),net=units(c.net);
 if(wage+allowance!==gross||gross<bale||gross-bale!==net||units(d.gross)!==gross||units(d.bale)!==bale||units(d.other)!==0n||units(d.net)!==net)throw new Error('Weekly voucher totals do not reconcile');
 const days=weekDates(expected.start),unmarked=new Set(c.unmarked_dates);if(unmarked.size!==c.unmarked_dates.length||c.unmarked_dates.some(day=>!days.includes(day)))throw new Error('Invalid unmarked dates');
 let hours=0n,allocWage=0n,allocAllowance=0n,allocGross=0n;const sites=new Set<string>();
 for(const a of d.allocations){if(!a||typeof a.project_id!=='string'||!a.project_id||sites.has(a.project_id))throw new Error('Invalid project allocation');sites.add(a.project_id);const h=units(a.hours),w=units(a.wage),l=units(a.allowance),g=units(a.gross);if(h===0n||w+l!==g)throw new Error('Invalid project allocation');hours+=h;allocWage+=w;allocAllowance+=l;allocGross+=g;}
 if(d.status==='paid'?(hours!==regular+ot||allocWage!==wage||allocAllowance!==allowance||allocGross!==gross):d.allocations.length!==0)throw new Error('Project allocations do not reconcile');
 return d;
}
