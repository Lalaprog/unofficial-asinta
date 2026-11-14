'use client';

import React, {useEffect,useRef,useState} from 'react';
import {ChevronDown} from 'lucide-react';
import {Button} from '@/components/ui/Button';
import {Input} from '@/components/ui/Input';
import {useAuth} from '@/lib/auth/authContext';
import {createClient} from '@/lib/supabase/client';
import {getManilaClock} from '@/lib/reminders/scheduler';
import {parsePaidReview,paidReviewSignals,validReviewRange,type PaidReview} from '@/lib/payroll/paidReview';
import {historicalFinanceEvidencePreviewEnabled,paidAdjustmentsPreviewEnabled,paidAttendanceReviewPreviewEnabled} from '@/lib/finance/featureAvailability';
import {PaidAttendanceReview} from './PaidAttendanceReview';
import {PaidAdjustmentPanel} from './PaidAdjustmentPanel';
import {HistoricalFinanceEvidence} from './HistoricalFinanceEvidence';

type State={key:string;loading:boolean;error:string;data:PaidReview|null};
const empty=(key:string):State=>({key,loading:false,error:'',data:null});
export function PaidHistoryReview(){
 const [open,setOpen]=useState(false);
 return <section className="overflow-hidden rounded-2xl border border-surface-border bg-white">
  <button type="button" aria-expanded={open} onClick={()=>setOpen(v=>!v)} className="flex min-h-11 w-full items-center justify-between gap-3 p-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand sm:p-5">
   <span><span className="block text-sm font-semibold text-navy">Paid payroll history review</span><span className="mt-1 block text-xs text-ink-secondary">Read-only signals for Founder investigation</span></span><ChevronDown aria-hidden="true" className={`h-4 w-4 shrink-0 ${open?'rotate-180':''}`}/>
  </button>
  {open&&<Contents/>}
 </section>;
}
function Contents(){
 const {user,isFounder}=useAuth();
 const [end,setEnd]=useState(()=>getManilaClock().dateIso);
 const [start,setStart]=useState(()=>{const today=getManilaClock().dateIso;return new Date(Date.parse(`${today}T00:00:00Z`)-30*86400000).toISOString().slice(0,10);});
 const key=JSON.stringify([user?.id,isFounder,start,end]);
 const [state,setState]=useState<State>(()=>empty(key));
 const sequence=useRef(0),busy=useRef(false),currentKey=useRef(key);currentKey.current=key;
 useEffect(()=>{const seq=sequence,lock=busy;seq.current++;lock.current=false;setState(empty(key));return()=>{seq.current++;lock.current=false;};},[key]);
 const current=state.key===key?state:empty(key),valid=validReviewRange(start,end);
 async function load(){
  if(!user?.id||!isFounder||!valid||busy.current)return;
  const token=++sequence.current;busy.current=true;setState({...empty(key),loading:true});
  try{
   const {data,error}=await createClient().rpc('paid_payroll_review',{p_start:start,p_end:end});
   if(error)throw new Error(error.message);
   const parsed=parsePaidReview(data,start,end);
   if(token===sequence.current&&currentKey.current===key)setState({key,loading:false,error:'',data:parsed});
  }catch(e){if(token===sequence.current&&currentKey.current===key)setState({...empty(key),error:e instanceof Error?e.message:'Review unavailable'});}
  finally{if(token===sequence.current&&currentKey.current===key)busy.current=false;}
 }
 return <div className="space-y-4 border-t border-surface-border p-4 sm:p-5">
  <p className="rounded-xl border border-status-warning/25 bg-status-warning-bg p-3 text-xs leading-relaxed text-ink-secondary">This is a read-only review of vouchers recorded as paid, selected by their payroll period—not by actual payment date. It cannot establish whether money was paid or whether a correction is owed. A matching issued request is not proof of release, and a difference may reflect legacy rules. Check original records before any action; never pay or deduct again merely because a signal appears. Later corrections must be reviewed separately against their original period. No vouchers, Bale or payments change here.</p>
  <div className="flex flex-wrap items-end gap-3"><div className="w-full sm:w-44"><Input label="Review from" type="date" value={start} min="1900-01-01" max="9998-12-31" onChange={e=>setStart(e.target.value)}/></div><div className="w-full sm:w-44"><Input label="Review through" type="date" value={end} min="1900-01-01" max="9998-12-31" onChange={e=>setEnd(e.target.value)}/></div><Button type="button" variant="secondary" size="sm" onClick={load} isLoading={current.loading} disabled={!isFounder||!user?.id||!valid}>{current.data?'Refresh review':'Load paid history'}</Button></div>
  {!valid&&<p className="text-xs text-status-warning">Choose a valid range of at most 93 calendar days.</p>}
  {current.loading&&<p role="status" className="text-sm text-ink-secondary">Loading paid history…</p>}
  {current.error&&<p role="alert" className="text-sm text-status-danger">Could not load paid history: {current.error}</p>}
  {current.data&&(current.data.vouchers.length===0?<p className="text-sm text-ink-secondary">No paid vouchers were returned for periods overlapping these dates. This does not prove that no external payment occurred.</p>:<div className="space-y-3">
   <p className="text-xs text-ink-secondary">{current.data.vouchers.length} paid voucher(s) returned. Signals are not a complete audit; attendance changes, external payments, duplicate expenses, and older balances are not determined here.</p>
   {current.data.vouchers.map(v=>{const signals=paidReviewSignals(v);return <article key={v.id} className="rounded-xl border border-surface-border bg-surface-inset p-3 text-xs text-ink-secondary">
    <h3 className="break-words text-sm font-semibold text-navy">{v.worker_name||'Worker unavailable'} · {v.period_start} to {v.period_end}</h3>
    <p className="mt-1 break-all">Voucher ID: {v.id}</p>
    <p className="mt-1">Recorded net ₱{v.net_pay} · gross ₱{v.gross_pay} · other deductions ₱{v.other_deductions}</p>
    <p className="mt-1">Voucher Bale deduction ₱{v.bale_deduction} · non-cancelled Bale dated in period ₱{v.period_bale_total} ({v.period_bale_count} record(s)).</p>
    {signals.length?<ul className="mt-2 list-disc space-y-1 pl-4 font-semibold text-status-warning">{signals.map(s=><li key={s}>{s}</li>)}</ul>:<p className="mt-2">No selected signals found. This is not confirmation that the records or payment are correct.</p>}
    {paidAttendanceReviewPreviewEnabled()&&<PaidAttendanceReview voucher={v}/>}
    {historicalFinanceEvidencePreviewEnabled()&&<HistoricalFinanceEvidence voucher={v}/>}
    {paidAdjustmentsPreviewEnabled()&&<PaidAdjustmentPanel voucher={v}/>}
   </article>;})}
  </div>)}
 </div>;
}
