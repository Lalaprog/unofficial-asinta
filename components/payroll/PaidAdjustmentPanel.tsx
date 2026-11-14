'use client';

import React,{useEffect,useRef,useState} from 'react';
import {Button} from '@/components/ui/Button';
import {Input} from '@/components/ui/Input';
import {Select} from '@/components/ui/Select';
import {Modal} from '@/components/ui/Modal';
import {useAuth} from '@/lib/auth/authContext';
import {projectCostCorrectionPreviewEnabled} from '@/lib/finance/featureAvailability';
import {ProjectCostCorrectionPanel} from './ProjectCostCorrectionPanel';
import {createClient} from '@/lib/supabase/client';
import {getManilaClock} from '@/lib/reminders/scheduler';
import {adjustmentAttemptArguments,parseAdjustmentAttempt,parseAdjustmentList,sameSnapshot,snapshotFromReview,validDifference,verifyAdjustmentAttempt,type AdjustmentAttempt,type AdjustmentList,type PaidAdjustment} from '@/lib/payroll/paidAdjustments';
import type {PaidReviewVoucher} from '@/lib/payroll/paidReview';

type State={key:string;list:AdjustmentList|null;loading:boolean;error:string};
type Confirm={kind:'open'}|{kind:'resolve';item:PaidAdjustment};
const empty=(key:string):State=>({key,list:null,loading:false,error:''});

/** Founder-entered case history; no transfer, deduction, voucher edit or future carryover. */
export function PaidAdjustmentPanel({voucher}:{voucher:PaidReviewVoucher}){
 const {user,isFounder,assurance}=useAuth();
 const snapshot=snapshotFromReview(voucher),key=JSON.stringify([user?.id,isFounder,assurance,snapshot]);
 const storageKey=JSON.stringify(['paid-adjustment-retry-v1',user?.id,voucher.id]);
 const [expanded,setExpanded]=useState(false),[state,setState]=useState<State>(()=>empty(key));
 const [difference,setDifference]=useState(''),[reason,setReason]=useState(''),[message,setMessage]=useState('');
 const [resolution,setResolution]=useState<'settled_external'|'no_transfer'>('settled_external'),[settledOn,setSettledOn]=useState(''),[note,setNote]=useState(''),[resolutionAck,setResolutionAck]=useState(false);
 const [confirm,setConfirm]=useState<Confirm|null>(null),[saving,setSaving]=useState(false);
 const [retryScope,setRetryScope]=useState(''),[retryReady,setRetryReady]=useState(false),[storageError,setStorageError]=useState(false),[pending,setPending]=useState<AdjustmentAttempt|null>(null),[stopping,setStopping]=useState(false);
 const seq=useRef(0),busy=useRef(false),active=useRef(key),observed=useRef<{raw:string|null}|null>(null),stopSnapshot=useRef<{raw:string|null}|null>(null);active.current=key;
 useEffect(()=>{const sequence=seq;sequence.current++;busy.current=false;observed.current=null;stopSnapshot.current=null;setExpanded(false);setState(empty(key));setDifference('');setReason('');setMessage('');setConfirm(null);setSaving(false);setResolution('settled_external');setSettledOn('');setNote('');setResolutionAck(false);setRetryReady(false);setRetryScope(key);setPending(null);setStorageError(false);setStopping(false);
  if(user?.id&&isFounder&&assurance==='ready'){try{const saved=sessionStorage.getItem(storageKey);observed.current={raw:saved};if(saved)setPending(parseAdjustmentAttempt(JSON.parse(saved),voucher));}catch{setStorageError(true);}setRetryReady(true);}
  return()=>{sequence.current++;};
 },[key,storageKey,user?.id,isFounder,assurance,voucher]);
 const current=state.key===key?state:empty(key),retryAvailable=retryScope===key&&retryReady,activePending=retryAvailable?pending:null,blocked=!retryAvailable||storageError||!!activePending;
 async function load(offset=0){
  if(!isFounder||!user?.id||assurance!=='ready'||busy.current)return;
  busy.current=true;const token=++seq.current;setState({...empty(key),loading:true});
  try{
   const {data,error}=await createClient().rpc('paid_payroll_adjustment_list',{p_payroll_id:voucher.id,p_offset:offset});
   if(error)throw new Error(error.message);
   const list=parseAdjustmentList(data,voucher.id,offset);
   if(token===seq.current&&active.current===key)setState({key,list,loading:false,error:''});
  }catch(e){if(token===seq.current&&active.current===key)setState({...empty(key),error:e instanceof Error?e.message:'History unavailable'});}
  finally{if(token===seq.current&&active.current===key)busy.current=false;}
 }
 function prepareOpen(event:React.FormEvent){
  event.preventDefault();if(!current.list||busy.current||!isFounder||assurance!=='ready'||blocked)return;
  if(!validDifference(difference)||!reason.trim()||reason.trim().length>500){setMessage('Enter a nonzero difference with at most two decimals and an explanation.');return;}
  setMessage('');setConfirm({kind:'open'});
 }
 function prepareResolution(item:PaidAdjustment){
  if(busy.current||blocked||assurance!=='ready'||item.status!=='pending'||!sameSnapshot(item.original_voucher,snapshot))return;
  setResolution('settled_external');setSettledOn('');setNote('');setResolutionAck(false);setMessage('');setConfirm({kind:'resolve',item});
 }
 async function send(a:AdjustmentAttempt,retry=false){
  if(busy.current||!user?.id||!isFounder||assurance!=='ready'||!retryAvailable||storageError)return;
  busy.current=true;setSaving(true);setMessage('');const token=++seq.current;let stored=false;
  try{
   const existing=sessionStorage.getItem(storageKey);
   if((retry&&!existing)||(existing&&JSON.stringify(parseAdjustmentAttempt(JSON.parse(existing),voucher))!==JSON.stringify(a)))throw Error('Retry record changed');
   if(!existing)sessionStorage.setItem(storageKey,JSON.stringify(a));
   const storedValue=sessionStorage.getItem(storageKey);if(!storedValue||JSON.stringify(parseAdjustmentAttempt(JSON.parse(storedValue),voucher))!==JSON.stringify(a))throw Error('Retry record unavailable');
   stored=true;observed.current={raw:storedValue};if(token===seq.current&&active.current===key){setPending(a);setConfirm(null);}
   const {data,error}=await createClient().rpc(a.kind==='open'?'open_paid_payroll_adjustment':'resolve_paid_payroll_adjustment',adjustmentAttemptArguments(a));
   if(error)throw error;verifyAdjustmentAttempt(data,a);
   if(token!==seq.current||active.current!==key)return;const saved=sessionStorage.getItem(storageKey);if(!saved||JSON.stringify(parseAdjustmentAttempt(JSON.parse(saved),voucher))!==JSON.stringify(a))throw Error('Retry record changed');sessionStorage.removeItem(storageKey);observed.current={raw:null};
   if(token===seq.current&&active.current===key){setPending(null);setDifference('');setReason('');setConfirm(null);setState(empty(key));setMessage('Recorded. Reload case history to verify the current state. No voucher, payment or Bale was changed.');}
  }catch{if(token===seq.current&&active.current===key){setConfirm(null);setState(empty(key));setMessage(stored?'Outcome not confirmed. The action may already be recorded; investigate or retry the exact request.':'Retry storage could not be verified; no request was sent this time. An earlier action may still complete.');if(!stored)setStorageError(true);}}
  finally{if(token===seq.current&&active.current===key){busy.current=false;setSaving(false);}}
 }
 function reviewStop(){try{const raw=sessionStorage.getItem(storageKey);if(!observed.current||raw!==observed.current.raw)throw Error('Retry changed');if(activePending&&(!raw||JSON.stringify(parseAdjustmentAttempt(JSON.parse(raw),voucher))!==JSON.stringify(activePending)))throw Error('Retry changed');stopSnapshot.current={raw};setStopping(true);setMessage('');}catch{setStopping(false);setMessage('Retry data changed or could not be read. Nothing was cleared; investigate before continuing.');}}
 function stopRetry(){
  try{if(!stopSnapshot.current||!observed.current||sessionStorage.getItem(storageKey)!==stopSnapshot.current.raw||observed.current.raw!==stopSnapshot.current.raw)throw Error('Retry changed');if(activePending&&(!stopSnapshot.current.raw||JSON.stringify(parseAdjustmentAttempt(JSON.parse(stopSnapshot.current.raw),voucher))!==JSON.stringify(activePending)))throw Error('Retry changed');sessionStorage.removeItem(storageKey);observed.current={raw:null};stopSnapshot.current=null;setPending(null);setStorageError(false);setStopping(false);setState(empty(key));setMessage('Retry stopped. This does not cancel an in-flight action; investigate all case history before making another decision.');}
  catch{stopSnapshot.current=null;setStopping(false);setMessage('Retry data changed or could not be read. Nothing was cleared; investigate before continuing.');}
 }
 function save(){
  if(!confirm||busy.current||!user?.id||!isFounder||assurance!=='ready'||!current.list||blocked)return;
  if(confirm.kind==='open'&&(!validDifference(difference)||!reason.trim()||reason.trim().length>500)){setMessage('Enter a nonzero difference with at most two decimals and an explanation.');return;}
  if(confirm.kind==='resolve'&&(!resolutionAck||!note.trim()||note.trim().length>500||(resolution==='settled_external'&&(!settledOn||settledOn<voucher.period_start||settledOn>getManilaClock().dateIso)))){
    setMessage('Confirm the reviewed decision, enter an explanation and, for external settlement, a valid actual date.');return;
  }
  try{
   const raw=confirm.kind==='open'?{kind:'open',id:crypto.randomUUID(),snapshot,difference,reason:reason.trim()}:{kind:'resolve',id:confirm.item.id,snapshot,resolution,settled_on:resolution==='settled_external'?settledOn:null,note:note.trim()};
   void send(parseAdjustmentAttempt(raw,voucher));
  }catch{setMessage('Invalid case or settlement details; inspect the original voucher.');}
 }
 return <div className="mt-3 border-t border-surface-border pt-3">
  <button type="button" className="min-h-11 font-semibold text-brand underline" aria-expanded={expanded} onClick={()=>setExpanded(v=>!v)}>Adjustment cases for this voucher</button>
  {expanded&&<div className="space-y-3 pt-2">
   <p>Review this original paid period only. Positive means a possible amount owed to the worker; negative means a possible overpayment. Verify evidence first. This does not change a voucher or move money.</p>
   <Button type="button" variant="secondary" size="sm" onClick={()=>load(current.list?.offset??0)} disabled={saving||current.loading||!isFounder||assurance!=='ready'} isLoading={current.loading}>{current.list?'Refresh case history':'Load case history'}</Button>
   {current.error&&<p role="alert">Unable to load case history: {current.error}</p>}{message&&<p role="status">{message}</p>}
   {retryAvailable&&(activePending||storageError)&&<div className="space-y-2 rounded-lg bg-status-warning-bg p-3"><p>A case action may have been sent. Retry details are sensitive, stored only in this tab and can be lost if storage is cleared. Missing records do not prove failure.</p>
    {activePending&&<><p className="break-all">{activePending.kind==='open'?'Open case':'Resolve case'} · ID {activePending.id} · original voucher {activePending.snapshot.id}.</p><p className="break-words">{activePending.kind==='open'?`Difference ₱${activePending.difference} · ${activePending.reason}`:`${activePending.resolution} · ${activePending.settled_on||'no date'} · ${activePending.note}`}</p><Button type="button" size="sm" variant="secondary" disabled={saving} onClick={()=>void send(activePending,true)}>Retry exact case action</Button></>}
    <Button type="button" size="sm" variant="ghost" disabled={saving} onClick={()=>{if(stopping){stopSnapshot.current=null;setStopping(false);}else reviewStop();}}>Review stopping case retry</Button>{stopping&&<div><p>Stopping does not cancel or undo an action. Independently investigate before proceeding.</p><Button type="button" size="sm" variant="danger" disabled={saving} onClick={stopRetry}>I investigated; stop case retry</Button></div>}
   </div>}
   {!retryAvailable&&<p>Checking case retry data…</p>}
   {current.list&&<>
    <p>Showing {current.list.items.length?current.list.offset+1:0}–{current.list.offset+current.list.items.length} of {current.list.total} cases. Check past cases before creating another; duplicates cannot always be detected.</p>
    {current.list.items.length===0?<p>No cases recorded for this voucher.</p>:<ul className="space-y-2">{current.list.items.map(item=><li key={item.id} className="rounded-lg border border-surface-border bg-white p-3">
     <p className="font-semibold text-navy">{item.status.replace('_',' ')} · difference ₱{item.difference}</p><p className="break-words">Reason: {item.reason}</p><p className="break-all">Created by {item.created_by} at {item.created_at} · case {item.id}.</p>
     {!sameSnapshot(item.original_voucher,snapshot)&&<p className="font-semibold text-status-warning">The original voucher differs from the version currently displayed. Investigate before resolving.</p>}
     {item.status!=='pending'&&<><p className="break-words">{item.status==='settled_external'?`External settlement recorded for ${item.settled_on}.`:'No transfer recorded.'} {item.resolution_note}</p><p className="break-all">Decision recorded by {item.resolved_by} at {item.resolved_at}. This is an assertion, not proof of settlement.</p></>}
     {item.status==='pending'&&<Button type="button" variant="secondary" size="sm" disabled={saving||blocked||!sameSnapshot(item.original_voucher,snapshot)} onClick={()=>prepareResolution(item)}>Resolve this case</Button>}
     {item.status!=='pending'&&user?.id&&projectCostCorrectionPreviewEnabled()&&sameSnapshot(item.original_voucher,snapshot)&&<ProjectCostCorrectionPanel key={JSON.stringify([user.id,item])} actor={user.id} kind="voucher" item={item}/>}
    </li>)}</ul>}
    <div className="flex flex-wrap gap-2"><Button type="button" variant="secondary" size="sm" disabled={saving||current.list.offset===0} onClick={()=>load(Math.max(0,current.list!.offset-100))}>Previous cases</Button><Button type="button" variant="secondary" size="sm" disabled={saving||current.list.offset+current.list.items.length>=current.list.total} onClick={()=>load(current.list!.offset+100)}>Next cases</Button></div>
    <form onSubmit={prepareOpen} className="space-y-3 border-t border-surface-border pt-3"><p className="font-semibold text-navy">Open a separate case</p><Input label="Signed difference in pesos" inputMode="decimal" value={difference} onChange={e=>setDifference(e.target.value)} hint="Example: 50.25 or -50.25; no automatic payment or deduction."/><Input label="Reason for review" maxLength={500} value={reason} onChange={e=>setReason(e.target.value)}/><Button type="submit" variant="secondary" size="sm" disabled={saving||blocked}>Review new case</Button></form>
   </>}
  </div>}
  <Modal isOpen={!!confirm} onClose={()=>setConfirm(null)} title={confirm?.kind==='open'?'Open adjustment review?':'Record case resolution?'} description="This records a review decision only. No money is sent or deducted." dismissOnBackdrop={!saving} dismissOnEscape={!saving} showCloseButton={!saving}>
   {confirm&&<div className="space-y-3 text-xs text-ink-secondary">
    {confirm.kind==='open'?<><p>{voucher.worker_name||'Worker unavailable'} · original period {voucher.period_start} to {voucher.period_end}</p><p>Signed difference ₱{difference} · {reason.trim()}</p><p>Check the original records and prior cases. This amount is an entered review figure, not proof of a payment or debt.</p></>:<><p>Case difference ₱{confirm.item.difference} · {confirm.item.reason}</p><Select label="Resolution" value={resolution} onChange={e=>{setResolution(e.target.value as typeof resolution);setResolutionAck(false);}}><option value="settled_external">Full amount settled outside the system</option><option value="no_transfer">No transfer required</option></Select>{resolution==='settled_external'&&<Input label="Actual settlement date" type="date" min={voucher.period_start} max={getManilaClock().dateIso} value={settledOn} onChange={e=>{setSettledOn(e.target.value);setResolutionAck(false);}}/>}<Input label="Resolution explanation" maxLength={500} value={note} onChange={e=>{setNote(e.target.value);setResolutionAck(false);}}/><p>Partial settlements are not supported here. Never record a settlement unless it actually happened.</p><label className="flex items-start gap-2"><input type="checkbox" checked={resolutionAck} onChange={e=>setResolutionAck(e.target.checked)}/> {resolution==='settled_external'?'I verified this full settlement actually happened outside the application.':'I reviewed this case and confirmed no transfer is required.'}</label></>}
    {message&&<p role="status">{message}</p>}<div className="flex justify-end gap-2"><Button type="button" variant="secondary" disabled={saving} onClick={()=>setConfirm(null)}>Cancel</Button><Button type="button" variant="primary" disabled={saving||(confirm?.kind==='resolve'&&!resolutionAck)} isLoading={saving} onClick={save}>{confirm.kind==='open'?'Open case':'Record resolution'}</Button></div>
   </div>}
  </Modal>
 </div>;
}
