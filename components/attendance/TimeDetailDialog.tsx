'use client';
import React, { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { useAuth } from '@/lib/auth/authContext';
import { createClient } from '@/lib/supabase/client';
import { weeklyWorkerActionsPreviewEnabled } from '@/lib/finance/featureAvailability';
import {timeDetailAttemptKey,parseTimeDetailAttempt,type TimeDetailAttempt} from '@/lib/attendance/timeDetailAttempt';
import type { HistoryRecord } from '@/lib/attendance/history';

type Detail = { request_id:string; regular_hours:string; overtime_hours:string; note:string; recorded_at:string; recorded_by:string; stale:boolean };
function parseDetail(value:unknown):Detail|null {
 if(value===null) return null;
 if(!value || typeof value!=='object') throw new Error('Invalid time detail response');
 const d=value as Detail;
 if(typeof d.request_id!=='string'||typeof d.regular_hours!=='string'||typeof d.overtime_hours!=='string'||typeof d.note!=='string'||typeof d.recorded_at!=='string'||typeof d.recorded_by!=='string'||typeof d.stale!=='boolean') throw new Error('Invalid time detail response');
 return d;
}
export function TimeDetailDialog({record,onClose}:{record:HistoryRecord;onClose:()=>void}){
 const {user}=useAuth();
 if(!user?.id)return <Modal isOpen onClose={onClose} title="Regular and overtime hours"><p>Sign in again to review time details.</p></Modal>;
 return <TimeDetailContents key={JSON.stringify([user.id,record.id,record.worker_id,record.project_id,record.date,record.submitted_at])} actor={user.id} record={record} onClose={onClose}/>;
}
function TimeDetailContents({actor,record,onClose}:{actor:string;record:HistoryRecord;onClose:()=>void}){
 const [detail,setDetail]=useState<Detail|null>(null),[loading,setLoading]=useState(true),[saving,setSaving]=useState(false);
 const [error,setError]=useState(''),[success,setSuccess]=useState(''),[readFailed,setReadFailed]=useState(false);
 const [regular,setRegular]=useState(''),[overtime,setOvertime]=useState('0'),[note,setNote]=useState('');
 const [ready,setReady]=useState(false),[pending,setPending]=useState<TimeDetailAttempt|null>(null),[storageError,setStorageError]=useState(false),[stop,setStop]=useState(false);
 const lock=useRef(false),sequence=useRef(0),storageKey=timeDetailAttemptKey(actor,record.id);
 const matches=(a:TimeDetailAttempt)=>a.actor===actor&&a.attendance===record.id&&a.worker===record.worker_id&&a.project===record.project_id&&a.date===record.date&&a.submittedAt===record.submitted_at;
 useEffect(()=>{let active=true;const seq=sequence;setLoading(true);setError('');
  try{const raw=sessionStorage.getItem(storageKey);if(raw)setPending(parseTimeDetailAttempt(JSON.parse(raw)));}catch{setStorageError(true);}setReady(true);
  createClient().rpc('attendance_time_detail_latest',{p_attendance:record.id}).then(({data,error})=>{
   if(!active)return;
   if(error){setReadFailed(true);setError(`Could not load saved time details: ${error.message}`);setLoading(false);return;}
   try{const saved=parseDetail(data);setDetail(saved);if(saved&&!saved.stale){setRegular(saved.regular_hours);setOvertime(saved.overtime_hours);}setLoading(false);}catch{setReadFailed(true);setError('Could not verify saved time details. Close and retry.');setLoading(false);}
  },()=>{if(active){setReadFailed(true);setError('Could not load saved time details. Close and retry.');setLoading(false);}});
  return()=>{active=false;seq.current++;};
 },[record.id,storageKey]);
 async function send(attempt:TimeDetailAttempt){
  if(lock.current||!ready||storageError||loading||readFailed||!matches(attempt))return;
  lock.current=true;setSaving(true);setError('');setSuccess('');const token=++sequence.current;let stored=false;
  try{
   const raw=sessionStorage.getItem(storageKey);
   if(raw&&JSON.stringify(parseTimeDetailAttempt(JSON.parse(raw)))!==JSON.stringify(attempt))throw new Error('A different retry is already stored');
   if(!raw)sessionStorage.setItem(storageKey,JSON.stringify(attempt));
   if(JSON.stringify(parseTimeDetailAttempt(JSON.parse(sessionStorage.getItem(storageKey)||'null')))!==JSON.stringify(attempt))throw new Error('Retry record could not be verified');
   stored=true;setPending(attempt);
   const {data,error:rpcError}=await createClient().rpc('record_attendance_time_detail',{p_request:attempt.id,p_attendance:attempt.attendance,p_expected_submitted_at:attempt.submittedAt,p_regular:attempt.regular,p_overtime:attempt.overtime,p_note:attempt.note});
   if(rpcError)throw new Error(rpcError.message);
   if(!data||data.request_id!==attempt.id||typeof data.replayed!=='boolean')throw new Error('Response could not be verified');
   if(token!==sequence.current)return;
   if(JSON.stringify(parseTimeDetailAttempt(JSON.parse(sessionStorage.getItem(storageKey)||'null')))!==JSON.stringify(attempt))throw new Error('Retry record changed');
   sessionStorage.removeItem(storageKey);setPending(null);setStop(false);
   // Do not permit another write against a stale list without a fresh read.
   setReadFailed(true);
   setSuccess(weeklyWorkerActionsPreviewEnabled()?'Time details saved. Existing weekly drafts do not update automatically; refresh and review the draft before approval. Close and reopen to check the latest saved details.':'Time details saved. They are not included in the current payroll generator. Close and reopen to check the latest saved details.');
  }catch(err){if(token===sequence.current){if(!stored)setStorageError(true);setError(stored?`Save not confirmed: ${err instanceof Error?err.message:'Unknown error'}. Check saved details and retry only the exact request.`:`Retry storage could not be verified: ${err instanceof Error?err.message:'Unknown error'}. No new request was intentionally sent.`);}}
  finally{if(token===sequence.current){lock.current=false;setSaving(false);}}
 }
 function submit(e:React.FormEvent){
  e.preventDefault();if(lock.current||!ready||storageError||pending||loading||error||readFailed||!record.submitted_at)return;
  if(!/^(?:\d{1,2})(?:\.\d{1,2})?$/.test(regular)||!/^(?:\d{1,2})(?:\.\d{1,2})?$/.test(overtime)||Number(regular)>8||Number(regular)+Number(overtime)>24||Number(regular)+Number(overtime)<=0||!note.trim()||note.trim().length>500){setError('Enter up to 8 regular hours, at most 24 total hours, and a reason.');return;}
  try{void send({version:1,actor,attendance:record.id,worker:record.worker_id,project:record.project_id,date:record.date,submittedAt:record.submitted_at,id:crypto.randomUUID(),regular,overtime,note:note.trim()});}
  catch{setError('Could not create a safe request ID. No request was sent.');}
 }
 function stopRetry(){
  try{sessionStorage.removeItem(storageKey);if(sessionStorage.getItem(storageKey)!==null)throw new Error('Storage did not clear');setPending(null);setStorageError(false);setStop(false);setError('');setReadFailed(true);setSuccess('Retry stopped after investigation. This did not cancel or undo any request. Close and reload the saved details before making another entry.');}
  catch{setStorageError(true);setError('Could not clear the retry record. Do not record different hours; investigate.');}
 }
 return <Modal isOpen onClose={onClose} title="Regular and overtime hours" description={`${record.worker_name || 'Worker'} · ${record.date} · ${record.project_name || 'Project site'}`} dismissOnBackdrop={!saving} dismissOnEscape={!saving} showCloseButton={!saving}>
  <div className="space-y-4 text-xs">
   <p className="rounded-xl border border-status-warning/25 bg-status-warning-bg p-3 leading-relaxed text-ink-secondary">{weeklyWorkerActionsPreviewEnabled()?'Experimental weekly payroll can use these details when its draft is generated or refreshed; existing drafts do not update automatically.':'These supplemental details are not yet used by the legacy payroll generator or project costs.'} The existing attendance status stays unchanged. If attendance changes later, these hours must be reviewed again. Approved or paid payroll blocks new details for the covered date; corrections need separate Founder review.</p>
   <p>Attendance status: <strong>{record.status.replace('_',' ')}</strong> · legacy recorded hours: {record.hours_worked}</p>
   {loading&&<p role="status">Loading saved time details…</p>}
   {!loading&&detail&&<p className={detail.stale?'font-semibold text-status-warning':'text-ink-secondary'}>Latest saved: {detail.regular_hours} regular + {detail.overtime_hours} OT hours · {detail.stale?'attendance changed; review required':'matches the attendance record when saved'} · note: {detail.note}</p>}
   {!loading&&!detail&&!error&&<p className="text-ink-secondary">No supplemental time details saved for this attendance record.</p>}
   {error&&<p role="alert" className="text-status-danger">{error} <button type="button" className="underline" onClick={()=>setError('')}>Dismiss</button></p>}
   {success&&<p role="status" className="text-status-success">{success}</p>}
   {(!ready||pending||storageError)&&<div className="space-y-2 rounded-lg bg-status-warning-bg p-3"><p>A previous time-detail request may have been sent. A missing response is not proof of failure. This tab&apos;s retry record is not shared with other tabs and may be lost if browser storage is cleared. Check the latest saved details and original request before recording different hours.</p>{pending&&<><p className="break-all">Request {pending.id} · {pending.regular} regular + {pending.overtime} OT hours · {pending.note}</p>{!matches(pending)&&<p>Attendance or account details changed. Do not retry this request here; investigate the original record.</p>}<Button type="button" size="sm" variant="secondary" disabled={saving||loading||readFailed||!matches(pending)||storageError} onClick={()=>void send(pending)}>Retry exact time details</Button></>}{ready&&<><Button type="button" size="sm" variant="ghost" disabled={saving} onClick={()=>setStop(v=>!v)}>Review stopping retry</Button>{stop&&<div><p>Stopping does not cancel an in-flight request or undo saved details. Independently investigate before stopping.</p><Button type="button" size="sm" variant="danger" disabled={saving} onClick={stopRetry}>I investigated; stop retrying</Button></div>}</>}</div>}
   {!loading&&ready&&!pending&&!storageError&&!readFailed&&<form onSubmit={submit} className="space-y-3">
    <div className="grid gap-3 sm:grid-cols-2"><Input label="Regular hours (maximum 8)" type="number" min="0" max="8" step="0.01" required value={regular} onChange={e=>{setRegular(e.target.value);setSuccess('');}}/><Input label="Overtime hours" type="number" min="0" max="24" step="0.01" required value={overtime} onChange={e=>{setOvertime(e.target.value);setSuccess('');}}/></div>
    <Input label="Reason / source of hours" maxLength={500} required value={note} onChange={e=>{setNote(e.target.value);setSuccess('');}}/>
    <div className="flex flex-wrap justify-end gap-2"><Button type="button" variant="secondary" disabled={saving} onClick={onClose}>Close</Button><Button type="submit" variant="primary" disabled={saving||!!success} isLoading={saving}>Save time details</Button></div>
   </form>}
  </div>
 </Modal>;
}
