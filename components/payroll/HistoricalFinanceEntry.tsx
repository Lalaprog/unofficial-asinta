'use client';
import React,{useEffect,useRef,useState} from 'react';
import {Button} from '@/components/ui/Button';
import {Input} from '@/components/ui/Input';
import {Select} from '@/components/ui/Select';
import {useDataStore} from '@/lib/data/store';
import {createClient} from '@/lib/supabase/client';
import {getManilaClock} from '@/lib/reminders/scheduler';
import type {PaidReviewVoucher} from '@/lib/payroll/paidReview';
import type {HistoricalEvidence} from '@/lib/payroll/historicalEvidence';
import {historicalArguments,isSundayWeek,parseHistoricalAttempt,parseHistoricalSnapshot,snapshotMatchesVoucher,verifyHistoricalResult,type HistoricalAttempt,type HistoricalSnapshot} from '@/lib/payroll/historicalEntry';

/** Uninstalled experimental evidence writers; never transfer or change balances. */
export function HistoricalFinanceEntry({userId,voucher,evidence,onRecorded}:{userId:string;voucher:PaidReviewVoucher;evidence:HistoricalEvidence|null;onRecorded:()=>void}){
 const {projects,isLoaded,loadError}=useDataStore();
 const storageKey=JSON.stringify(['historical-evidence-v1',userId,voucher.id]);
 const [ready,setReady]=useState(false),[storageError,setStorageError]=useState(false),[pending,setPending]=useState<HistoricalAttempt|null>(null);
 const [kind,setKind]=useState<'date'|'bale'|null>(null),[day,setDay]=useState(''),[note,setNote]=useState(''),[project,setProject]=useState(''),[ack,setAck]=useState(false),[stop,setStop]=useState(false);
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
 const lock=useRef(false),alive=useRef(false);
 useEffect(()=>{alive.current=true;setReady(false);setPending(null);setStorageError(false);try{const saved=sessionStorage.getItem(storageKey);if(saved)setPending(parseHistoricalAttempt(JSON.parse(saved),voucher));}catch{setStorageError(true);}setReady(true);return()=>{alive.current=false;};},[storageKey,voucher]);
 useEffect(()=>{setKind(null);setAck(false);setDay('');setNote('');setProject('');},[evidence]);
 let snapshot:HistoricalSnapshot|null=null;
 try{if(evidence){const s=parseHistoricalSnapshot(evidence.voucher_snapshot);if(snapshotMatchesVoucher(s,voucher))snapshot=s;}}catch{/* Withhold writers if the snapshot is missing or malformed. */}
 const dateAvailable=!!snapshot&&!!evidence&&!evidence.date_evidence&&!evidence.recorded_payment_date&&!evidence.payment_conflict;
 const baleAvailable=!!snapshot&&!!evidence&&!evidence.bale_evidence&&!evidence.payment_conflict&&!!(evidence.date_evidence||evidence.recorded_payment_date)&&(!evidence.date_evidence||evidence.date_evidence.matches_voucher)&&isSundayWeek(snapshot.period_start,snapshot.period_end)&&Number(snapshot.bale_deduction)>0;
 function open(next:'date'|'bale'){setKind(next);setDay('');setNote('');setProject('');setAck(false);setError('');setMessage('');}
 async function send(a:HistoricalAttempt){
  if(lock.current||storageError)return;lock.current=true;setBusy(true);setError('');setMessage('');let stored=false;
  try{
   const existing=sessionStorage.getItem(storageKey);
   if(existing&&JSON.stringify(parseHistoricalAttempt(JSON.parse(existing),voucher))!==JSON.stringify(a))throw Error('Retry record changed');
   if(!existing)sessionStorage.setItem(storageKey,JSON.stringify(a));
   if(JSON.stringify(parseHistoricalAttempt(JSON.parse(sessionStorage.getItem(storageKey)||'null'),voucher))!==JSON.stringify(a))throw Error('Retry record unavailable');
   stored=true;if(alive.current){setPending(a);setKind(null);}
   const {data,error:rpcError}=await createClient().rpc(a.kind==='date'?'annotate_historical_paid_date':'record_historical_settled_bale',historicalArguments(a));if(rpcError)throw rpcError;verifyHistoricalResult(data,a);
   const saved=sessionStorage.getItem(storageKey);if(!saved||JSON.stringify(parseHistoricalAttempt(JSON.parse(saved),voucher))!==JSON.stringify(a))throw Error('Retry record changed');
   sessionStorage.removeItem(storageKey);
   if(alive.current){setPending(null);setMessage('Evidence assertion saved. No payment, Bale deduction or transfer was made. Reload evidence and independently check original records.');onRecorded();}
  }catch{if(alive.current){setError(stored?'Outcome not verified. It may already be saved; investigate or retry exactly the same request.':'Retry storage could not be verified; no request was sent. Investigate saved data before proceeding.');if(!stored)setStorageError(true);}}
  finally{lock.current=false;if(alive.current)setBusy(false);}
 }
 function prepare(){
  if(!kind||!ack||!snapshot||pending||storageError||busy||!evidence)return;
  try{
   if(kind==='date'&&!dateAvailable||kind==='bale'&&(!baleAvailable||!projects.some(p=>p.id===project)))throw Error('Unavailable');
   const today=getManilaClock().dateIso;
   if(!day||day>today||kind==='bale'&&day>(evidence.date_evidence?.payment_date||evidence.recorded_payment_date||''))throw Error('Invalid date');
   const a=parseHistoricalAttempt({kind,request:crypto.randomUUID(),snapshot,date:day,note:note.trim(),project:kind==='bale'?project:null},voucher);void send(a);
  }catch{setError('Check the date, project, note and reviewed voucher before saving.');}
 }
 function stopRetry(){try{sessionStorage.removeItem(storageKey);setPending(null);setStorageError(false);setStop(false);setKind(null);setMessage('Retry stopped. This does not cancel or undo a request. Investigate before any new entry.');onRecorded();}catch{setError('Could not clear retry data; no new request is available.');}}
 return <section className="space-y-2 rounded-lg border border-status-warning/25 bg-status-warning-bg p-3">
  <p className="font-semibold">Experimental historical evidence entry</p><p>Only for an already paid voucher and an external payment or Bale release that actually happened. This saves an immutable human assertion, not a payment, Bale transaction, balance change or proof. Verify original records and duplicates first; corrections are not yet supported. Retry details are stored in this browser tab and can be lost if storage is cleared.</p>
  {error&&<p role="alert">{error}</p>}{message&&<p role="status">{message}</p>}
  {(pending||storageError)&&<div className="space-y-2"><p>A previous request may have been sent. Closing this tab or clearing browser storage can lose the retry record; absence is not proof of failure.</p>
   {pending&&<><p className="break-all">{pending.kind==='date'?'Payment-date':'Settled Bale'} request {pending.request} · voucher {pending.snapshot.id} · date {pending.date}{pending.project&&` · project ${pending.project}`}.</p><p className="break-words">Evidence note: {pending.note}</p><Button type="button" size="sm" variant="secondary" disabled={busy} onClick={()=>void send(pending)}>Retry exact evidence request</Button></>}
   <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={()=>setStop(v=>!v)}>Review stopping evidence retry</Button>{stop&&<div><p>Stopping does not cancel or undo an in-flight request. Independently investigate before proceeding.</p><Button type="button" size="sm" variant="danger" disabled={busy} onClick={stopRetry}>I investigated; stop evidence retry</Button></div>}
  </div>}
  {ready&&!pending&&!storageError&&<>{!snapshot&&<p>Load historical evidence and refresh the voucher summary before entry. Entry is withheld if their snapshots differ or are invalid.</p>}
   {snapshot&&<div className="flex flex-wrap gap-2">{dateAvailable&&<Button type="button" size="sm" variant="secondary" disabled={busy} onClick={()=>open('date')}>Review historical payment-date assertion</Button>}{baleAvailable&&<Button type="button" size="sm" variant="secondary" disabled={busy} onClick={()=>open('bale')}>Review settled Bale assertion</Button>}</div>}
   {kind&&snapshot&&<div className="space-y-2 border-t border-status-warning/25 pt-2"><p>Worker {voucher.worker_name||voucher.worker_id} · {snapshot.period_start} to {snapshot.period_end} · gross ₱{snapshot.gross_pay} · Bale ₱{snapshot.bale_deduction} · other ₱{snapshot.other_deductions} · net ₱{snapshot.net_pay}.</p>
    {kind==='date'?<p>Enter the date the external payment actually happened. No money will be sent or voucher modified.</p>:<><p>Only one already released Bale, fully deducted in this paid voucher, is supported. No advance or expense will be created. Check the project, payment date and all other records manually.</p><Select label="Project for historical Bale" value={project} onChange={e=>setProject(e.target.value)} disabled={!isLoaded||!!loadError} options={[{label:!isLoaded?'Loading projects…':loadError?'Projects unavailable':'Choose project',value:''},...projects.map(p=>({label:`${p.name} · ${p.id}`,value:p.id}))]}/><p>Project names are current, not historical. Missing projects require separate review.</p></>}
    <Input label={kind==='date'?'Actual external payment date':'Actual external Bale release date'} type="date" min={snapshot.period_start} max={kind==='date'?getManilaClock().dateIso:snapshot.period_end} value={day} onChange={e=>setDay(e.target.value)}/><Input label="Source evidence note" maxLength={500} value={note} onChange={e=>setNote(e.target.value)}/>
    <label className="flex items-start gap-2"><input type="checkbox" checked={ack} onChange={e=>setAck(e.target.checked)}/> I checked the original records, worker, voucher, date and possible duplicates. This external {kind==='date'?'payment':'Bale release and full deduction'} already happened.</label>
    <div className="flex flex-wrap gap-2"><Button type="button" size="sm" variant="secondary" disabled={busy} onClick={()=>setKind(null)}>Cancel</Button><Button type="button" size="sm" disabled={busy||!ack||!day||!note.trim()||kind==='bale'&&!project} onClick={prepare}>Save historical assertion</Button></div>
   </div>}
  </>}
 </section>;
}
