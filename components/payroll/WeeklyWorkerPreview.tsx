'use client';

import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useAuth } from '@/lib/auth/authContext';
import { createClient } from '@/lib/supabase/client';
import { useDataStore } from '@/lib/data/store';
import { getManilaClock } from '@/lib/reminders/scheduler';
import { useManilaToday } from '@/lib/dates/useManilaToday';
import { workerPayrollPeriod } from '@/lib/payroll/periods';
import { weeklyWorkerActionsPreviewEnabled } from '@/lib/finance/featureAvailability';
import { WeeklyWorkerActions } from './WeeklyWorkerActions';
import { buildWeeklyPreview, parseWeeklyInput, regularDayEquivalent, summarizeWeeklyColumns, weekDates, type WeeklyRow } from '@/lib/payroll/weeklyPreview';

type Result={key:string;loading:boolean;error:string|null;rows:WeeklyRow[]|null;excluded:number};
const empty=(key:string):Result=>({key,loading:false,error:null,rows:null,excluded:0});

/** Planning aid only: it cannot save a voucher or establish amounts owed. */
export function WeeklyWorkerPreview() {
 const [open,setOpen]=useState(false);
 return <section className="overflow-hidden rounded-2xl border border-surface-border bg-white">
  <button type="button" aria-expanded={open} onClick={()=>setOpen(v=>!v)} className="flex min-h-11 w-full items-center justify-between gap-3 p-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand sm:p-5">
   <span><span className="block text-sm font-semibold text-navy">Weekly worker planning preview</span><span className="mt-1 block text-xs text-ink-secondary">Sunday–Saturday · read-only, not a payroll run</span></span><ChevronDown aria-hidden="true" className={`h-4 w-4 shrink-0 ${open?'rotate-180':''}`} />
  </button>
  {open && <Contents />}
 </section>;
}
function Contents(){
 const {user,isFounder}=useAuth();
 const {projects}=useDataStore();
 const today=useManilaToday();
 const [date,setDate]=useState(()=>getManilaClock().dateIso);
 const [result,setResult]=useState<Result>(()=>empty(''));
 const sequence=useRef(0),busy=useRef(false);
 let period:ReturnType<typeof workerPayrollPeriod>|null=null;
 try {period=workerPayrollPeriod(date);} catch { /* Date input may be blank. */ }
 const start=period?.start || '',end=period?.end || '';
 // Crossing Manila midnight invalidates the snapshot and its action controls.
 const key=JSON.stringify([user?.id,isFounder,start,today]);
 const currentKey=useRef(key);currentKey.current=key;
 useEffect(()=>{const seq=sequence;const lock=busy;seq.current++;lock.current=false;setResult(empty(key));return()=>{seq.current++;lock.current=false;};},[key]);
 const current=result.key===key?result:empty(key);
 async function load(){
  if(!isFounder||!user?.id||!start||busy.current)return;
  const token=++sequence.current;busy.current=true;setResult({...empty(key),loading:true});
  try {
   const {data,error}=await createClient().rpc('weekly_worker_preview_inputs',{p_start:start});
   if(error)throw new Error(error.message);
   if(getManilaClock().dateIso!==today)throw new Error('Philippine date changed; refresh the preview');
   const preview=buildWeeklyPreview(parseWeeklyInput(data,start),today);
   if(token!==sequence.current||currentKey.current!==key)return;
   setResult({key,loading:false,error:null,rows:preview.rows,excluded:preview.linkedSupervisors});
  } catch(e){if(token===sequence.current&&currentKey.current===key)setResult({...empty(key),error:e instanceof Error?e.message:'Unable to load preview'});}
  finally {if(token===sequence.current&&currentKey.current===key)busy.current=false;}
 }
 return <div className="space-y-4 border-t border-surface-border p-4 sm:p-5">
  <p className="text-xs leading-relaxed text-ink-secondary">Choose any date in the week. The table is a planning aid, not a payroll run. {weeklyWorkerActionsPreviewEnabled()?'The separately gated experimental voucher controls below can save, approve and record external payment only when explicitly confirmed.':'It does not save, approve, pay, deduct Bale or update project costs.'} Refresh after changes.</p>
  <div className="flex flex-wrap items-end gap-3"><div className="w-full sm:w-52"><Input label="Date in worker week" type="date" min="1900-01-01" max="9998-12-24" value={date} onChange={e=>setDate(e.target.value)} /></div><Button type="button" variant="secondary" size="sm" onClick={load} isLoading={current.loading} disabled={!isFounder||!user?.id||!start}>{current.rows?'Refresh preview':'Load preview'}</Button></div>
  {period && <p className="text-xs font-semibold text-navy">{start} to {end} · planned release Saturday {end}</p>}
  <p className="rounded-xl border border-status-warning/25 bg-status-warning-bg p-3 text-xs leading-relaxed text-ink-secondary">This preliminary estimate uses current rates, not historical rates. Approved current allowances are shown once. Recorded period Bale is shown at its full amount, not an outstanding-balance cap. Other deductions are excluded. Project estimates below illustrate gross wages and allowances, not costs posted to a project; they use recorded hours and current rates. Bale is not added again or subtracted from the gross estimate. Net is withheld for ambiguous, already deducted or non-Wednesday Bale, older outstanding Bale, pending, stale or unmatched allowances, overlapping vouchers and other conflicts. A linked request is not proof of payment and does not rule out duplicate manual records. Unmarked days are not absences. Draft or reviewed voucher amounts are not compared; nothing here replaces an approved or paid voucher. Reconcile independently.</p>
  {current.error&&<p role="alert" className="text-sm text-status-danger">Could not load weekly preview: {current.error}</p>}
  {current.loading&&<p role="status" className="text-sm text-ink-secondary">Loading weekly preview…</p>}
  {current.rows&&<>
   <p className="text-xs text-ink-secondary">Includes active workers and inactive workers with logs this week, regardless of current site. {current.excluded} UUID-linked Supervisor profile(s) excluded; identity matching for other profiles is only a warning and can miss cases. Missing past days may not have been scheduled work. Today and future days are not treated as missing past records. Dates use the device’s Philippine-time clock; if the day changes, reload this snapshot. Future-dated source records require review rather than inclusion in an estimate. OT uses daily rate ÷ 8 (or hourly rate), with no Sunday/holiday premium under the requested rule; seek payroll/legal advice before use.</p>
   {current.rows.length>0&&(()=>{const totals=summarizeWeeklyColumns(current.rows);return <p className="rounded-xl bg-surface-inset p-3 text-xs text-ink-secondary">Partial subtotal of {totals.count} row(s) with an illustrative net: {totals.regularHours} regular hrs · {totals.otHours} OT hrs · wages ₱{totals.wage} · allowances ₱{totals.allowance} · Bale ₱{totals.bale} · gross ₱{totals.gross} · net ₱{totals.net}. Excludes {totals.excluded} worker row(s), plus {current.excluded} linked Supervisor profile(s); unmarked days can still make included rows incomplete. Not a payroll total or payment authorization.</p>;})()}
   {current.rows.length===0?<p className="text-sm text-ink-secondary">No worker profiles in this preview.</p>:<div role="region" aria-label="Weekly worker preview, scroll horizontally" tabIndex={0} className="max-w-full overflow-x-auto rounded-xl border border-surface-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand">
    <table className="w-full border-collapse text-xs"><caption className="sr-only">Read-only worker planning preview for {start} to {end}. Days without records are unmarked, not absent.</caption>
    <thead className="bg-surface-inset"><tr>
     <th scope="col" className="min-w-40 p-3 text-left">Worker / current rate</th>
     {weekDates(start).map((day,i)=><th key={day} scope="col" className="min-w-28 p-3 text-left">{['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][i]}<br />{day}</th>)}
     <th scope="col" className="min-w-44 p-3 text-left">Work and earnings</th>
     <th scope="col" className="min-w-36 p-3 text-left">Allowances / Bale</th>
     <th scope="col" className="min-w-48 p-3 text-left">Net / review</th>
    </tr></thead>
    <tbody>{current.rows.map(row=><tr key={row.worker.id} className="border-t border-surface-border align-top">
     <th scope="row" className="p-3 text-left"><span className="block break-words font-semibold">{row.worker.name}</span><span className="block font-normal text-ink-secondary">{row.worker.position}{!row.worker.active?' · inactive':''}</span><span className="block font-normal text-ink-secondary">₱{row.worker.pay_rate} / {row.worker.pay_rate_type==='daily'?'day':'hour'}</span></th>
     {row.days.map(day=><td key={day.date} className="p-3 text-ink-secondary">{day.entries.length ? day.entries.map((entry,i)=><div key={entry.id}>{i>0&&<span>Additional entry: </span>}{entry.status.replace('_',' ')}<br />{entry.time_detail ? `${entry.time_detail.regular_hours} regular + ${entry.time_detail.overtime_hours} OT hrs${entry.time_detail.stale?' · stale, review':''}` : `${entry.hours_worked} legacy hrs`}</div>) : <span>{day.unmarked==='upcoming'?'Upcoming':day.unmarked==='today'?'Unmarked today':'Past unmarked'}</span>}</td>)}
     <td className="p-3 text-ink-secondary">{row.pastUnmarked&&<p className="mb-2 font-semibold text-status-warning">Past unmarked day(s) — review, not presumed absent.</p>}{row.wage===null?<p>No earnings estimate; check reasons or saved vouchers.</p>:<p>{row.regularHours} regular hrs ({regularDayEquivalent(row.regularHours)} days at 8 hrs/day) + {row.otHours} OT hrs · wages ₱{row.wage} · gross with allowances ₱{row.gross}</p>}<details className="mt-2"><summary className="cursor-pointer font-semibold text-navy">Illustrative project breakdown</summary>{row.projectEstimates===null?<p className="mt-1">Unavailable: review the worker, attendance, allowances and voucher context. No project costs were posted.</p>:<><p className="mt-1">Recorded hours split wages; allowances follow their recorded site. Not posted or proof of payment.</p><ul className="mt-1 space-y-1">{row.projectEstimates.map(site=><li key={site.projectId} className="break-all">{projects.find(p=>p.id===site.projectId)?.name || `Site ID ${site.projectId}`}: ₱{site.gross} gross (₱{site.wage} wages + ₱{site.allowance} allowances)</li>)}</ul></>}</details></td>
     <td className="p-3 text-ink-secondary"><div>Approved, non-stale allowances: ₱{row.allowance}</div><div>Pending allowances: {row.pendingAllowances}</div><div>Recorded non-cancelled Bale: ₱{row.bale}</div><div>Older active balance (not carried): ₱{row.olderBalance}</div></td>
     <td className="p-3 text-ink-secondary">{row.net===null?<div className="font-semibold text-status-warning">Net withheld — review</div>:<div className="font-semibold text-navy">Illustrative net: ₱{row.net}</div>}{row.reviewReasons.map(reason=><div className="mt-1 text-status-warning" key={reason}>{reason}</div>)}{row.vouchers.length?row.vouchers.map(v=><div className="mt-1" key={v.id}>At preview refresh: {v.status} voucher ({v.period_start} → {v.period_end})</div>):<div className="mt-1">At preview refresh: no overlapping voucher</div>}{weeklyWorkerActionsPreviewEnabled()&&isFounder&&user?.id&&<WeeklyWorkerActions key={`${key}:${sequence.current}:${row.worker.id}`} row={row} start={start} end={end} previewDate={today} userId={user.id} projects={projects} />}</td>
    </tr>)}</tbody></table></div>}
  </>}
 </div>;
}
