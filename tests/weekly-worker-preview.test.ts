import { describe, expect, it } from 'vitest';
import { buildWeeklyPreview, parseWeeklyInput, regularDayEquivalent, summarizeWeekly, summarizeWeeklyColumns, weekDates } from '@/lib/payroll/weeklyPreview';

const snapshot=()=>({start:'2026-11-15',end:'2026-11-21',workers:[{id:'w',name:'Worker',position:'Mason',active:true,pay_rate:'655.55',pay_rate_type:'daily',linked_supervisor:false,possible_supervisor:false}],attendance:[{id:'a',worker_id:'w',project_id:'p',date:'2026-11-15',status:'present',hours_worked:'8.00',time_detail:null as {regular_hours:string;overtime_hours:string;stale:boolean}|null},{id:'b',worker_id:'w',project_id:'p',date:'2026-11-16',status:'half_day',hours_worked:'4.00',time_detail:null as {regular_hours:string;overtime_hours:string;stale:boolean}|null}],vouchers:[] as {id:string;worker_id:string;status:string;period_start:string;period_end:string}[],allowances:[] as {id:string;worker_id:string;project_id:string;description:string;amount:string;status:string;date:string;stale:boolean}[],advances:[] as {id:string;worker_id:string;project_id:string;date:string;amount:string;deducted:string;status:string;linked_release:boolean}[],older_advances:[] as {id:string;worker_id:string;amount:string;deducted:string;status:string}[]});
const view=(s:ReturnType<typeof snapshot>)=>buildWeeklyPreview(parseWeeklyInput(s,s.start),'2026-11-18');
describe('weekly worker planning preview',()=>{
 it('uses Sunday–Saturday, preserves centavos, and marks missing days without calling them absent',()=>{
  const v=view(snapshot());expect(weekDates('2026-11-15')).toEqual(['2026-11-15','2026-11-16','2026-11-17','2026-11-18','2026-11-19','2026-11-20','2026-11-21']);
  expect(v.rows[0]).toMatchObject({wage:'983.33',gross:'983.33',net:'983.33',pastUnmarked:true});
  expect(v.rows[0].days.map(d=>d.unmarked)).toEqual([null,null,'past','today','upcoming','upcoming','upcoming']);
 });
 it('converts regular hours to eight-hour day equivalents with decimal rounding',()=>{
  expect(regularDayEquivalent('8.00')).toBe('1.00');expect(regularDayEquivalent('4.00')).toBe('0.50');
  expect(regularDayEquivalent('0.04')).toBe('0.01');expect(regularDayEquivalent('12.01')).toBe('1.50');
  expect(()=>regularDayEquivalent('-1')).toThrow();
 });
 it('subtotals the same included workers across hours, pay, allowances and Bale',()=>{
  const s=snapshot();s.attendance[0].time_detail={regular_hours:'8.00',overtime_hours:'2.00',stale:false};
  s.allowances.push({id:'x',worker_id:'w',project_id:'p',description:'Meals',date:s.start,amount:'50.25',status:'approved',stale:false});
  s.advances.push({id:'z',worker_id:'w',project_id:'p',date:'2026-11-18',amount:'500.50',deducted:'0',status:'active',linked_release:true});
  s.workers.push({...s.workers[0],id:'unmarked',name:'Unmarked'});
  const rows=view(s).rows;
  expect(summarizeWeeklyColumns(rows)).toEqual({count:1,excluded:1,regularHours:'12.00',otHours:'2.00',wage:'1147.21',allowance:'50.25',bale:'500.50',gross:'1197.46',net:'696.96'});
  expect(summarizeWeeklyColumns([rows[1]])).toMatchObject({count:0,excluded:1,regularHours:'0.00',bale:'0.00',net:'0.00'});
 });
 it('handles hourly rates and rounds once to centavos',()=>{
  const s=snapshot();s.workers[0].pay_rate_type='hourly';s.workers[0].pay_rate='100.05';s.attendance[0].hours_worked='1.50';s.attendance[1].hours_worked='0.25';expect(view(s).rows[0].wage).toBe('175.09');
 });
 it('calculates explicit OT and approves each current allowance exactly once',()=>{
  const s=snapshot();s.attendance[0].time_detail={regular_hours:'8.00',overtime_hours:'2.00',stale:false};
  s.allowances.push({id:'x',worker_id:'w',project_id:'p',description:'Meals',date:'2026-11-15',amount:'50.25',status:'approved',stale:false});
  s.advances.push({id:'z',worker_id:'w',project_id:'p',date:'2026-11-18',amount:'500.50',deducted:'0.00',status:'active',linked_release:true});
  expect(view(s).rows[0]).toMatchObject({regularHours:'12.00',otHours:'2.00',wage:'1147.21',allowance:'50.25',gross:'1197.46',bale:'500.50',net:'696.96',review:false});
  expect(summarizeWeekly(view(s).rows)).toEqual({count:1,excluded:0,gross:'1197.46',net:'696.96'});
  s.allowances.push({...s.allowances[0]});expect(()=>parseWeeklyInput(s,s.start)).toThrow();
 });
 it('illustrates moved-worker gross by recorded site without adding Bale twice or posting a cost',()=>{
  const s=snapshot();s.attendance[1].project_id='p2';
  s.allowances.push({id:'x',worker_id:'w',project_id:'p2',description:'Meals',date:'2026-11-16',amount:'25.05',status:'approved',stale:false});
  s.advances.push({id:'z',worker_id:'w',project_id:'p',date:'2026-11-18',amount:'500.00',deducted:'0',status:'active',linked_release:true});
  expect(view(s).rows[0]).toMatchObject({gross:'1008.38',net:'508.38',projectEstimates:[{projectId:'p',wage:'655.55',allowance:'0.00',gross:'655.55'},{projectId:'p2',wage:'327.78',allowance:'25.05',gross:'352.83'}]});
  s.vouchers.push({id:'v',worker_id:'w',status:'paid',period_start:s.start,period_end:s.end});expect(view(s).rows[0].projectEstimates).toBeNull();
  s.vouchers=[];s.advances[0].linked_release=false;expect(view(s).rows[0].projectEstimates).toBeNull();
 });
 it('withholds earnings, net and site attribution when an approved allowance cannot be matched to worked attendance',()=>{
  const s=snapshot();s.allowances.push({id:'x',worker_id:'w',project_id:'p',description:'Meals',date:'2026-11-17',amount:'25.05',status:'approved',stale:false});
  let row=view(s).rows[0];expect(row).toMatchObject({wage:null,gross:null,net:null,projectEstimates:null});expect(row.reviewReasons).toContain('Approved allowance has no matching worked attendance');
  expect(summarizeWeeklyColumns([row])).toMatchObject({count:0,excluded:1,allowance:'0.00'});
  s.allowances[0].date=s.start;s.allowances[0].project_id='other';row=view(s).rows[0];expect(row.net).toBeNull();
  s.allowances[0].project_id='p';s.attendance[0].status='absent';s.attendance[0].hours_worked='0';row=view(s).rows[0];expect(row.net).toBeNull();
  s.allowances[0].status='rejected';row=view(s).rows[0];expect(row.net).toBe('327.78');
 });
 it('distinguishes explicitly recorded zero-work days from a fully unmarked week',()=>{
  const s=snapshot();s.attendance=s.attendance.map(a=>({...a,status:'absent',hours_worked:'0'}));
  expect(view(s).rows[0]).toMatchObject({wage:'0.00',gross:'0.00',net:'0.00',pastUnmarked:true,projectEstimates:null});
  s.advances.push({id:'z',worker_id:'w',project_id:'p',date:'2026-11-18',amount:'1.00',deducted:'0',status:'active',linked_release:true});
  expect(view(s).rows[0]).toMatchObject({wage:'0.00',gross:'0.00',net:null,excess:true});
  s.advances=[];s.attendance=[];expect(view(s).rows[0]).toMatchObject({wage:null,gross:null,net:null,pastUnmarked:true});
 });
 it('flags potentially duplicated independently submitted entries without silently dropping them',()=>{
  const s=snapshot();s.allowances.push({id:'x',worker_id:'w',project_id:'p',description:'Meals',date:s.start,amount:'20.00',status:'approved',stale:false},{id:'y',worker_id:'w',project_id:'p',description:' meals ',date:s.start,amount:'20.0',status:'approved',stale:false});
  expect(view(s).rows[0]).toMatchObject({net:null,allowance:'40.00',review:true});
  s.allowances=[];s.advances.push({id:'a1',worker_id:'w',project_id:'p',date:'2026-11-18',amount:'20.00',deducted:'0',status:'active',linked_release:true},{id:'a2',worker_id:'w',project_id:'p',date:'2026-11-18',amount:'20.0',deducted:'0',status:'active',linked_release:true});
  expect(view(s).rows[0]).toMatchObject({net:null,bale:'40.00',review:true});
 });
 it('withholds net on pending or stale allowances and never treats rejected allowances as earnings',()=>{
  const s=snapshot();s.allowances.push({id:'x',worker_id:'w',project_id:'p',description:'Meals',date:s.start,amount:'20.05',status:'pending',stale:false});
  expect(view(s).rows[0]).toMatchObject({net:null,pendingAllowances:1,allowance:'0.00'});
  s.allowances[0].status='approved';s.allowances[0].stale=true;expect(view(s).rows[0]).toMatchObject({net:null,allowance:'0.00'});
  s.allowances[0].status='rejected';expect(view(s).rows[0]).toMatchObject({net:'983.33',allowance:'0.00'});
 });
 it('does not silently re-deduct, carry older Bale, or trust an unlinked release',()=>{
  const s=snapshot();s.advances.push({id:'a1',worker_id:'w',project_id:'p',date:'2026-11-18',amount:'500.00',deducted:'0.00',status:'active',linked_release:false});
  expect(view(s).rows[0]).toMatchObject({bale:'500.00',net:null,review:true});
  s.advances[0].linked_release=true;s.advances[0].deducted='50.00';s.advances[0].status='partially_deducted';expect(view(s).rows[0].net).toBeNull();
  s.advances[0].deducted='0';s.advances[0].status='active';s.advances[0].date='2026-11-19';expect(view(s).rows[0].net).toBeNull();
  s.advances=[];s.older_advances.push({id:'old',worker_id:'w',amount:'600.50',deducted:'100.25',status:'partially_deducted'});
  expect(view(s).rows[0]).toMatchObject({bale:'0.00',olderBalance:'500.25',net:null});
 });
 it('flags excess rather than creating a negative net; excludes review rows from subtotals',()=>{
  const s=snapshot();s.advances.push({id:'a1',worker_id:'w',project_id:'p',date:'2026-11-18',amount:'1000.00',deducted:'0',status:'active',linked_release:true});
  const row=view(s).rows[0];expect(row).toMatchObject({wage:'983.33',gross:'983.33',excess:true,net:null,review:true});expect(summarizeWeekly([row])).toMatchObject({count:0,excluded:1,gross:'0.00',net:'0.00'});
 });
 it('withholds amounts on ambiguous attendance, identities and overlapping paid/draft vouchers',()=>{
  const s=snapshot();s.attendance[0].hours_worked='9.00';expect(view(s).rows[0].net).toBeNull();
  s.attendance[0].hours_worked='8';s.attendance.push({...s.attendance[0],id:'c',project_id:'p2'});expect(view(s).rows[0].net).toBeNull();s.attendance.pop();
  s.attendance[0].time_detail={regular_hours:'8.00',overtime_hours:'2.00',stale:true};expect(view(s).rows[0].net).toBeNull();s.attendance[0].time_detail=null;
  s.workers[0].possible_supervisor=true;expect(view(s).rows[0].net).toBeNull();s.workers[0].possible_supervisor=false;
  s.vouchers.push({id:'v',worker_id:'w',status:'paid',period_start:'2026-11-01',period_end:'2026-11-15'});expect(view(s).rows[0].net).toBeNull();
  s.workers[0].linked_supervisor=true;expect(view(s)).toMatchObject({rows:[],linkedSupervisors:1});
 });
 it('fails closed on missing, malformed, duplicate and out-of-scope inputs',()=>{
  const s=snapshot();expect(()=>parseWeeklyInput(s,'2026-11-16')).toThrow();expect(()=>parseWeeklyInput({...s,end:'2026-11-22'},s.start)).toThrow();
  expect(()=>parseWeeklyInput({...s,allowances:undefined},s.start)).toThrow();expect(()=>parseWeeklyInput({...s,attendance:[s.attendance[0],s.attendance[0]]},s.start)).toThrow();
  expect(()=>parseWeeklyInput({...s,attendance:[{...s.attendance[0],hours_worked:'NaN'}]},s.start)).toThrow();
  expect(()=>parseWeeklyInput({...s,workers:[{...s.workers[0],pay_rate:'-1'}]},s.start)).toThrow();
  expect(()=>parseWeeklyInput({...s,vouchers:[{id:'v',worker_id:'missing',status:'paid',period_start:s.start,period_end:s.end}]},s.start)).toThrow();
 });
});
