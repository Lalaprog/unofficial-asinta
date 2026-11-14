'use client';

import React,{useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {Button} from '@/components/ui/Button';
import {Input} from '@/components/ui/Input';
import {Modal} from '@/components/ui/Modal';
import {createClient} from '@/lib/supabase/client';
import {getManilaClock} from '@/lib/reminders/scheduler';
import {classifyUnmarkedDates,parseWeeklyDraftDetails,parseWeeklyRefreshAttempt,parseWeeklyReturnAttempt,type WeeklyDraftDetails,type WeeklyRefreshAttempt,type WeeklyReturnAttempt} from '@/lib/payroll/weeklyDraftDetails';
import {weeklyWorkerRefreshPreviewEnabled,weeklyWorkerReturnPreviewEnabled} from '@/lib/finance/featureAvailability';
import type {WeeklyRow} from '@/lib/payroll/weeklyPreview';

type Action='generate'|'approve'|'pay'|'refresh'|'return';
/** Experimental only. Server-side authorization and complete coordinated schema are mandatory. */
export function WeeklyWorkerActions({row,start,end,userId,projects,previewDate}:{row:WeeklyRow;start:string;end:string;userId:string;previewDate:string;projects:{id:string;name:string}[]}) {
 const [details,setDetails]=useState<WeeklyDraftDetails|null>(null),[message,setMessage]=useState(''),[locked,setLocked]=useState(false),[saving,setSaving]=useState(false);
 const [confirm,setConfirm]=useState<Action|null>(null),[paymentDate,setPaymentDate]=useState(''),[ack,setAck]=useState(false);
 const refreshEnabled=weeklyWorkerRefreshPreviewEnabled(),returnEnabled=weeklyWorkerReturnPreviewEnabled();
 const [returnReason,setReturnReason]=useState(''),[returnAck,setReturnAck]=useState(false),[pendingReturn,setPendingReturn]=useState<WeeklyReturnAttempt|null>(null);
 const storageKey=JSON.stringify(['weekly-worker-refresh-v1',userId,row.worker.id,start]);
 const returnStorageKey=JSON.stringify(['weekly-worker-return-v1',userId,row.worker.id,start]);
 const [retryReady,setRetryReady]=useState(!refreshEnabled),[retryError,setRetryError]=useState(false),[pending,setPending]=useState<WeeklyRefreshAttempt|null>(null),[stopRetry,setStopRetry]=useState(false);
 const viewKey=JSON.stringify([storageKey,previewDate,refreshEnabled,returnEnabled]);
 const busy=useRef(false),mounted=useRef(true),activeKey=useRef(viewKey),observedRetry=useRef<{refresh:string|null;returned:string|null}|null>(null);activeKey.current=viewKey;
 useEffect(()=>{mounted.current=true;observedRetry.current=null;setRetryReady(!refreshEnabled);setPending(null);setPendingReturn(null);setReturnReason('');setReturnAck(false);setRetryError(false);setStopRetry(false);setDetails(null);setMessage('');setLocked(false);setConfirm(null);setSaving(false);
  if(refreshEnabled){try{const saved=sessionStorage.getItem(storageKey),returned=returnEnabled?sessionStorage.getItem(returnStorageKey):null;observedRetry.current={refresh:saved,returned};setPending(saved?parseWeeklyRefreshAttempt(JSON.parse(saved)):null);if(returnEnabled)setPendingReturn(returned?parseWeeklyReturnAttempt(JSON.parse(returned)):null);}catch{setRetryError(true);}setRetryReady(true);}
  return()=>{mounted.current=false;};
 },[refreshEnabled,returnEnabled,returnStorageKey,storageKey,viewKey]);
 const existing=row.vouchers.length===1&&row.vouchers[0].period_start===start&&row.vouchers[0].period_end===end?row.vouchers[0]:null;
 const mayGenerate=row.vouchers.length===0&&row.net!==null&&row.days.some(d=>d.entries.length>0)&&!row.worker.possible_supervisor;
 const missing=details?classifyUnmarkedDates(details.calculation.unmarked_dates,getManilaClock().dateIso):null;
 async function read(id:string){
  const {data,error}=await createClient().rpc('weekly_worker_draft_details',{p_id:id});if(error)throw new Error(error.message);
  return parseWeeklyDraftDetails(data,{id,worker:row.worker.id,start},refreshEnabled);
 }
 function fail(e:unknown){setDetails(null);setLocked(true);setConfirm(null);setMessage(`Outcome not confirmed: ${e instanceof Error?e.message:'Unknown error'}. Refresh the weekly preview and inspect the voucher before retrying; do not make or repeat an external payment based on this message.`);}
 async function load(id:string){
  if(busy.current||locked||!retryReady||retryError||pending||pendingReturn)return;
  if(getManilaClock().dateIso!==previewDate){fail(new Error('Philippine date changed'));return;}
  busy.current=true;setSaving(true);setMessage('');
  try{const value=await read(id);if(mounted.current&&activeKey.current===viewKey)setDetails(value);}catch(e){if(mounted.current&&activeKey.current===viewKey)fail(e);}
  finally{busy.current=false;if(mounted.current&&activeKey.current===viewKey)setSaving(false);}
 }
 async function sendRefresh(attempt:WeeklyRefreshAttempt,retry=false){
  if(busy.current||retryError||!retryReady||pendingReturn)return;
  if(getManilaClock().dateIso!==previewDate){fail(new Error('Philippine date changed'));return;}
  busy.current=true;setSaving(true);setMessage('');let stored=false;
  try{
   const saved=sessionStorage.getItem(storageKey);
   if((retry&&!saved)||(saved&&JSON.stringify(parseWeeklyRefreshAttempt(JSON.parse(saved)))!==JSON.stringify(attempt)))throw new Error('Retry record is missing or differs');
   if(!saved){sessionStorage.setItem(storageKey,JSON.stringify(attempt));}
   const preserved=sessionStorage.getItem(storageKey);if(JSON.stringify(parseWeeklyRefreshAttempt(JSON.parse(preserved||'null')))!==JSON.stringify(attempt))throw new Error('Could not preserve the exact retry');
   if(observedRetry.current)observedRetry.current.refresh=preserved;
   stored=true;if(mounted.current&&activeKey.current===viewKey){setPending(attempt);setConfirm(null);}
   // Revalidate the worker and original period even for a retry recovered from
   // browser storage; never use storage as authority for a financial target.
   await read(attempt.payroll);
   if(!mounted.current||activeKey.current!==viewKey)return;
   if(JSON.stringify(parseWeeklyRefreshAttempt(JSON.parse(sessionStorage.getItem(storageKey)||'null')))!==JSON.stringify(attempt))throw new Error('Retry record changed');
   if(returnEnabled&&sessionStorage.getItem(returnStorageKey)!==null)throw new Error('A return retry is pending');
   if(getManilaClock().dateIso!==previewDate)throw new Error('Philippine date changed');
   const {data,error}=await createClient().rpc('refresh_weekly_worker_draft',{p_request:attempt.request,p_id:attempt.payroll,p_expected_revision:attempt.revision});
   if(error)throw new Error(error.message);
   if(!data||data.payroll_id!==attempt.payroll||typeof data.replayed!=='boolean'||data.revision!==attempt.revision+1||!data.calculation)throw new Error('Refresh response could not be verified');
   const updated=await read(attempt.payroll);
   const c=updated.calculation, received=data.calculation;
   if(updated.status!=='draft'||updated.draft_revision!==attempt.revision+1||
    !received||['regular_hours','overtime_hours','wage','allowance','gross','bale','net'].some(k=>received[k]!==c[k as keyof typeof c])||
    !Array.isArray(received.unmarked_dates)||JSON.stringify(received.unmarked_dates)!==JSON.stringify(c.unmarked_dates))throw new Error('Draft changed after refresh; investigate before proceeding');
   if(!mounted.current||activeKey.current!==viewKey)return;
   if(JSON.stringify(parseWeeklyRefreshAttempt(JSON.parse(sessionStorage.getItem(storageKey)||'null')))!==JSON.stringify(attempt))throw new Error('Retry record changed');
   sessionStorage.removeItem(storageKey);if(observedRetry.current)observedRetry.current.refresh=null;
   if(mounted.current&&activeKey.current===viewKey){setPending(null);setDetails(updated);setConfirm(null);setStopRetry(false);setMessage('Draft refreshed. Review the new saved revision and source records before approval.');}
  }catch(e){if(mounted.current&&activeKey.current===viewKey){setDetails(null);setConfirm(null);if(!stored)setRetryError(true);setMessage(stored?'Refresh outcome not confirmed. Retry the exact request or investigate before stopping; it may still be processing.':`Retry storage could not be verified: ${e instanceof Error?e.message:'Unknown error'}. No new request was intentionally sent; investigate before proceeding.`);}}
  finally{busy.current=false;if(mounted.current&&activeKey.current===viewKey)setSaving(false);}
 }
 async function sendReturn(attempt:WeeklyReturnAttempt,retry=false){
  if(!returnEnabled||busy.current||retryError||!retryReady||pending)return;
  if(getManilaClock().dateIso!==previewDate){fail(new Error('Philippine date changed'));return;}
  busy.current=true;setSaving(true);setMessage('');let stored=false;
  try{
   const saved=sessionStorage.getItem(returnStorageKey);
   if((retry&&!saved)||(saved&&JSON.stringify(parseWeeklyReturnAttempt(JSON.parse(saved)))!==JSON.stringify(attempt)))throw new Error('Return retry record is missing or differs');
   if(!saved)sessionStorage.setItem(returnStorageKey,JSON.stringify(attempt));
   const preserved=sessionStorage.getItem(returnStorageKey);if(JSON.stringify(parseWeeklyReturnAttempt(JSON.parse(preserved||'null')))!==JSON.stringify(attempt))throw new Error('Could not preserve the exact retry');
   if(observedRetry.current)observedRetry.current.returned=preserved;
   stored=true;if(mounted.current&&activeKey.current===viewKey){setPendingReturn(attempt);setConfirm(null);}
   await read(attempt.payroll);
   if(!mounted.current||activeKey.current!==viewKey)return;
   if(JSON.stringify(parseWeeklyReturnAttempt(JSON.parse(sessionStorage.getItem(returnStorageKey)||'null')))!==JSON.stringify(attempt))throw new Error('Retry record changed');
   if(sessionStorage.getItem(storageKey)!==null)throw new Error('A refresh retry is pending');
   if(getManilaClock().dateIso!==previewDate)throw new Error('Philippine date changed');
   const {data,error}=await createClient().rpc('return_weekly_worker_to_draft',{p_request:attempt.request,p_id:attempt.payroll,p_expected_revision:attempt.revision,p_reason:attempt.reason});
   if(error)throw new Error(error.message);
   if(!data||data.payroll_id!==attempt.payroll||typeof data.replayed!=='boolean'||data.revision!==attempt.revision+1)throw new Error('Return response could not be verified');
   const updated=await read(attempt.payroll);
   if(updated.status!=='draft'||updated.draft_revision!==attempt.revision+1)throw new Error('Voucher changed after return; investigate before proceeding');
   if(!mounted.current||activeKey.current!==viewKey)return;
   if(JSON.stringify(parseWeeklyReturnAttempt(JSON.parse(sessionStorage.getItem(returnStorageKey)||'null')))!==JSON.stringify(attempt))throw new Error('Retry record changed');
   sessionStorage.removeItem(returnStorageKey);if(observedRetry.current)observedRetry.current.returned=null;setPendingReturn(null);setDetails(updated);setConfirm(null);setReturnReason('');setReturnAck(false);setStopRetry(false);setMessage('Returned to draft. The saved amount is unchanged; refresh the draft and review its sources before a new approval. No payment was made or reversed.');
  }catch(e){if(mounted.current&&activeKey.current===viewKey){setDetails(null);setConfirm(null);if(!stored)setRetryError(true);setMessage(stored?'Return outcome not confirmed. Retry the exact request or investigate before stopping; it may still be processing.':`Retry storage could not be verified: ${e instanceof Error?e.message:'Unknown error'}. No new request was intentionally sent; investigate before proceeding.`);}}
  finally{busy.current=false;if(mounted.current&&activeKey.current===viewKey)setSaving(false);}
 }
 function stopPending(){
  if(busy.current)return;
  try{const observed=observedRetry.current;if(!observed||sessionStorage.getItem(storageKey)!==observed.refresh||(returnEnabled&&sessionStorage.getItem(returnStorageKey)!==observed.returned))throw new Error('Retry record changed');sessionStorage.removeItem(storageKey);if(returnEnabled)sessionStorage.removeItem(returnStorageKey);observedRetry.current={refresh:null,returned:null};setPending(null);setPendingReturn(null);setRetryError(false);setStopRetry(false);setDetails(null);setLocked(true);setMessage('Retry stopped; this did not cancel or undo the request. Reload and independently inspect the voucher before taking any further action.');}
  catch{setRetryError(true);setMessage('Could not clear retry record; investigate before continuing.');}
 }
 async function act(){
  if(!confirm||busy.current||locked||!retryReady||retryError||pending||pendingReturn)return;
  if(getManilaClock().dateIso!==previewDate){fail(new Error('Philippine date changed'));return;}
  const action=confirm,old=details;
  if(action==='generate'&&!mayGenerate)return;
  if(action==='approve'&&(!old||old.status!=='draft'))return;
  if(action==='refresh'&&(!refreshEnabled||!old||old.status!=='draft'||old.draft_revision===undefined))return;
  if(action==='return'&&(!returnEnabled||!old||old.status!=='approved'||old.draft_revision===undefined||!returnAck||!returnReason.trim()||returnReason.trim().length>500))return;
  if(action==='pay'&&(!old||old.status!=='approved'||!ack||!paymentDate||paymentDate<start||paymentDate>getManilaClock().dateIso))return;
  busy.current=true;setSaving(true);setMessage('');
  try{
   let id=old?.payroll_id;
   if(action==='generate'){
    // Persist only a random request ID and identifiers, so a lost response and
    // tab reload do not silently turn a retry into a different request.
    const storageKey=JSON.stringify(['weekly-worker-draft-v1',userId,row.worker.id,start]);
    id=localStorage.getItem(storageKey)||crypto.randomUUID();localStorage.setItem(storageKey,id);
    if(localStorage.getItem(storageKey)!==id)throw new Error('Could not preserve retry ID');
    const {data,error}=await createClient().rpc('create_weekly_worker_draft',{p_id:id,p_worker:row.worker.id,p_start:start});if(error)throw new Error(error.message);
    if(!data||data.payroll_id!==id||typeof data.replayed!=='boolean')throw new Error('Draft response could not be verified');
   }else if(action==='refresh'){
    const attempt=parseWeeklyRefreshAttempt({request:crypto.randomUUID(),payroll:id,revision:old!.draft_revision});
    busy.current=false;await sendRefresh(attempt);return;
   }else if(action==='return'){
    const attempt=parseWeeklyReturnAttempt({request:crypto.randomUUID(),payroll:id,revision:old!.draft_revision,reason:returnReason.trim()});
    busy.current=false;await sendReturn(attempt);return;
   }else if(action==='approve'){
    const args=refreshEnabled?{p_id:id,p_expected_revision:old!.draft_revision}:{p_id:id};
    const {data,error}=await createClient().rpc('approve_weekly_worker_draft',args);if(error)throw new Error(error.message);
    if(!data||!['updated','already_approved'].includes(data.outcome)||data.payroll?.id!==id||data.payroll?.status!=='approved')throw new Error('Approval response could not be verified');
   }else{
    const args=returnEnabled?{p_id:id,p_payment_date:paymentDate,p_expected_revision:old!.draft_revision}:{p_id:id,p_payment_date:paymentDate};
    const {data,error}=await createClient().rpc('record_weekly_worker_payment',args);if(error)throw new Error(error.message);
    if(!data||!['updated','already_recorded'].includes(data.outcome)||data.payroll?.id!==id||data.payroll?.status!=='paid'||data.payment_date!==paymentDate)throw new Error('Payment response could not be verified');
   }
   const updated=await read(id!);
   if(action==='generate'&&updated.status!=='draft'||action==='approve'&&(updated.status!=='approved'||refreshEnabled&&updated.draft_revision!==old?.draft_revision)||action==='pay'&&(updated.status!=='paid'||updated.payment_date!==paymentDate||refreshEnabled&&updated.draft_revision!==old?.draft_revision))throw new Error('Voucher state changed; review again');
   if(mounted.current&&activeKey.current===viewKey){setDetails(updated);setConfirm(null);setAck(false);setPaymentDate('');setMessage(action==='generate'?'Draft recorded. Review its saved amounts before approval.':action==='approve'?'Approval recorded. A separate confirmation is required to record an external payment.':'External payment recorded. No money was transferred by this application.');}
  }catch(e){if(mounted.current&&activeKey.current===viewKey)fail(e);}
  finally{busy.current=false;if(mounted.current&&activeKey.current===viewKey)setSaving(false);}
 }
 if(!existing&&!mayGenerate&&!pending&&!pendingReturn&&!retryError)return null;
 return <div className="mt-3 space-y-2 border-t border-surface-border pt-2">
  <p className="font-semibold text-navy">Experimental weekly voucher</p>
  {refreshEnabled&&!retryReady&&<p>Checking saved retry record…</p>}
  {refreshEnabled&&(pending||pendingReturn||retryError)&&<div className="space-y-2 rounded-lg bg-status-warning-bg p-3"><p>A refresh or return may have been sent. This tab’s retry record is not shared with other tabs and can be lost if browser storage is cleared. A missing response does not mean failure.</p>{pending&&<><p className="break-all">Voucher {pending.payroll} · request {pending.request} · reviewed revision {pending.revision}</p><Button type="button" size="sm" variant="secondary" disabled={saving||!!pendingReturn} onClick={()=>void sendRefresh(pending,true)}>Retry exact refresh</Button></>}{pendingReturn&&<><p className="break-all">Return voucher {pendingReturn.payroll} · request {pendingReturn.request} · reviewed revision {pendingReturn.revision}</p><p className="break-words">Reason: {pendingReturn.reason}</p><Button type="button" size="sm" variant="secondary" disabled={saving||!!pending} onClick={()=>void sendReturn(pendingReturn,true)}>Retry exact return</Button></>}<Button type="button" size="sm" variant="ghost" disabled={saving} onClick={()=>setStopRetry(v=>!v)}>Review stopping retry</Button>{stopRetry&&<div><p>Stopping does not cancel or undo an in-flight request. Independently investigate the voucher and original request before proceeding.</p><Button type="button" size="sm" variant="danger" disabled={saving} onClick={stopPending}>I investigated; stop retrying</Button></div>}</div>}
  {!details&&retryReady&&!retryError&&!pending&&!pendingReturn&&(existing?<Button type="button" size="sm" variant="secondary" disabled={locked||saving} onClick={()=>load(existing.id)} isLoading={saving}>Load voucher details</Button>:<Button type="button" size="sm" variant="secondary" disabled={locked||saving} onClick={()=>setConfirm('generate')}>Review new draft</Button>)}
  {message&&<p role="status" className={locked?'text-status-danger':''}>{message}</p>}
  {details&&!pending&&!pendingReturn&&!retryError&&<div className="space-y-2">
   <p className="font-semibold">Saved status: {details.status} · {details.period_start} to {details.period_end}{refreshEnabled&&` · revision ${details.draft_revision}`}</p>
   <p>Regular {details.calculation.regular_hours} hrs · OT {details.calculation.overtime_hours} hrs · wages ₱{details.calculation.wage} · allowances ₱{details.calculation.allowance} · gross ₱{details.gross} · Bale ₱{details.bale} · net ₱{details.net}</p>
   {missing&&<div className="space-y-1"><p>Saved unmarked dates, classified using the current Philippine date. Unmarked does not mean absent; this saved snapshot does not update when attendance changes.</p><p>Past unmarked: {missing.past.join(', ')||'none'}.</p><p>Today unmarked: {missing.today.join(', ')||'none'}.</p><p>Upcoming: {missing.upcoming.join(', ')||'none'}.</p></div>}
   {details.payment_date&&<><p>Recorded external payment date: {details.payment_date}. This is not proof of transfer.</p><p>Project gross allocations (not combined expense totals):</p>{details.allocations.length?<ul>{details.allocations.map(a=><li key={a.project_id}>{projects.find(p=>p.id===a.project_id)?.name||`Site ID ${a.project_id}`}: ₱{a.gross} ({a.hours} hrs, wages ₱{a.wage}, allowances ₱{a.allowance})</li>)}</ul>:<p>No site allocation for a zero-work voucher.</p>}<p>Do not add these to expenses without reconciling Bale and other overlapping entries.</p></>}
   {refreshEnabled&&details.status==='draft'&&<Button type="button" size="sm" variant="secondary" disabled={locked||saving} onClick={()=>setConfirm('refresh')}>Review draft refresh</Button>}
   {details.status==='draft'&&<Button type="button" size="sm" variant="secondary" disabled={locked||saving} onClick={()=>setConfirm('approve')}>Review approval</Button>}
   {returnEnabled&&details.status==='approved'&&<Button type="button" size="sm" variant="secondary" disabled={locked||saving} onClick={()=>{setReturnReason('');setReturnAck(false);setConfirm('return');}}>Review return to draft</Button>}
   {details.status==='approved'&&<Button type="button" size="sm" variant="secondary" disabled={locked||saving} onClick={()=>{setPaymentDate('');setAck(false);setConfirm('pay');}}>Review external payment</Button>}
  </div>}
  {typeof document!=='undefined'&&createPortal(<Modal isOpen={!!confirm} onClose={()=>setConfirm(null)} title={confirm==='generate'?'Create weekly draft?':confirm==='refresh'?'Refresh this unapproved draft?':confirm==='return'?'Return approval to draft?':confirm==='approve'?'Approve saved weekly voucher?':'Record an external payment?'} description="Review this worker and original period carefully. This application does not transfer money." dismissOnBackdrop={!saving} dismissOnEscape={!saving} showCloseButton={!saving}>
   {confirm&&<div className="space-y-3 text-sm text-ink-secondary">
    <p className="font-semibold text-navy">{row.worker.name} · {start} to {end}</p>
    {confirm==='generate'?<><p>Preview only: wages ₱{row.wage}, allowances ₱{row.allowance}, Bale ₱{row.bale}, net ₱{row.net}. The server recalculates the saved draft; review the result before approval.</p><p>Unmarked dates are not absences. Current rates may not be historical rates; review incomplete days, recorded Bale and all warnings.</p>{row.reviewReasons.map(reason=><p key={reason}>{reason}</p>)}</>:<><p>Saved gross ₱{details?.gross} · Bale ₱{details?.bale} · net ₱{details?.net}. Past unmarked: {missing?.past.join(', ')||'none'}; today unmarked: {missing?.today.join(', ')||'none'}; upcoming: {missing?.upcoming.join(', ')||'none'}. This is the saved snapshot, not proof of current attendance.</p>{confirm==='return'?<><p>Only return this voucher if you have verified no external payment has occurred or is in progress. If payment may have happened, stop and investigate; this action does not undo or cancel payment. The previous approval remains in history and a new approval is required.</p><Input label="Reason for returning to draft" maxLength={500} value={returnReason} onChange={e=>setReturnReason(e.target.value)}/><label className="flex items-start gap-2"><input type="checkbox" checked={returnAck} onChange={e=>setReturnAck(e.target.checked)} />I verified no external payment occurred or is in progress for this voucher.</label></>:confirm==='refresh'?<p>The server will recalculate this draft from current source records. The previous snapshot is retained; the new amount may differ. Review the new saved revision before approval. No payment is made.</p>:confirm==='approve'?<p>Confirm only after reviewing the source records and this saved voucher. Changes after generation can block approval.{refreshEnabled&&` You are approving revision ${details?.draft_revision}.`}</p>:<><p>Record this only after the payment actually happened outside the application. No transfer is sent. A later correction requires separate original-period review.</p><Input label="Actual external payment date" type="date" min={start} max={getManilaClock().dateIso} value={paymentDate} onChange={e=>setPaymentDate(e.target.value)} /><label className="flex items-start gap-2"><input type="checkbox" checked={ack} onChange={e=>setAck(e.target.checked)} />I verified the external payment already occurred for this worker, amount and date.</label></>}</>}
    <div className="flex flex-wrap justify-end gap-2"><Button type="button" size="sm" variant="secondary" disabled={saving} onClick={()=>setConfirm(null)}>Cancel</Button><Button type="button" size="sm" isLoading={saving} disabled={saving||(confirm==='return'&&(!returnAck||!returnReason.trim()||returnReason.trim().length>500))||(confirm==='pay'&&(!ack||!paymentDate||paymentDate<start||paymentDate>getManilaClock().dateIso))} onClick={act}>{confirm==='generate'?'Create draft':confirm==='refresh'?'Refresh draft':confirm==='return'?'Return to draft':confirm==='approve'?'Confirm approval':'Record payment'}</Button></div>
   </div>}
  </Modal>,document.body)}
 </div>;
}
