'use client';
import React, {useEffect,useRef,useState} from 'react';
import {Button} from '@/components/ui/Button';
import {Input} from '@/components/ui/Input';
import {Modal} from '@/components/ui/Modal';
import {createClient} from '@/lib/supabase/client';
import {parseAllowances,type AllowanceItem} from '@/lib/payroll/workerAllowances';
import type {HistoryRecord} from '@/lib/attendance/history';

export function AllowanceDialog({record,isFounder,onClose}:{record:HistoryRecord;isFounder:boolean;onClose:()=>void}) {
 const [items,setItems]=useState<AllowanceItem[]|null>(null),[loading,setLoading]=useState(true),[saving,setSaving]=useState(false);
 const [error,setError]=useState(''),[success,setSuccess]=useState(''),[amount,setAmount]=useState(''),[description,setDescription]=useState('');
 const seq=useRef(0),lock=useRef(false),request=useRef<{key:string;id:string}|null>(null);
 useEffect(()=>{const seqRef=seq;const token=++seqRef.current;setLoading(true);
  createClient().rpc('worker_allowances_for_attendance',{p_attendance:record.id}).then(({data,error})=>{
   if(token!==seqRef.current)return;
   try{if(error)throw new Error(error.message);setItems(parseAllowances(data));}catch(e){setItems(null);setError(`Could not load allowances: ${e instanceof Error?e.message:'Unknown error'}`);}finally{setLoading(false);}
  },()=>{if(token===seqRef.current){setItems(null);setError('Could not load allowances. Close and retry.');setLoading(false);}});
  return()=>{seqRef.current++;};
 },[record.id]);
 async function submit(e:React.FormEvent){
  e.preventDefault();if(lock.current||loading||items===null||error||!record.submitted_at)return;
  if(!/^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/.test(amount)||Number(amount)<=0||!description.trim()){setError('Enter a positive amount with at most two decimal places and a description.');return;}
  const key=JSON.stringify([record.id,record.submitted_at,amount,description.trim()]);
  if(!request.current||request.current.key!==key)request.current={key,id:crypto.randomUUID()};
  lock.current=true;setSaving(true);setError('');setSuccess('');const token=++seq.current;
  try{
   const {data,error:failure}=await createClient().rpc('submit_worker_allowance',{p_id:request.current.id,p_attendance:record.id,p_expected_submitted_at:record.submitted_at,p_amount:amount,p_description:description.trim()});
   if(failure)throw new Error(failure.message);
   if(!data||data.id!==request.current.id||typeof data.replayed!=='boolean'||!['pending','approved','rejected'].includes(data.status))throw new Error('Response could not be verified');
   if(token!==seq.current)return;
   setSuccess(data.status==='pending'?'Submitted for Founder approval. No payroll or payment was changed.':'Allowance recorded. No payroll or payment was changed.');
   const response=await createClient().rpc('worker_allowances_for_attendance',{p_attendance:record.id});
   if(token!==seq.current)return;
   if(response.error)throw new Error(`Saved, but could not refresh the allowance list: ${response.error.message}`);
   setItems(parseAllowances(response.data));
  }catch(e){if(token===seq.current)setError(`Result not fully confirmed: ${e instanceof Error?e.message:'Unknown error'}. Check the allowance list before retrying.`);}
  finally{if(token===seq.current){lock.current=false;setSaving(false);}}
 }
 return <Modal isOpen onClose={onClose} title="Worker allowances" description={`${record.worker_name||'Worker'} · ${record.date} · ${record.project_name||'Project site'}`} dismissOnBackdrop={!saving} dismissOnEscape={!saving} showCloseButton={!saving}>
  <div className="space-y-4 text-xs">
   <p className="rounded-xl border border-status-warning/25 bg-status-warning-bg p-3 leading-relaxed text-ink-secondary">{isFounder?'Your entry is recorded as approved.':'Your entry requires Founder approval.'} Allowances are not yet added to payroll or project costs, and approval does not pay anyone. Dates covered by approved or paid payroll require a separate correction.</p>
   {loading&&<p role="status">Loading allowances…</p>}
   {items&&<div className="space-y-2"><p className="font-semibold text-navy">Saved for this attendance</p>{items.length?items.map(i=><div key={i.id} className="rounded-lg border border-surface-border p-2"><span className="font-semibold">₱{i.amount} · {i.status}</span> · {i.description}{i.stale&&<span className="font-semibold text-status-warning"> · attendance changed; review required</span>}</div>):<p className="text-ink-secondary">No allowances recorded.</p>}</div>}
   {error&&<p role="alert" className="text-status-danger">{error} <button type="button" className="underline" onClick={()=>setError('')}>Dismiss</button></p>}
   {success&&<p role="status" className="text-status-success">{success}</p>}
   {!loading&&items!==null&&<form onSubmit={submit} className="space-y-3"><Input label="Allowance amount (₱)" type="number" min="0.01" max="99999999.99" step="0.01" required value={amount} onChange={e=>{setAmount(e.target.value);setSuccess('');}}/><Input label="Allowance purpose" maxLength={500} required value={description} onChange={e=>{setDescription(e.target.value);setSuccess('');}}/><div className="flex flex-wrap justify-end gap-2"><Button type="button" variant="secondary" disabled={saving} onClick={onClose}>Close</Button><Button type="submit" variant="primary" disabled={saving||!!success} isLoading={saving}>{isFounder?'Record approved allowance':'Submit for approval'}</Button></div></form>}
  </div>
 </Modal>;
}
