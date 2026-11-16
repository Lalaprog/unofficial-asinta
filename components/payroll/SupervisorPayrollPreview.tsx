'use client';
import React,{useEffect,useRef,useState} from 'react';
import {ChevronDown} from 'lucide-react';
import {Button} from '@/components/ui/Button';
import {Input} from '@/components/ui/Input';
import {Select} from '@/components/ui/Select';
import {useAuth} from '@/lib/auth/authContext';
import {createClient} from '@/lib/supabase/client';
import {getManilaClock} from '@/lib/reminders/scheduler';
import {useManilaToday} from '@/lib/dates/useManilaToday';
import {SUPERVISOR_DAY_CHANGED} from '@/lib/attendance/supervisorDayEvents';
import {SUPERVISOR_LEAVE_CHANGED} from '@/lib/attendance/usePendingSupervisorLeave';
import {supervisorPayrollPeriod} from '@/lib/payroll/periods';
import {buildSupervisorPreview,parseSupervisorCatalog,parseSupervisorPreview,type SupervisorOption,type SupervisorPreviewInput} from '@/lib/payroll/supervisorPreview';

type Load<T>={key:string;value:T|null;loading:boolean;error:string};
const empty=<T,>(key:string):Load<T>=>({key,value:null,loading:false,error:''});
export function SupervisorPayrollPreview(){
 const [open,setOpen]=useState(false);
 return <section className="overflow-hidden rounded-2xl border border-surface-border bg-white"><button type="button" aria-expanded={open} onClick={()=>setOpen(v=>!v)} className="flex min-h-11 w-full items-center justify-between gap-3 p-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand sm:p-5"><span><span className="block text-sm font-semibold text-navy">Supervisor payroll planning preview</span><span className="mt-1 block text-xs text-ink-secondary">1–15 / 16–month-end · illustrative only</span></span><ChevronDown aria-hidden="true" className={`h-4 w-4 shrink-0 ${open?'rotate-180':''}`}/></button>{open&&<Contents/>}</section>;
}
function Contents(){
 const {user,isFounder,assurance}=useAuth();const today=useManilaToday();
 const [date,setDate]=useState(()=>getManilaClock().dateIso),[selected,setSelected]=useState(''),[rate,setRate]=useState('');
 const [catalog,setCatalog]=useState<Load<SupervisorOption[]>>(()=>empty('')),[input,setInput]=useState<Load<SupervisorPreviewInput>>(()=>empty(''));
 let period:ReturnType<typeof supervisorPayrollPeriod>|null=null;try{period=supervisorPayrollPeriod(date);}catch{/* input may be incomplete */}
 const start=period?.start||'',accountKey=JSON.stringify([user?.id,isFounder,assurance]),key=JSON.stringify([accountKey,selected,start,today]);
 const catalogSeq=useRef(0),inputSeq=useRef(0),activeAccount=useRef(accountKey),activeKey=useRef(key),catalogBusy=useRef(false),inputBusy=useRef(false);
 activeAccount.current=accountKey;activeKey.current=key;
 useEffect(()=>{const seq=catalogSeq,lock=catalogBusy;seq.current++;lock.current=false;setCatalog(empty(accountKey));setSelected('');setRate('');return()=>{seq.current++;lock.current=false;};},[accountKey]);
 useEffect(()=>{const seq=inputSeq,lock=inputBusy;seq.current++;lock.current=false;setInput(empty(key));return()=>{seq.current++;lock.current=false;};},[key]);
 useEffect(()=>{
  const invalidate=()=>{inputSeq.current++;inputBusy.current=false;setInput(previous=>previous.key===key&&(previous.value||previous.loading)?{...empty(key),error:'Supervisor attendance or leave may have changed in this tab. Reload the period.'}:previous);};
  window.addEventListener(SUPERVISOR_DAY_CHANGED,invalidate);window.addEventListener(SUPERVISOR_LEAVE_CHANGED,invalidate);
  return()=>{window.removeEventListener(SUPERVISOR_DAY_CHANGED,invalidate);window.removeEventListener(SUPERVISOR_LEAVE_CHANGED,invalidate);};
 },[key]);
 const c=catalog.key===accountKey?catalog:empty<SupervisorOption[]>(accountKey),i=input.key===key?input:empty<SupervisorPreviewInput>(key);
 async function loadCatalog(){
  if(!isFounder||!user?.id||assurance!=='ready'||catalogBusy.current)return;const seq=++catalogSeq.current;catalogBusy.current=true;setCatalog({...empty(accountKey),loading:true});setSelected('');setRate('');
  try{const {data,error}=await createClient().rpc('supervisor_payroll_preview_catalog');if(error)throw new Error(error.message);const options=parseSupervisorCatalog(data);if(seq===catalogSeq.current&&activeAccount.current===accountKey)setCatalog({key:accountKey,value:options,loading:false,error:''});}
  catch(e){if(seq===catalogSeq.current&&activeAccount.current===accountKey)setCatalog({...empty(accountKey),error:e instanceof Error?e.message:'Catalog unavailable'});}
  finally{if(seq===catalogSeq.current&&activeAccount.current===accountKey)catalogBusy.current=false;}
 }
 async function loadInput(){
  if(!isFounder||!user?.id||assurance!=='ready'||!selected||!start||inputBusy.current)return;
  if(getManilaClock().dateIso!==today){setInput({...empty(key),error:'Philippine date changed. Wait for refresh, then reload the period.'});return;}
  const seq=++inputSeq.current;inputBusy.current=true;setInput({...empty(key),loading:true});
  try{const {data,error}=await createClient().rpc('supervisor_payroll_preview_inputs',{p_supervisor:selected,p_start:start});if(error)throw new Error(error.message);if(getManilaClock().dateIso!==today)throw new Error('Philippine date changed; reload the period');const value=parseSupervisorPreview(data,selected,start);if(seq===inputSeq.current&&activeKey.current===key)setInput({key,value,loading:false,error:''});}
  catch(e){if(seq===inputSeq.current&&activeKey.current===key)setInput({...empty(key),error:e instanceof Error?e.message:'Preview unavailable'});}
  finally{if(seq===inputSeq.current&&activeKey.current===key)inputBusy.current=false;}
 }
 const preview=i.value&&getManilaClock().dateIso===today?buildSupervisorPreview(i.value,rate,today):null;
 return <div className="space-y-4 border-t border-surface-border p-4 text-xs sm:p-5">
  <p className="rounded-xl border border-status-warning/25 bg-status-warning-bg p-3 leading-relaxed text-ink-secondary">Read-only planning aid, not a payroll run or payment. A manually entered daily rate is illustrative and is not saved or verified against a historical rate. Approved full days count once, half days count half, and approved leave is unpaid; multiple sites never multiply days. Gross is rounded once to centavos. No overtime, deductions, allowances, Bale, net pay or actual payment is calculated. Reconcile historical rates, identity, site-based records, external payments and all vouchers independently. Missing days are unmarked, not absent.</p>
  {assurance!=='ready'&&<p role="status">Founder session assurance must be ready before loading this preview.</p>}
  <Button type="button" variant="secondary" size="sm" onClick={loadCatalog} disabled={!isFounder||!user?.id||assurance!=='ready'||c.loading} isLoading={c.loading}>{c.value?'Reload Supervisors':'Load Supervisors'}</Button>
  {c.error&&<p role="alert">Could not load Supervisors: {c.error}</p>}
  {c.value&&<><p>Only accounts currently marked Supervisor are listed; historical or removed profiles may be missing.</p><div className="grid gap-3 sm:grid-cols-3"><Select label="Supervisor" value={selected} onChange={e=>{setSelected(e.target.value);setRate('');}}><option value="">Choose a Supervisor</option>{c.value.map(s=><option key={s.id} value={s.id}>{s.name} · {s.id}</option>)}</Select><Input label="Date in Supervisor period" type="date" min="1900-01-01" max="9998-12-31" value={date} onChange={e=>setDate(e.target.value)}/><Input label="Illustrative daily rate in pesos" inputMode="decimal" value={rate} onChange={e=>setRate(e.target.value)} hint="Manual, not saved"/></div>
   {period&&<p className="font-semibold text-navy">{period.start} to {period.end} · normally paid {period.plannedRelease}</p>}
   <Button type="button" variant="secondary" size="sm" onClick={loadInput} disabled={!selected||!start||i.loading} isLoading={i.loading}>{i.value?'Refresh period':'Load period'}</Button></>}
  {i.error&&<p role="alert">Could not load period: {i.error}</p>}
  {i.value&&getManilaClock().dateIso!==today&&<p role="status">Philippine date changed. Wait for refresh, then reload the period.</p>}
  {preview&&<><p>Snapshot as of the server’s Philippine date: {i.value?.as_of}. Reload after changes.</p><p className="font-semibold text-navy">{preview.gross===null?'Illustrative gross unavailable':`Illustrative gross: ₱${preview.gross}`} · {String(preview.halfDayUnits/2n)}{preview.halfDayUnits%2n?'.5':''} approved day equivalent(s)</p>
   {preview.known===0&&<p className="text-status-warning">No approved daily attendance or leave; no amount is inferred.</p>}
   {preview.unmarkedPast>0&&<p className="text-status-warning">{preview.unmarkedPast} past day(s) unmarked; they are not presumed absent or scheduled work. This partial estimate can change.</p>}
   {preview.reasons.map(reason=><p key={reason} className="font-semibold text-status-warning">{reason}</p>)}
   <div role="region" tabIndex={0} aria-label="Supervisor period days, scroll horizontally" className="max-w-full overflow-x-auto rounded-xl border border-surface-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"><table className="w-full text-left text-xs"><caption className="sr-only">Supervisor daily records and leave for the selected period</caption><thead><tr><th scope="col" className="p-2">Date</th><th scope="col" className="p-2">Record</th></tr></thead><tbody>{preview.days.map(day=><tr key={day.date} className="border-t border-surface-border"><th scope="row" className="p-2 font-medium">{day.date}</th><td className="p-2">{day.label}</td></tr>)}</tbody></table></div>
   <p>This is a loaded snapshot, not a live ledger. Same-tab attendance or leave actions clear it, but changes from other tabs, devices or privileged writers may not. Signals use UUID and names and can miss external payments or identity mismatches; they do not prove that no historical voucher or legacy record exists. Reload and independently verify before any payroll action.</p></>}
 </div>;
}
