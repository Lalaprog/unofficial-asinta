'use client';
import React, {useEffect,useRef,useState} from 'react';
import {Button} from '@/components/ui/Button';
import {Input} from '@/components/ui/Input';
import {Modal} from '@/components/ui/Modal';
import {useAuth} from '@/lib/auth/authContext';
import {createClient} from '@/lib/supabase/client';
import {parseAllowances,type AllowanceItem} from '@/lib/payroll/workerAllowances';
import {allowanceAttemptKey,parseAllowanceAttempt,type AllowanceAttempt} from '@/lib/payroll/allowanceAttempt';
import {weeklyWorkerActionsPreviewEnabled} from '@/lib/finance/featureAvailability';
import type {HistoryRecord} from '@/lib/attendance/history';

export function AllowanceDialog({record,isFounder,onClose}:{record:HistoryRecord;isFounder:boolean;onClose:()=>void}) {
 const {user}=useAuth();
 if(!user?.id)return <Modal isOpen onClose={onClose} title="Worker allowances"><p>Sign in again to review allowances.</p></Modal>;
 // A different account or attendance record must not inherit a previous async operation.
 return <AllowanceContents key={JSON.stringify([user.id,record.id,record.worker_id,record.project_id,record.date,record.submitted_at])} record={record} isFounder={isFounder} onClose={onClose} actor={user.id}/>;
}
function AllowanceContents({record,isFounder,onClose,actor}:{record:HistoryRecord;isFounder:boolean;onClose:()=>void;actor:string}) {
 const [items,setItems]=useState<AllowanceItem[]|null>(null),[loading,setLoading]=useState(true),[saving,setSaving]=useState(false);
 const [error,setError]=useState(''),[success,setSuccess]=useState(''),[amount,setAmount]=useState(''),[description,setDescription]=useState('');
 const [ready,setReady]=useState(false),[pending,setPending]=useState<AllowanceAttempt|null>(null),[storageError,setStorageError]=useState(false),[stop,setStop]=useState(false);
 const seq=useRef(0),lock=useRef(false),storageKey=allowanceAttemptKey(actor,record.id);
 const matches=(a:AllowanceAttempt)=>a.actor===actor&&a.attendance===record.id&&a.worker===record.worker_id&&a.project===record.project_id&&a.date===record.date&&a.submittedAt===record.submitted_at;
 useEffect(()=>{const seqRef=seq;const token=++seqRef.current;setLoading(true);
  try{const raw=sessionStorage.getItem(storageKey);if(raw){const a=parseAllowanceAttempt(JSON.parse(raw));setPending(a);}}catch{setStorageError(true);}setReady(true);
  createClient().rpc('worker_allowances_for_attendance',{p_attendance:record.id}).then(({data,error})=>{
   if(token!==seqRef.current)return;
   try{if(error)throw new Error(error.message);setItems(parseAllowances(data));}catch(e){setItems(null);setError(`Could not load allowances: ${e instanceof Error?e.message:'Unknown error'}`);}finally{setLoading(false);}
  },()=>{if(token===seqRef.current){setItems(null);setError('Could not load allowances. Close and retry.');setLoading(false);}});
  return()=>{seqRef.current++;};
 },[record.id,storageKey]);
 async function send(attempt:AllowanceAttempt){
  if(lock.current||!ready||storageError||loading||items===null||!matches(attempt))return;
  lock.current=true;setSaving(true);setError('');setSuccess('');const token=++seq.current;let stored=false;
  try{
   const raw=sessionStorage.getItem(storageKey);
   if(raw&&JSON.stringify(parseAllowanceAttempt(JSON.parse(raw)))!==JSON.stringify(attempt))throw new Error('A different retry is already stored');
   if(!raw)sessionStorage.setItem(storageKey,JSON.stringify(attempt));
   if(JSON.stringify(parseAllowanceAttempt(JSON.parse(sessionStorage.getItem(storageKey)||'null')))!==JSON.stringify(attempt))throw new Error('Retry record could not be verified');
   stored=true;setPending(attempt);
   const {data,error:failure}=await createClient().rpc('submit_worker_allowance',{p_id:attempt.id,p_attendance:attempt.attendance,p_expected_submitted_at:attempt.submittedAt,p_amount:attempt.amount,p_description:attempt.description});
   if(failure)throw new Error(failure.message);
   if(!data||data.id!==attempt.id||typeof data.replayed!=='boolean'||!['pending','approved','rejected'].includes(data.status))throw new Error('Response could not be verified');
   if(token!==seq.current)return;
   if(JSON.stringify(parseAllowanceAttempt(JSON.parse(sessionStorage.getItem(storageKey)||'null')))!==JSON.stringify(attempt))throw new Error('Retry record changed');
   sessionStorage.removeItem(storageKey);setPending(null);setStop(false);
   setSuccess(data.status==='pending'?'Submitted for Founder approval. No payroll or payment was changed.':'Allowance recorded. No payroll or payment was changed.');
   try{
    const response=await createClient().rpc('worker_allowances_for_attendance',{p_attendance:record.id});
    if(token!==seq.current)return;
    if(response.error)throw new Error(response.error.message);setItems(parseAllowances(response.data));
   }catch{if(token===seq.current){setItems(null);setError('Allowance was confirmed, but its list could not be refreshed. Close and reload before making another entry.');}}
  }catch(e){if(token===seq.current){if(!stored)setStorageError(true);setError(stored?`Result not fully confirmed: ${e instanceof Error?e.message:'Unknown error'}. Check the allowance list and retry only the exact request.`:`Retry storage could not be verified: ${e instanceof Error?e.message:'Unknown error'}. No new request was intentionally sent.`);}}
  finally{if(token===seq.current){lock.current=false;setSaving(false);}}
 }
 function submit(e:React.FormEvent){
  e.preventDefault();if(lock.current||!ready||storageError||pending||loading||items===null||error||!record.submitted_at)return;
  if(!/^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/.test(amount)||Number(amount)<=0||!description.trim()||description.trim().length>500){setError('Enter a positive amount with at most two decimal places and a description.');return;}
  try{void send({version:1,actor,attendance:record.id,worker:record.worker_id,project:record.project_id,date:record.date,submittedAt:record.submitted_at,id:crypto.randomUUID(),amount,description:description.trim()});}
  catch{setError('Could not create a safe request ID. No request was sent.');}
 }
 function stopRetry(){
  try{sessionStorage.removeItem(storageKey);if(sessionStorage.getItem(storageKey)!==null)throw new Error('Storage did not clear');setPending(null);setStorageError(false);setStop(false);setError('');setItems(null);setAmount('');setDescription('');setSuccess('Retry stopped after investigation. This did not cancel or undo any request. Close and reload the allowance list before making a new entry.');}
  catch{setStorageError(true);setError('Could not clear the retry record. Do not create another allowance; investigate.');}
 }
 return <Modal isOpen onClose={onClose} title="Worker allowances" description={`${record.worker_name||'Worker'} · ${record.date} · ${record.project_name||'Project site'}`} dismissOnBackdrop={!saving} dismissOnEscape={!saving} showCloseButton={!saving}>
  <div className="space-y-4 text-xs">
   <p className="rounded-xl border border-status-warning/25 bg-status-warning-bg p-3 leading-relaxed text-ink-secondary">{isFounder?'Your entry is recorded as approved.':'Your entry requires Founder approval.'} {weeklyWorkerActionsPreviewEnabled()?'An approved allowance can be included when the experimental weekly draft is generated or refreshed; an existing voucher does not update automatically.':'Allowances are not yet added to the legacy payroll generator or project costs.'} Approval does not pay anyone. Dates covered by approved or paid payroll require a separate correction.</p>
   {loading&&<p role="status">Loading allowances…</p>}
   {items&&<div className="space-y-2"><p className="font-semibold text-navy">Saved for this attendance</p>{items.length?items.map(i=><div key={i.id} className="rounded-lg border border-surface-border p-2"><span className="font-semibold">₱{i.amount} · {i.status}</span> · {i.description}{i.stale&&<span className="font-semibold text-status-warning"> · attendance changed; review required</span>}</div>):<p className="text-ink-secondary">No allowances recorded.</p>}</div>}
   {error&&<p role="alert" className="text-status-danger">{error} <button type="button" className="underline" onClick={()=>setError('')}>Dismiss</button></p>}
   {success&&<p role="status" className="text-status-success">{success}</p>}
   {(!ready||pending||storageError)&&<div className="space-y-2 rounded-lg bg-status-warning-bg p-3"><p>A previous allowance request may have been sent. A missing response is not proof of failure. This tab&apos;s retry record is not shared with other tabs and may be lost if browser storage is cleared. Check the saved list and original request before creating another allowance.</p>{pending&&<><p className="break-all">Request {pending.id} · ₱{pending.amount} · {pending.description}</p>{!matches(pending)&&<p>Attendance or account details changed. Do not retry this request here; investigate the original record.</p>}<Button type="button" size="sm" variant="secondary" disabled={saving||loading||items===null||!matches(pending)||storageError} onClick={()=>void send(pending)}>Retry exact allowance</Button></>}{ready&&<><Button type="button" size="sm" variant="ghost" disabled={saving} onClick={()=>setStop(v=>!v)}>Review stopping retry</Button>{stop&&<div><p>Stopping does not cancel an in-flight request or undo a saved allowance. Independently investigate before stopping.</p><Button type="button" size="sm" variant="danger" disabled={saving} onClick={stopRetry}>I investigated; stop retrying</Button></div>}</>}</div>}
   {!loading&&ready&&!pending&&!storageError&&items!==null&&<form onSubmit={submit} className="space-y-3"><Input label="Allowance amount (₱)" type="number" min="0.01" max="99999999.99" step="0.01" required value={amount} onChange={e=>{setAmount(e.target.value);setSuccess('');}}/><Input label="Allowance purpose" maxLength={500} required value={description} onChange={e=>{setDescription(e.target.value);setSuccess('');}}/><div className="flex flex-wrap justify-end gap-2"><Button type="button" variant="secondary" disabled={saving} onClick={onClose}>Close</Button><Button type="submit" variant="primary" disabled={saving||!!success} isLoading={saving}>{isFounder?'Record approved allowance':'Submit for approval'}</Button></div></form>}
  </div>
 </Modal>;
}
