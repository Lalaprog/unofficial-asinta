'use client';

import React, {useMemo,useState} from 'react';
import Link from 'next/link';
import {AppShell} from '@/components/layout/AppShell';
import {getManilaClock} from '@/lib/reminders/scheduler';
import {calculateWeeklyWalkthrough} from '@/lib/payroll/weeklyWalkthrough';
import {workerPayrollPeriod} from '@/lib/payroll/periods';
import {weekDates} from '@/lib/payroll/weeklyPreview';

const blankDays=()=>Array.from({length:7},()=>({regular:'',overtime:''}));
const labels=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const inputClass='w-full min-w-20 rounded-lg border border-surface-border bg-white px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand';

/** Design walkthrough only: no calls to finance RPCs and no saved records. */
export function WeeklyFinanceWalkthrough(){
 const [date,setDate]=useState(()=>getManilaClock().dateIso);
 const [rate,setRate]=useState(''),[allowance,setAllowance]=useState(''),[bale,setBale]=useState('');
 const [days,setDays]=useState(blankDays);
 const result=useMemo(()=>{
  try{return {result:calculateWeeklyWalkthrough({date,rate,days,allowance,bale}),error:null};}
  catch(e){return {result:null,error:e instanceof Error?e.message:'Check the entered values.'};}
 },[date,rate,days,allowance,bale]);
 let dates:string[]=[];try{dates=weekDates(workerPayrollPeriod(date).start);}catch{/* Date may be temporarily blank. */}
 const setHours=(i:number,kind:'regular'|'overtime',value:string)=>setDays(old=>old.map((day,index)=>index===i?{...day,[kind]:value}:day));
 const row=result.result?.row;
 return <AppShell requireFounder>
  <div className="mx-auto max-w-6xl space-y-5 px-4 py-6 sm:px-6">
   <Link href="/payroll" className="text-sm font-semibold text-brand hover:underline">← Back to Payroll</Link>
   <header className="space-y-2"><p className="text-xs font-bold uppercase tracking-wider text-brand">Vercel preview · design walkthrough</p><h1 className="text-2xl font-bold text-navy sm:text-3xl">Weekly payroll & Bale</h1><p className="max-w-3xl text-sm leading-relaxed text-ink-secondary">Explore the proposed Sunday–Saturday layout with your own example numbers. This illustration stays in this page: it does not create payroll, issue Bale, transfer money or save your entries.</p></header>
   <div role="note" className="rounded-xl border border-status-warning/25 bg-status-warning-bg p-4 text-sm text-ink-secondary"><strong>Not the finished connected workflow.</strong> Database permissions, scheduling, approvals and old-session handling are not tested by this page. Do not use these figures as payroll or proof of payment.</div>
   <section className="rounded-2xl border border-surface-border bg-white p-4 sm:p-5" aria-labelledby="timeline-heading">
    <h2 id="timeline-heading" className="text-base font-semibold text-navy">The intended week</h2>
    <div className="mt-3 grid gap-2 text-sm sm:grid-cols-3"><div className="rounded-xl bg-surface-inset p-3"><strong className="block text-navy">Sunday–Tuesday</strong><span className="text-ink-secondary">Bale requests and Founder review</span></div><div className="rounded-xl bg-surface-inset p-3"><strong className="block text-navy">Wednesday</strong><span className="text-ink-secondary">Record an external Bale release</span></div><div className="rounded-xl bg-surface-inset p-3"><strong className="block text-navy">Saturday</strong><span className="text-ink-secondary">Review the week and record external pay</span></div></div>
   </section>
   <section className="space-y-4 rounded-2xl border border-surface-border bg-white p-4 sm:p-5" aria-labelledby="example-heading">
    <div><h2 id="example-heading" className="text-base font-semibold text-navy">Try the weekly calculation</h2><p className="mt-1 text-xs text-ink-secondary">Blank days are unmarked, not absent. Regular time is limited to 8 hours a day; overtime uses the daily rate ÷ 8. Amounts are illustrative and rounded to centavos.</p></div>
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
     <label className="text-xs font-semibold text-navy">Date in week<input className={`${inputClass} mt-1`} type="date" min="1900-01-01" max="9998-12-24" value={date} onChange={e=>setDate(e.target.value)} /></label>
     <label className="text-xs font-semibold text-navy">Daily rate (₱)<input className={`${inputClass} mt-1`} inputMode="decimal" value={rate} onChange={e=>setRate(e.target.value)} placeholder="Enter an amount" /></label>
     <label className="text-xs font-semibold text-navy">Approved allowance (₱)<input className={`${inputClass} mt-1`} inputMode="decimal" value={allowance} onChange={e=>setAllowance(e.target.value)} placeholder="Optional" /></label>
     <label className="text-xs font-semibold text-navy">Wednesday Bale (₱)<input className={`${inputClass} mt-1`} inputMode="decimal" value={bale} onChange={e=>setBale(e.target.value)} placeholder="Optional" /></label>
    </div>
    {dates.length===7&&<div role="region" aria-label="Weekly hours, scroll horizontally" tabIndex={0} className="overflow-x-auto rounded-xl border border-surface-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"><table className="w-full border-collapse text-xs"><caption className="sr-only">Illustrative regular and overtime hours for each day</caption><thead className="bg-surface-inset"><tr>{dates.map((day,i)=><th scope="col" key={day} className="min-w-32 p-3 text-left text-navy">{labels[i]}<span className="block font-normal text-ink-secondary">{day}</span></th>)}</tr></thead><tbody><tr>{dates.map((day,i)=><td key={day} className="space-y-2 border-t border-surface-border p-2"><label className="block text-ink-secondary">Regular hours<input aria-label={`${labels[i]} regular hours`} className={`${inputClass} mt-1`} inputMode="decimal" value={days[i].regular} onChange={e=>setHours(i,'regular',e.target.value)} placeholder="—" /></label><label className="block text-ink-secondary">Overtime hours<input aria-label={`${labels[i]} overtime hours`} className={`${inputClass} mt-1`} inputMode="decimal" value={days[i].overtime} onChange={e=>setHours(i,'overtime',e.target.value)} placeholder="—" /></label></td>)}</tr></tbody></table></div>}
    {result.error&&<p role="alert" className="text-sm text-status-danger">{result.error}</p>}
    {row&&<div aria-live="polite" className="rounded-xl bg-surface-inset p-4 text-sm"><p className="font-semibold text-navy">Illustrative result · {result.result?.period.start} to {result.result?.period.end}</p>{row.wage===null?<p className="mt-2 text-ink-secondary">Enter a rate and at least one worked day to see an estimate.</p>:<div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-ink-secondary"><span>Wages ₱{row.wage}</span><span>Allowance ₱{row.allowance}</span><span>Gross ₱{row.gross}</span><span>Bale ₱{row.bale}</span><strong className="text-navy">{row.net===null?'Net withheld — review':`Illustrative net ₱${row.net}`}</strong></div>}{row.excess&&<p className="mt-2 text-status-warning">Bale exceeds estimated earnings; review before any release.</p>}{row.pastUnmarked&&<p className="mt-2 text-ink-secondary">Unmarked days remain unmarked; this may be an incomplete week.</p>}</div>}
    <button type="button" onClick={()=>{setRate('');setAllowance('');setBale('');setDays(blankDays());}} className="rounded-lg border border-surface-border px-3 py-2 text-sm font-semibold text-navy hover:bg-surface-inset">Clear example</button>
   </section>
   <section className="rounded-2xl border border-surface-border bg-white p-4 text-sm text-ink-secondary sm:p-5"><h2 className="font-semibold text-navy">Actions shown for layout only</h2><p className="mt-1">These are disabled here. The real workflow will require a compatible database and separate review and confirmation.</p><div className="mt-3 flex flex-wrap gap-2">{['Review Bale release','Create payroll draft','Approve draft','Record external payment'].map(label=><button key={label} type="button" disabled className="rounded-lg border border-surface-border px-3 py-2 text-xs font-semibold opacity-50">{label}</button>)}</div></section>
  </div>
 </AppShell>;
}
