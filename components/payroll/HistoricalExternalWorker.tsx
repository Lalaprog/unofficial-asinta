'use client';
import React,{useEffect,useRef,useState} from 'react';
import {Button} from '@/components/ui/Button';
import {Input} from '@/components/ui/Input';
import {Select} from '@/components/ui/Select';
import {Modal} from '@/components/ui/Modal';
import {paidPeriodAssertionCasesPreviewEnabled,historicalWorkerAttributionEntryPreviewEnabled,historicalAttributionCaseBindingPreviewEnabled} from '@/lib/finance/featureAvailability';
import {HistoricalWorkerAttribution} from './HistoricalWorkerAttribution';
import {snapshotFromExternal} from '@/lib/payroll/paidPeriodCases';
import {PaidPeriodAssertionCases} from './PaidPeriodAssertionCases';
import {useAuth} from '@/lib/auth/authContext';
import {createClient} from '@/lib/supabase/client';
import {getManilaClock} from '@/lib/reminders/scheduler';
import {externalArguments,externalRowMatchesAttempt,parseExternalAttempt,parseExternalCatalog,parseExternalList,parseExternalReview,type ExternalAttempt,type ExternalReview,type ExternalRow,type ExternalWorker} from '@/lib/payroll/historicalExternalWorker';

/** Assertion only. This never creates a voucher, advance, transfer or cost. */
export function HistoricalExternalWorker(){
 const {user,isFounder,assurance}=useAuth();const [open,setOpen]=useState(false);
 if(!user?.id||!isFounder||assurance!=='ready')return null;
 return <section className="rounded-2xl border border-surface-border bg-white p-4 text-xs sm:p-5"><button type="button" aria-expanded={open} onClick={()=>setOpen(v=>!v)} className="min-h-11 font-semibold text-navy">Experimental historical worker payroll evidence</button>{open&&<Contents key={`${user.id}:${assurance}`} userId={user.id}/>}</section>;
}
function Contents({userId}:{userId:string}){
 const storageKey=JSON.stringify(['historical-external-worker-v1',userId]);const alive=useRef(false),seq=useRef(0),busyRef=useRef(false),active=useRef(''),observed=useRef<{raw:string|null}|null>(null),stopSnapshot=useRef<{raw:string|null}|null>(null);
 const [ready,setReady]=useState(false),[storageError,setStorageError]=useState(false),[pending,setPending]=useState<ExternalAttempt|null>(null);
 const [catalog,setCatalog]=useState<ExternalWorker[]|null>(null),[workerId,setWorkerId]=useState(''),[start,setStart]=useState('');
 const [reviewState,setReviewState]=useState<{key:string;review:ExternalReview;list:{total:number;items:ExternalRow[]}}|null>(null);
 const [paidOn,setPaidOn]=useState(''),[gross,setGross]=useState(''),[bale,setBale]=useState('0'),[other,setOther]=useState('0'),[net,setNet]=useState(''),[note,setNote]=useState('');
 const [confirmation,setConfirmation]=useState<ExternalAttempt|null>(null),[ack,setAck]=useState(false),[stop,setStop]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
 const worker=catalog?.find(w=>w.id===workerId),key=JSON.stringify([userId,workerId,start]);active.current=key;const current=reviewState?.key===key?reviewState:null;
 useEffect(()=>{const sequence=seq;alive.current=true;try{const raw=sessionStorage.getItem(storageKey);observed.current={raw};if(raw)setPending(parseExternalAttempt(JSON.parse(raw),userId));}catch{setStorageError(true);}setReady(true);return()=>{alive.current=false;sequence.current++;};},[storageKey,userId]);
 async function catalogLoad(){
  if(busyRef.current)return;busyRef.current=true;setBusy(true);setError('');const token=++seq.current;
  try{const {data,error}=await createClient().rpc('historical_external_worker_catalog');if(error)throw error;const c=parseExternalCatalog(data);if(alive.current&&token===seq.current){setCatalog(c);setWorkerId('');setReviewState(null);}}
  catch{if(alive.current&&token===seq.current)setError('Could not verify the worker catalog. No worker list is assumed.');}
  finally{busyRef.current=false;if(alive.current&&token===seq.current)setBusy(false);}
 }
 async function loadReview(){
  if(!worker||!start||busyRef.current)return;busyRef.current=true;setBusy(true);setError('');setReviewState(null);const token=++seq.current,requestKey=key;
  try{
   const [a,b]=await Promise.all([createClient().rpc('historical_external_worker_review',{p_worker:worker.id,p_start:start}),createClient().rpc('historical_external_worker_list',{p_worker:worker.id,p_offset:0})]);
   if(a.error||b.error)throw Error('Review unavailable');const review=parseExternalReview(a.data,worker,start),list=parseExternalList(b.data,worker.id);
   if(alive.current&&token===seq.current&&active.current===requestKey)setReviewState({key:requestKey,review,list});
  }catch{if(alive.current&&token===seq.current&&active.current===requestKey)setError('Could not verify the worker, week and existing evidence. Refresh and investigate.');}
  finally{busyRef.current=false;if(alive.current&&token===seq.current)setBusy(false);}
 }
 function prepare(){
  if(!current||!worker||pending||storageError||busyRef.current)return;setError('');
  try{
   const r=current.review;if(r.possible_supervisor||r.possible_worker_duplicate||r.supervisor_periods||r.overlapping_vouchers||r.period_advances||r.older_open_advances||r.existing_assertions)throw Error('Conflicts');
   if(r.as_of!==getManilaClock().dateIso||paidOn>r.as_of)throw Error('Date');
   const a=parseExternalAttempt({request:crypto.randomUUID(),actor:userId,worker:r.worker,start,paid_on:paidOn,gross,bale,other,net,note:note.trim()},userId);setAck(false);setConfirmation(a);
  }catch{setError('Check identity, overlapping records, Philippine date and all amounts before continuing. Gross must equal Bale plus other deductions plus net.');}
 }
 async function send(a:ExternalAttempt,retry=false){
  if(busyRef.current||storageError)return;busyRef.current=true;setBusy(true);setError('');setMessage('');let stored=false;const token=++seq.current;
  try{
   const old=sessionStorage.getItem(storageKey);if((retry&&!old)||(old&&JSON.stringify(parseExternalAttempt(JSON.parse(old),userId))!==JSON.stringify(a)))throw Error('Retry differs');
   if(!old)sessionStorage.setItem(storageKey,JSON.stringify(a));const copy=sessionStorage.getItem(storageKey);if(!copy||JSON.stringify(parseExternalAttempt(JSON.parse(copy),userId))!==JSON.stringify(a))throw Error('Retry storage unavailable');
   stored=true;observed.current={raw:copy};if(alive.current&&token===seq.current){setPending(a);setConfirmation(null);}
   const {data,error}=await createClient().rpc('record_historical_external_worker_payroll',externalArguments(a));if(error)throw error;
   if(!data||data.request_id!==a.request||typeof data.replayed!=='boolean')throw Error('Unverified response');
   if(!alive.current||token!==seq.current)return;const saved=sessionStorage.getItem(storageKey);if(!saved||JSON.stringify(parseExternalAttempt(JSON.parse(saved),userId))!==JSON.stringify(a))throw Error('Retry changed');sessionStorage.removeItem(storageKey);observed.current={raw:null};
   if(alive.current){setPending(null);setReviewState(null);setMessage('Historical assertion saved. No voucher, advance, transfer or project cost was created. Reload and inspect.');}
  }catch{if(alive.current){setError(stored?'Outcome not verified. It may already be recorded; inspect or retry exactly.':'Retry storage could not be verified; no request was sent this time. An earlier request may still complete.');if(!stored)setStorageError(true);}}
  finally{busyRef.current=false;if(alive.current)setBusy(false);}
 }
 async function inspect(){
  if(!pending||busyRef.current)return;busyRef.current=true;setBusy(true);setError('');const token=++seq.current;
  try{const {data,error}=await createClient().rpc('historical_external_worker_lookup',{p_request:pending.request});if(error)throw error;
   if(data===null){if(alive.current)setMessage('No matching assertion is visible yet. A request may still be in flight; this is not proof of failure.');return;}
   const item=parseExternalList({total:1,offset:0,items:[data]},pending.worker.id).items[0];if(!externalRowMatchesAttempt(item,pending))throw Error('Mismatch');
   if(!alive.current||token!==seq.current)return;const saved=sessionStorage.getItem(storageKey);if(!saved||JSON.stringify(parseExternalAttempt(JSON.parse(saved),userId))!==JSON.stringify(pending))throw Error('Retry changed');sessionStorage.removeItem(storageKey);observed.current={raw:null};
   if(alive.current){setPending(null);setReviewState(null);setMessage('Matching assertion verified. No payment or transaction was made by this application. Reload history.');}
  }catch{if(alive.current)setError('Could not verify the exact request. Investigate before another entry.');}
  finally{busyRef.current=false;if(alive.current)setBusy(false);}
 }
 function reviewStop(){try{const raw=sessionStorage.getItem(storageKey);if(!observed.current||raw!==observed.current.raw)throw Error('Retry changed');if(pending&&(!raw||JSON.stringify(parseExternalAttempt(JSON.parse(raw),userId))!==JSON.stringify(pending)))throw Error('Retry changed');stopSnapshot.current={raw};setStop(true);setError('');}catch{setStop(false);setError('Retry data changed or could not be read. Nothing was cleared; investigate before continuing.');}}
 function stopRetry(){try{if(!stopSnapshot.current||!observed.current||sessionStorage.getItem(storageKey)!==stopSnapshot.current.raw||observed.current.raw!==stopSnapshot.current.raw)throw Error('Retry changed');if(pending&&(!stopSnapshot.current.raw||JSON.stringify(parseExternalAttempt(JSON.parse(stopSnapshot.current.raw),userId))!==JSON.stringify(pending)))throw Error('Retry changed');sessionStorage.removeItem(storageKey);observed.current={raw:null};stopSnapshot.current=null;setPending(null);setStorageError(false);setStop(false);setReviewState(null);setMessage('Retry stopped; this does not cancel a request. Independently investigate before another entry.');}catch{stopSnapshot.current=null;setStop(false);setError('Retry data changed or could not be read. Nothing was cleared; investigate before continuing.');}}
 return <div className="space-y-3 border-t border-surface-border pt-3 text-ink-secondary">
  <p className="rounded-xl bg-status-warning-bg p-3">Only for a worker week already paid externally with no existing voucher. This saves a human assertion, not proof, a payslip, a voucher, an advance, a transfer or a project cost. Verify the person, ledger, payment and Bale independently. It cannot be edited or reversed in this draft; a mistake can block new records for the week. Do not use in live finance.</p>
  {error&&<p role="alert">{error}</p>}{message&&<p role="status">{message}</p>}
  {(pending||storageError)&&<div className="space-y-2"><p>A request may still complete. Closing the tab or clearing storage can lose retry details; that does not cancel the request.</p>{pending&&<><p className="break-words">Worker {pending.worker.name} · {pending.start} · external payment {pending.paid_on} · gross ₱{pending.gross} · Bale ₱{pending.bale} · other ₱{pending.other} · net ₱{pending.net}.</p><p className="break-all">Request {pending.request} · {pending.note}</p><div className="flex flex-wrap gap-2"><Button type="button" variant="secondary" size="sm" disabled={busy} onClick={inspect}>Check exact request</Button><Button type="button" variant="secondary" size="sm" disabled={busy} onClick={()=>void send(pending,true)}>Retry exact request</Button></div></>}
   <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={reviewStop}>Review stopping retry</Button>{stop&&<div><p>Stopping does not cancel or undo a request. Investigate before entering again.</p><Button type="button" variant="danger" size="sm" disabled={busy} onClick={stopRetry}>I investigated; stop retry</Button></div>}</div>}
  {ready&&!pending&&!storageError&&<><Button type="button" variant="secondary" size="sm" disabled={busy} onClick={catalogLoad}>{catalog?'Reload workers':'Load workers'}</Button>
   {catalog&&<><div className="grid gap-3 sm:grid-cols-2"><Select label="Worker for historical evidence" value={workerId} disabled={busy} onChange={e=>{setWorkerId(e.target.value);setReviewState(null);setConfirmation(null);}}><option value="">Choose worker</option>{catalog.map(w=><option key={w.id} value={w.id}>{w.name} · {w.position} · {w.active?'active':'archived'} · {w.id}</option>)}</Select><Input label="Sunday of paid week" type="date" min="1900-01-01" max="9998-12-24" value={start} disabled={busy} onChange={e=>{setStart(e.target.value);setReviewState(null);setConfirmation(null);}}/></div>
    <Button type="button" variant="secondary" size="sm" disabled={busy||!worker||!start} onClick={loadReview}>Review week and existing evidence</Button></>}
   {current&&<><p>Reviewed worker: {current.review.worker.name} · {current.review.worker.position} · {current.review.worker.id}. Week {current.review.start} to {current.review.end}. Server Philippine date {current.review.as_of}.</p>
    <p>Possible Supervisor: {current.review.possible_supervisor?'yes':'no'} · possible duplicate worker: {current.review.possible_worker_duplicate?'yes':'no'} · possible Supervisor ledger periods: {current.review.supervisor_periods} · overlapping vouchers: {current.review.overlapping_vouchers} · period Bale records: {current.review.period_advances} · older open Bale: {current.review.older_open_advances} · matching assertions: {current.review.existing_assertions}. These checks can miss real-world payments or identity issues.</p>
    <p>Latest {current.list.items.length} of {current.list.total} assertions for this worker; this list is not proof of all payments.</p>{current.list.total>100&&<p className="font-semibold text-status-warning">Only the latest 100 are shown; further history needs separate review.</p>}
    {current.list.items.map(r=><div key={r.request_id}><p className="break-words">{r.period_start}–{r.period_end} · paid {r.paid_on} · gross ₱{r.gross} · Bale ₱{r.bale} · other ₱{r.other_deductions} · net ₱{r.net} · {r.evidence_note}</p>{paidPeriodAssertionCasesPreviewEnabled()&&<PaidPeriodAssertionCases key={JSON.stringify([userId,snapshotFromExternal(r)])} actor={userId} snapshot={snapshotFromExternal(r)}/>} {historicalWorkerAttributionEntryPreviewEnabled()&&<HistoricalWorkerAttribution key={JSON.stringify([userId,r])} actor={userId} source={r} caseBinding={historicalAttributionCaseBindingPreviewEnabled()}/>}</div>)}
    {(current.review.possible_supervisor||current.review.possible_worker_duplicate||current.review.supervisor_periods>0||current.review.overlapping_vouchers>0||current.review.period_advances>0||current.review.older_open_advances>0||current.review.existing_assertions>0)?<p className="font-semibold text-status-warning">Existing records or identity risk require separate reconciliation. Entry is blocked.</p>:<><div className="grid gap-3 sm:grid-cols-2"><Input label="Actual external payment date" type="date" value={paidOn} onChange={e=>setPaidOn(e.target.value)}/><Input label="Gross paid-period earnings (₱)" value={gross} inputMode="decimal" onChange={e=>setGross(e.target.value)}/><Input label="Bale already deducted (₱)" value={bale} inputMode="decimal" onChange={e=>setBale(e.target.value)}/><Input label="Other deductions (₱)" value={other} inputMode="decimal" onChange={e=>setOther(e.target.value)}/><Input label="Net already paid (₱)" value={net} inputMode="decimal" onChange={e=>setNet(e.target.value)}/><Input label="Original evidence note" value={note} maxLength={500} onChange={e=>setNote(e.target.value)}/></div><Button type="button" size="sm" disabled={busy} onClick={prepare}>Review external assertion</Button></>}
   </>}
  </>}
  <Modal isOpen={!!confirmation} title="Record historical assertion?" description="No money or Bale transaction will be created." onClose={()=>setConfirmation(null)} dismissOnBackdrop={!busy} dismissOnEscape={!busy} showCloseButton={!busy}>
   {confirmation&&<div className="space-y-3 text-xs text-ink-secondary"><p>{confirmation.worker.name} · {confirmation.start} · paid {confirmation.paid_on} · gross ₱{confirmation.gross} · Bale ₱{confirmation.bale} · other ₱{confirmation.other} · net ₱{confirmation.net}.</p><p>Evidence: {confirmation.note}. The assertion cannot currently be edited or reversed.</p><label className="flex items-start gap-2"><input type="checkbox" checked={ack} onChange={e=>setAck(e.target.checked)}/>I verified the original external payment, any Bale deduction, identity and possible duplicates. No new payment should occur.</label><div className="flex flex-wrap justify-end gap-2"><Button type="button" variant="secondary" disabled={busy} onClick={()=>setConfirmation(null)}>Cancel</Button><Button type="button" disabled={busy||!ack} isLoading={busy} onClick={()=>{if(ack&&getManilaClock().dateIso===current?.review.as_of)void send(confirmation);else {setConfirmation(null);setReviewState(null);setError('Philippine date changed; reload and review.');}}}>Record assertion</Button></div></div>}
  </Modal>
 </div>;
}
