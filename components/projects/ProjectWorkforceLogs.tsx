'use client';

import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { UserCheck } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { formatDatePH } from '@/lib/email/format';
import { manilaDateISO, shiftCalendarDate } from '@/lib/dates/manila';
import { firstOfMonth, monthDates, parseCalendarCounts, shiftMonth, weekDates } from '@/lib/attendance/calendar';
import { useAttendanceHistory } from '@/lib/attendance/useAttendanceHistory';
import { createClient } from '@/lib/supabase/client';
import type { HistoryRecord } from '@/lib/attendance/history';

const weekday = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
type CalendarState = { key:string; counts:Map<string,number>; loading:boolean; error:boolean };

/** Scoped server reads: the shared, potentially truncated data store is not used. */
export function ProjectWorkforceLogs({ projectId, userId }: { projectId:string; userId:string | undefined }) {
  const [selected,setSelected]=useState(()=>manilaDateISO());
  const [search,setSearch]=useState('');
  const [revision,setRevision]=useState(0);
  const month=firstOfMonth(selected);
  const key=JSON.stringify([projectId,userId,month,revision]);
  const currentKey=useRef(key); currentKey.current=key;
  const [calendar,setCalendar]=useState<CalendarState>({key:'',counts:new Map(),loading:true,error:false});
  useEffect(()=>{
    let live=true;
    setCalendar({key,counts:new Map(),loading:Boolean(userId),error:false});
    if (!userId) return ()=>{live=false};
    void (async()=>{
      try {
        const {data,error}=await createClient().rpc('project_attendance_calendar',{p_project_id:projectId,p_month:month});
        if (error) throw error;
        const counts=parseCalendarCounts(data,month);
        if(live && currentKey.current===key) setCalendar({key,counts,loading:false,error:false});
      } catch {
        if(live && currentKey.current===key) setCalendar({key,counts:new Map(),loading:false,error:true});
      }
    })();
    return ()=>{live=false};
  },[key,month,projectId,userId]);
  const view=calendar.key===key ? calendar : {key,counts:new Map<string,number>(),loading:Boolean(userId),error:false};
  const records=useAttendanceHistory<HistoryRecord>('records',true,userId,{projectId,status:'all',date:selected,search},revision);
  const dateButton=(date:string) => {
    const count=view.counts.get(date);
    return <button type="button" key={date} disabled={date < '1900-01-01' || date > '9998-12-31'} aria-pressed={selected===date} aria-label={`${formatDatePH(date)}${view.loading || view.error ? '' : count ? `, ${count} records` : ', no records'}`} onClick={()=>setSelected(date)} className={`min-h-11 rounded-lg border p-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${selected===date?'border-brand bg-brand text-white':'border-surface-border bg-white text-navy hover:bg-surface'}`}>
      <span className="block font-bold">{Number(date.slice(8))}</span>
      {!view.loading && !view.error && count != null && <span className="block text-[10px]">{count} rec.</span>}
    </button>;
  };
  if (!userId) return <div role="status" className="text-xs text-ink-secondary">Sign in to view site attendance.</div>;
  return <div className="animate-panel-enter animate-panel-lift space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="text-sm font-bold text-navy">Site Attendance Logs</h3>
      <Link href="/attendance" className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-brand bg-brand px-3 text-xs font-medium text-white hover:bg-brand-deep focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"><UserCheck className="h-3.5 w-3.5" aria-hidden="true" />Go to Attendance Terminal</Link>
    </div>
    <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs text-ink-secondary">Dates show recorded entries for this site, not complete attendance or proof of absence. Select a day to view its records.</p><Button type="button" variant="secondary" size="sm" onClick={()=>setRevision(n=>n+1)}>Refresh logs</Button></div>
    <div className="rounded-xl border border-surface-border bg-white p-3 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button type="button" variant="secondary" size="sm" disabled={month <= '1900-01-01'} onClick={()=>setSelected(shiftMonth(month,-1))}>Previous month</Button>
        <h4 className="font-bold text-navy">{new Date(`${month}T00:00:00Z`).toLocaleDateString('en-PH',{month:'long',year:'numeric',timeZone:'UTC'})}</h4>
        <Button type="button" variant="secondary" size="sm" disabled={month >= '9998-12-01'} onClick={()=>setSelected(shiftMonth(month,1))}>Next month</Button>
      </div>
      {view.loading && <p role="status" className="text-xs text-ink-secondary">Loading calendar…</p>}
      {view.error && <div role="alert" className="text-xs text-status-danger">Calendar could not be loaded. <Button type="button" variant="secondary" size="sm" onClick={()=>setRevision(n=>n+1)}>Retry calendar</Button></div>}
      <div className="hidden sm:block">
        <div className="grid grid-cols-7 gap-1 text-center text-xs text-ink-secondary">{weekday.map(d=><span key={d}>{d}</span>)}</div>
        <div className="mt-1 grid grid-cols-7 gap-1">{monthDates(month).map((date,i)=>date ? dateButton(date) : <span key={`blank-${i}`} />)}</div>
      </div>
      <div className="sm:hidden space-y-2">
        <div className="flex justify-between gap-2"><Button type="button" variant="secondary" size="sm" disabled={selected < '1900-01-08'} onClick={()=>setSelected(shiftCalendarDate(selected,-7))}>Previous week</Button><Button type="button" variant="secondary" size="sm" disabled={selected > '9998-12-24'} onClick={()=>setSelected(shiftCalendarDate(selected,7))}>Next week</Button></div>
        <div className="grid grid-cols-7 gap-1 text-center text-xs text-ink-secondary">{weekday.map(d=><span key={d}>{d}</span>)}</div>
        <div className="grid grid-cols-7 gap-1">{weekDates(selected).map(dateButton)}</div>
      </div>
      <Input label="Choose attendance date" type="date" value={selected} min="1900-01-01" max="9998-12-31" onChange={event=>{const value=event.target.value; if(value >= '1900-01-01' && value <= '9998-12-31') setSelected(value)}} />
    </div>
    <details key={selected} open className="rounded-xl border border-surface-border bg-white p-3">
      <summary className="cursor-pointer font-bold text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand">{formatDatePH(selected)} · recorded attendance</summary>
      <div className="mt-3 space-y-3">
      <Input label="Search day records" placeholder="Worker, craft or note" value={search} onChange={event=>setSearch(event.target.value)} />
      {records.loading && <p role="status" className="text-xs text-ink-secondary">Loading attendance records…</p>}
      {records.error && <div role="alert" className="space-y-2 text-xs text-status-danger">Could not load day records. <Button type="button" variant="secondary" size="sm" onClick={records.retry}>Retry records</Button></div>}
      {!records.loading && !records.error && records.items.length===0 && <p className="text-xs text-ink-secondary">{search ? 'No records match this search for the selected date.' : 'No records found for this date. Unmarked is not absent.'}</p>}
      <div className="divide-y divide-surface-border/70">{records.items.map(rec=><div key={rec.id} className="flex flex-wrap items-start justify-between gap-2 py-3 text-xs">
        <div className="min-w-0 flex-1"><div className="break-words font-semibold text-navy">{rec.worker_name || 'Worker (details unavailable)'}</div>{rec.worker_position && <div className="text-ink-secondary">{rec.worker_position}</div>}{rec.notes && <div className="mt-1 whitespace-pre-wrap break-words text-ink-secondary">{rec.notes}</div>}</div>
        <div className="flex items-center gap-2"><span className="text-ink-secondary">{rec.hours_worked} hrs recorded</span><Badge variant={rec.status==='present'?'success':rec.status==='half_day'?'warning':rec.status==='leave'?'info':'danger'} size="sm">{rec.status==='half_day'?'Half day':rec.status==='present'?'Present':rec.status==='leave'?'Leave':'Absent'}</Badge></div>
      </div>)}</div>
      {records.hasMore && !records.error && <Button type="button" variant="secondary" size="sm" disabled={records.loading} onClick={records.loadMore}>Show more day records</Button>}
      </div>
    </details>
  </div>;
}
