'use client';
import React, { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { createClient } from '@/lib/supabase/client';
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
 const [detail,setDetail]=useState<Detail|null>(null),[loading,setLoading]=useState(true),[saving,setSaving]=useState(false);
 const [error,setError]=useState(''),[success,setSuccess]=useState(''),[readFailed,setReadFailed]=useState(false);
 const [regular,setRegular]=useState(''),[overtime,setOvertime]=useState('0'),[note,setNote]=useState('');
 const lock=useRef(false),sequence=useRef(0),request=useRef<{key:string;id:string}|null>(null);
 useEffect(()=>{let active=true;const seq=sequence;setLoading(true);setError('');
  createClient().rpc('attendance_time_detail_latest',{p_attendance:record.id}).then(({data,error})=>{
   if(!active)return;
   if(error){setReadFailed(true);setError(`Could not load saved time details: ${error.message}`);setLoading(false);return;}
   try{const saved=parseDetail(data);setDetail(saved);if(saved&&!saved.stale){setRegular(saved.regular_hours);setOvertime(saved.overtime_hours);}setLoading(false);}catch{setReadFailed(true);setError('Could not verify saved time details. Close and retry.');setLoading(false);}
  },()=>{if(active){setReadFailed(true);setError('Could not load saved time details. Close and retry.');setLoading(false);}});
  return()=>{active=false;seq.current++;};
 },[record.id]);
 const submit=async(e:React.FormEvent)=>{
  e.preventDefault();if(lock.current||loading||error||readFailed||!record.submitted_at)return;
  if(!/^(?:\d{1,2})(?:\.\d{1,2})?$/.test(regular)||!/^(?:\d{1,2})(?:\.\d{1,2})?$/.test(overtime)||Number(regular)>8||Number(regular)+Number(overtime)>24||Number(regular)+Number(overtime)<=0||!note.trim()) {setError('Enter up to 8 regular hours, at most 24 total hours, and a reason.');return;}
  const key=JSON.stringify([record.id,record.submitted_at,regular,overtime,note.trim()]);
  if(!request.current||request.current.key!==key)request.current={key,id:crypto.randomUUID()};
  lock.current=true;setSaving(true);setError('');setSuccess('');const token=++sequence.current;
  try{
   const {data,error:rpcError}=await createClient().rpc('record_attendance_time_detail',{p_request:request.current.id,p_attendance:record.id,p_expected_submitted_at:record.submitted_at,p_regular:regular,p_overtime:overtime,p_note:note.trim()});
   if(rpcError)throw new Error(rpcError.message);
   if(!data||data.request_id!==request.current.id||typeof data.replayed!=='boolean')throw new Error('Response could not be verified');
   if(token!==sequence.current)return;
   setSuccess('Time details saved. They are not included in the current payroll generator. Close and reopen to check the latest saved details.');
  }catch(err){if(token===sequence.current)setError(`Save not confirmed: ${err instanceof Error?err.message:'Unknown error'}. Check saved details before retrying.`);}
  finally{if(token===sequence.current){lock.current=false;setSaving(false);}}
 };
 return <Modal isOpen onClose={onClose} title="Regular and overtime hours" description={`${record.worker_name || 'Worker'} · ${record.date} · ${record.project_name || 'Project site'}`} dismissOnBackdrop={!saving} dismissOnEscape={!saving} showCloseButton={!saving}>
  <div className="space-y-4 text-xs">
   <p className="rounded-xl border border-status-warning/25 bg-status-warning-bg p-3 leading-relaxed text-ink-secondary">These supplemental details are not yet used by payroll or project costs. The existing attendance status stays unchanged. If attendance changes later, these hours must be reviewed again. Approved or paid payroll blocks new details for the covered date; corrections need separate Founder review.</p>
   <p>Attendance status: <strong>{record.status.replace('_',' ')}</strong> · legacy recorded hours: {record.hours_worked}</p>
   {loading&&<p role="status">Loading saved time details…</p>}
   {!loading&&detail&&<p className={detail.stale?'font-semibold text-status-warning':'text-ink-secondary'}>Latest saved: {detail.regular_hours} regular + {detail.overtime_hours} OT hours · {detail.stale?'attendance changed; review required':'matches the attendance record when saved'} · note: {detail.note}</p>}
   {!loading&&!detail&&!error&&<p className="text-ink-secondary">No supplemental time details saved for this attendance record.</p>}
   {error&&<p role="alert" className="text-status-danger">{error} <button type="button" className="underline" onClick={()=>setError('')}>Dismiss</button></p>}
   {success&&<p role="status" className="text-status-success">{success}</p>}
   {!loading&&!readFailed&&<form onSubmit={submit} className="space-y-3">
    <div className="grid gap-3 sm:grid-cols-2"><Input label="Regular hours (maximum 8)" type="number" min="0" max="8" step="0.01" required value={regular} onChange={e=>{setRegular(e.target.value);setSuccess('');}}/><Input label="Overtime hours" type="number" min="0" max="24" step="0.01" required value={overtime} onChange={e=>{setOvertime(e.target.value);setSuccess('');}}/></div>
    <Input label="Reason / source of hours" maxLength={500} required value={note} onChange={e=>{setNote(e.target.value);setSuccess('');}}/>
    <div className="flex flex-wrap justify-end gap-2"><Button type="button" variant="secondary" disabled={saving} onClick={onClose}>Close</Button><Button type="submit" variant="primary" disabled={saving||!!success} isLoading={saving}>Save time details</Button></div>
   </form>}
  </div>
 </Modal>;
}
