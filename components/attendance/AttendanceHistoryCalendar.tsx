'use client';
import React, {useEffect,useRef,useState} from 'react';
import {Button} from '@/components/ui/Button';
import {createClient} from '@/lib/supabase/client';
import {firstOfMonth,monthDates,parseCalendarCounts,shiftMonth,weekDates} from '@/lib/attendance/calendar';
import {shiftCalendarDate} from '@/lib/dates/manila';
import {formatDatePH} from '@/lib/email/format';
import type {HistoryFilters} from '@/lib/attendance/history';

const days=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
type View={key:string;counts:Map<string,number>;loading:boolean;error:boolean};
const supported=(date:string)=>/^\d{4}-\d{2}-\d{2}$/.test(date) && date>='1900-01-01' && date<='9998-12-31' && Number.isFinite(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).toISOString().slice(0,10)===date;
/** The calendar is a server aggregate of the authorized matching records, not a roster. */
export function AttendanceHistoryCalendar({userId,today,filters,settling,revision,onSelectDate}:{userId:string|undefined;today:string;filters:HistoryFilters;settling:boolean;revision:number;onSelectDate:(date:string)=>void}) {
 const [anchor,setAnchor]=useState(()=>supported(filters.date)?filters.date:today);
 const [retry,setRetry]=useState(0);
 useEffect(()=>{if(supported(filters.date))setAnchor(filters.date)},[filters.date]);
 const month=firstOfMonth(anchor);
 const key=JSON.stringify([userId,month,filters.projectId,filters.status,filters.search,settling,revision,retry]);
 const currentKey=useRef(key);currentKey.current=key;
 const [state,setState]=useState<View>({key:'',counts:new Map(),loading:true,error:false});
 useEffect(()=>{
  let live=true;
  setState({key,counts:new Map(),loading:Boolean(userId),error:false});
  if(!userId || settling)return ()=>{live=false};
  void (async()=>{
   try{
    const {data,error}=await createClient().rpc('attendance_history_calendar',{p_month:month,p_project_id:filters.projectId==='all'?null:filters.projectId,p_status:filters.status==='all'?null:filters.status,p_search:filters.search.trim()||null});
    if(error)throw error;const counts=parseCalendarCounts(data,month);
    if(live && currentKey.current===key)setState({key,counts,loading:false,error:false});
   }catch{if(live && currentKey.current===key)setState({key,counts:new Map(),loading:false,error:true});}
  })();
  return ()=>{live=false};
 },[key,month,userId,filters.projectId,filters.status,filters.search,settling]);
 const view=state.key===key?state:{key,counts:new Map<string,number>(),loading:Boolean(userId),error:false};
 const dateButton=(date:string)=>{
  const count=view.counts.get(date);
  return <button type="button" key={date} disabled={date<'1900-01-01'||date>'9998-12-31'||date>today} aria-pressed={filters.date===date} aria-label={`${formatDatePH(date)}${view.loading||view.error?'':count?`, ${count} matching ${count===1?'record':'records'}`: ', no matching records'}`} onClick={()=>{setAnchor(date);onSelectDate(date)}} className={`min-h-11 rounded-lg border p-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-40 ${filters.date===date?'border-brand bg-brand text-white':'border-surface-border bg-white text-navy hover:bg-surface'}`}><span className="block font-bold">{Number(date.slice(8))}</span>{!view.loading&&!view.error&&count!=null&&<span className="block text-[10px]">{count} rec.</span>}</button>;
 };
 if(!userId)return <p role="status" className="text-xs text-ink-secondary">Sign in to view the calendar.</p>;
 return <section aria-label="Attendance history calendar" className="rounded-xl border border-surface-border bg-white p-3 space-y-3">
  <div><h3 className="text-sm font-bold text-navy">Attendance calendar</h3><p className="text-xs text-ink-secondary">Counts match the site, status and search filters, not the date filter. Blank means no matching records, not absence. Select a day to filter the sheets.</p></div>
  {filters.date&&!supported(filters.date)&&<p className="text-xs text-status-warning">The date filter is outside the calendar range; the history list still uses it.</p>}
  <div className="flex flex-wrap items-center justify-between gap-2"><Button type="button" variant="secondary" size="sm" disabled={month<='1900-01-01'} onClick={()=>setAnchor(shiftMonth(month,-1))}>Previous month</Button><h4 className="font-bold text-navy">{new Date(`${month}T00:00:00Z`).toLocaleDateString('en-PH',{month:'long',year:'numeric',timeZone:'UTC'})}</h4><Button type="button" variant="secondary" size="sm" disabled={month>=firstOfMonth(today)||month>='9998-12-01'} onClick={()=>setAnchor(shiftMonth(month,1))}>Next month</Button></div>
  {view.loading&&<p role="status" className="text-xs text-ink-secondary">{settling?'Updating calendar filters…':'Loading calendar…'}</p>}
  {view.error&&<div role="alert" className="text-xs text-status-danger">Calendar could not be loaded. <Button type="button" variant="secondary" size="sm" onClick={()=>setRetry(n=>n+1)}>Retry calendar</Button></div>}
  <div className="hidden sm:block"><div className="grid grid-cols-7 gap-1 text-center text-xs text-ink-secondary">{days.map(d=><span key={d}>{d}</span>)}</div><div className="mt-1 grid grid-cols-7 gap-1">{monthDates(month).map((date,i)=>date?dateButton(date):<span key={`blank-${i}`}/>)}</div></div>
  <div className="space-y-2 sm:hidden"><div className="flex justify-between gap-2"><Button type="button" variant="secondary" size="sm" disabled={anchor<'1900-01-08'} onClick={()=>setAnchor(shiftCalendarDate(anchor,-7))}>Previous week</Button><Button type="button" variant="secondary" size="sm" disabled={anchor>'9998-12-24'||weekDates(shiftCalendarDate(anchor,7))[0]>today} onClick={()=>{const next=shiftCalendarDate(anchor,7);setAnchor(next>today?today:next)}}>Next week</Button></div><div className="grid grid-cols-7 gap-1 text-center text-xs text-ink-secondary">{days.map(d=><span key={d}>{d}</span>)}</div><div className="grid grid-cols-7 gap-1">{weekDates(anchor).map(dateButton)}</div></div>
  {filters.date&&<Button type="button" variant="ghost" size="sm" onClick={()=>onSelectDate('')}>Show all dates</Button>}
 </section>;
}
