import {buildWeeklyPreview,parseWeeklyInput,weekDates} from './weeklyPreview';
import {workerPayrollPeriod} from './periods';

/** Local-only, user-entered illustration. It does not represent saved records. */
export type WeeklyWalkthroughInput={date:string;rate:string;days:{regular:string;overtime:string}[];allowance:string;bale:string};
const decimal=/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/;
const value=(raw:string,label:string)=>{
 const text=raw.trim()||'0';
 if(!decimal.test(text))throw Error(`${label}: enter a non-negative amount with at most two decimal places.`);
 return text;
};
const hundredths=(s:string)=>{const [whole,part='']=s.split('.');return BigInt(whole)*100n+BigInt(part.padEnd(2,'0'));};

export function calculateWeeklyWalkthrough(input:WeeklyWalkthroughInput){
 const period=workerPayrollPeriod(input.date),dates=weekDates(period.start);
 if(input.days.length!==7)throw Error('Seven days are required.');
 const rate=value(input.rate,'Daily rate'),allowance=value(input.allowance,'Allowance'),bale=value(input.bale,'Bale');
 const attendance=input.days.flatMap((day,index)=>{
  const regular=value(day.regular,`${dates[index]} regular hours`),overtime=value(day.overtime,`${dates[index]} overtime hours`);
  if(hundredths(regular)>800n||hundredths(regular)+hundredths(overtime)>2400n)throw Error(`${dates[index]}: regular hours cannot exceed 8, and combined hours cannot exceed 24.`);
  if(hundredths(regular)+hundredths(overtime)===0n)return [];
  return [{id:`day-${index}`,worker_id:'illustration',project_id:'illustration-site',date:dates[index],status:'present',hours_worked:regular,time_detail:{regular_hours:regular,overtime_hours:overtime,stale:false}}];
 });
 if(attendance.length && !input.rate.trim())throw Error('Enter a daily rate to illustrate earnings.');
 if(!attendance.length && (hundredths(allowance)>0n||hundredths(bale)>0n))throw Error('Enter at least one worked day to illustrate allowance or Bale.');
 const raw={start:period.start,end:period.end,workers:[{id:'illustration',name:'Illustration only',position:'',active:true,pay_rate:rate,pay_rate_type:'daily',linked_supervisor:false,possible_supervisor:false}],attendance,vouchers:[],
  allowances:hundredths(allowance)>0n?[{id:'allowance',worker_id:'illustration',project_id:'illustration-site',description:'Illustrative approved allowance',amount:allowance,status:'approved',date:attendance[0].date,stale:false}]:[],
  advances:hundredths(bale)>0n?[{id:'bale',worker_id:'illustration',project_id:'illustration-site',date:dates[3],amount:bale,deducted:'0',status:'active',linked_release:true}]:[],older_advances:[]};
 // Illustrate the end of the selected week; this does not assert today's date.
 return {period,dates,row:buildWeeklyPreview(parseWeeklyInput(raw,period.start),period.end).rows[0]};
}
