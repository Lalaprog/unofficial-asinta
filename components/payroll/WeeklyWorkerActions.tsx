'use client';

import React,{useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {Button} from '@/components/ui/Button';
import {Input} from '@/components/ui/Input';
import {Modal} from '@/components/ui/Modal';
import {createClient} from '@/lib/supabase/client';
import {getManilaClock} from '@/lib/reminders/scheduler';
import {parseWeeklyDraftDetails,type WeeklyDraftDetails} from '@/lib/payroll/weeklyDraftDetails';
import type {WeeklyRow} from '@/lib/payroll/weeklyPreview';

type Action='generate'|'approve'|'pay';
/** Experimental only. Server-side authorization and complete coordinated schema are mandatory. */
export function WeeklyWorkerActions({row,start,end,userId,projects}:{row:WeeklyRow;start:string;end:string;userId:string;projects:{id:string;name:string}[]}) {
 const [details,setDetails]=useState<WeeklyDraftDetails|null>(null),[message,setMessage]=useState(''),[locked,setLocked]=useState(false),[saving,setSaving]=useState(false);
 const [confirm,setConfirm]=useState<Action|null>(null),[paymentDate,setPaymentDate]=useState(''),[ack,setAck]=useState(false);
 const busy=useRef(false),mounted=useRef(true);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 const existing=row.vouchers.length===1&&row.vouchers[0].period_start===start&&row.vouchers[0].period_end===end?row.vouchers[0]:null;
 const mayGenerate=row.vouchers.length===0&&row.net!==null&&row.days.some(d=>d.entries.length>0)&&!row.worker.possible_supervisor;
 async function read(id:string){
  const {data,error}=await createClient().rpc('weekly_worker_draft_details',{p_id:id});if(error)throw new Error(error.message);
  return parseWeeklyDraftDetails(data,{id,worker:row.worker.id,start});
 }
 function fail(e:unknown){setDetails(null);setLocked(true);setConfirm(null);setMessage(`Outcome not confirmed: ${e instanceof Error?e.message:'Unknown error'}. Refresh the weekly preview and inspect the voucher before retrying; do not make or repeat an external payment based on this message.`);}
 async function load(id:string){
  if(busy.current||locked)return;busy.current=true;setSaving(true);setMessage('');
  try{const value=await read(id);if(mounted.current)setDetails(value);}catch(e){if(mounted.current)fail(e);}
  finally{busy.current=false;if(mounted.current)setSaving(false);}
 }
 async function act(){
  if(!confirm||busy.current||locked)return;
  const action=confirm,old=details;
  if(action==='generate'&&!mayGenerate)return;
  if(action==='approve'&&(!old||old.status!=='draft'))return;
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
   }else if(action==='approve'){
    const {data,error}=await createClient().rpc('approve_weekly_worker_draft',{p_id:id});if(error)throw new Error(error.message);
    if(!data||!['updated','already_approved'].includes(data.outcome)||data.payroll?.id!==id||data.payroll?.status!=='approved')throw new Error('Approval response could not be verified');
   }else{
    const {data,error}=await createClient().rpc('record_weekly_worker_payment',{p_id:id,p_payment_date:paymentDate});if(error)throw new Error(error.message);
    if(!data||!['updated','already_recorded'].includes(data.outcome)||data.payroll?.id!==id||data.payroll?.status!=='paid'||data.payment_date!==paymentDate)throw new Error('Payment response could not be verified');
   }
   const updated=await read(id!);
   if(action==='generate'&&updated.status!=='draft'||action==='approve'&&updated.status!=='approved'||action==='pay'&&(updated.status!=='paid'||updated.payment_date!==paymentDate))throw new Error('Voucher state changed; review again');
   if(mounted.current){setDetails(updated);setConfirm(null);setAck(false);setPaymentDate('');setMessage(action==='generate'?'Draft recorded. Review its saved amounts before approval.':action==='approve'?'Approval recorded. A separate confirmation is required to record an external payment.':'External payment recorded. No money was transferred by this application.');}
  }catch(e){if(mounted.current)fail(e);}
  finally{busy.current=false;if(mounted.current)setSaving(false);}
 }
 if(!existing&&!mayGenerate)return null;
 return <div className="mt-3 space-y-2 border-t border-surface-border pt-2">
  <p className="font-semibold text-navy">Experimental weekly voucher</p>
  {!details&&(existing?<Button type="button" size="sm" variant="secondary" disabled={locked||saving} onClick={()=>load(existing.id)} isLoading={saving}>Load voucher details</Button>:<Button type="button" size="sm" variant="secondary" disabled={locked||saving} onClick={()=>setConfirm('generate')}>Review new draft</Button>)}
  {message&&<p role="status" className={locked?'text-status-danger':''}>{message}</p>}
  {details&&<div className="space-y-2">
   <p className="font-semibold">Saved status: {details.status} · {details.period_start} to {details.period_end}</p>
   <p>Regular {details.calculation.regular_hours} hrs · OT {details.calculation.overtime_hours} hrs · wages ₱{details.calculation.wage} · allowances ₱{details.calculation.allowance} · gross ₱{details.gross} · Bale ₱{details.bale} · net ₱{details.net}</p>
   <p>Unmarked dates: {details.calculation.unmarked_dates.length?details.calculation.unmarked_dates.join(', '):'none'}. Unmarked does not mean absent.</p>
   {details.payment_date&&<><p>Recorded external payment date: {details.payment_date}. This is not proof of transfer.</p><p>Project gross allocations (not combined expense totals):</p>{details.allocations.length?<ul>{details.allocations.map(a=><li key={a.project_id}>{projects.find(p=>p.id===a.project_id)?.name||`Site ID ${a.project_id}`}: ₱{a.gross} ({a.hours} hrs, wages ₱{a.wage}, allowances ₱{a.allowance})</li>)}</ul>:<p>No site allocation for a zero-work voucher.</p>}<p>Do not add these to expenses without reconciling Bale and other overlapping entries.</p></>}
   {details.status==='draft'&&<Button type="button" size="sm" variant="secondary" disabled={locked||saving} onClick={()=>setConfirm('approve')}>Review approval</Button>}
   {details.status==='approved'&&<Button type="button" size="sm" variant="secondary" disabled={locked||saving} onClick={()=>{setPaymentDate('');setAck(false);setConfirm('pay');}}>Review external payment</Button>}
  </div>}
  {typeof document!=='undefined'&&createPortal(<Modal isOpen={!!confirm} onClose={()=>setConfirm(null)} title={confirm==='generate'?'Create weekly draft?':confirm==='approve'?'Approve saved weekly voucher?':'Record an external payment?'} description="Review this worker and original period carefully. This application does not transfer money." dismissOnBackdrop={!saving} dismissOnEscape={!saving} showCloseButton={!saving}>
   {confirm&&<div className="space-y-3 text-sm text-ink-secondary">
    <p className="font-semibold text-navy">{row.worker.name} · {start} to {end}</p>
    {confirm==='generate'?<><p>Preview only: wages ₱{row.wage}, allowances ₱{row.allowance}, Bale ₱{row.bale}, net ₱{row.net}. The server recalculates the saved draft; review the result before approval.</p><p>Unmarked dates are not absences. Current rates may not be historical rates; review incomplete days, recorded Bale and all warnings.</p>{row.reviewReasons.map(reason=><p key={reason}>{reason}</p>)}</>:<><p>Saved gross ₱{details?.gross} · Bale ₱{details?.bale} · net ₱{details?.net}. Unmarked: {details?.calculation.unmarked_dates.join(', ')||'none'}.</p>{confirm==='approve'?<p>Confirm only after reviewing the source records and this saved voucher. Changes after generation can block approval.</p>:<><p>Record this only after the payment actually happened outside the application. No transfer is sent. A later correction requires separate original-period review.</p><Input label="Actual external payment date" type="date" min={start} max={getManilaClock().dateIso} value={paymentDate} onChange={e=>setPaymentDate(e.target.value)} /><label className="flex items-start gap-2"><input type="checkbox" checked={ack} onChange={e=>setAck(e.target.checked)} />I verified the external payment already occurred for this worker, amount and date.</label></>}</>}
    <div className="flex flex-wrap justify-end gap-2"><Button type="button" size="sm" variant="secondary" disabled={saving} onClick={()=>setConfirm(null)}>Cancel</Button><Button type="button" size="sm" isLoading={saving} disabled={saving||(confirm==='pay'&&(!ack||!paymentDate||paymentDate<start||paymentDate>getManilaClock().dateIso))} onClick={act}>{confirm==='generate'?'Create draft':confirm==='approve'?'Confirm approval':'Record payment'}</Button></div>
   </div>}
  </Modal>,document.body)}
 </div>;
}
