'use client';
import React,{useEffect,useRef,useState} from 'react';
import {Button} from '@/components/ui/Button';
import {Input} from '@/components/ui/Input';
import {Modal} from '@/components/ui/Modal';
import {createClient} from '@/lib/supabase/client';
import {formatPeso} from '@/lib/email/format';
import type {ProjectExpenseRow} from '@/lib/projects/expenseLedger';
import {parseRentalAttempt,rentalArguments,verifyRentalResult,verifyRentalStatus,type RentalAttempt} from '@/lib/projects/rentalConfirmation';

export function RentalConfirmation({projectId,userId,expenses,onRecorded}:{projectId:string;userId:string;expenses:ProjectExpenseRow[];onRecorded:()=>void}){
 const storageKey=`rental-confirmation:${userId}`;
 const [ready,setReady]=useState(false),[storageError,setStorageError]=useState(false),[pending,setPending]=useState<RentalAttempt|null>(null),[selected,setSelected]=useState<ProjectExpenseRow|null>(null);
 const [item,setItem]=useState(''),[supplier,setSupplier]=useState(''),[quantity,setQuantity]=useState('1'),[start,setStart]=useState(''),[end,setEnd]=useState(''),[ack,setAck]=useState(false),[discard,setDiscard]=useState(false);
 const [busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState('');const lock=useRef(false),alive=useRef(false),observedStorage=useRef<string|null>(null);
 useEffect(()=>{alive.current=true;try{const saved=sessionStorage.getItem(storageKey);observedStorage.current=saved;setPending(saved?parseRentalAttempt(JSON.parse(saved)):null);setStorageError(false);}catch{setStorageError(true);}setReady(true);return()=>{alive.current=false;};},[storageKey]);
 function finish(a:RentalAttempt){const saved=sessionStorage.getItem(storageKey);if(!saved||saved!==observedStorage.current||JSON.stringify(parseRentalAttempt(JSON.parse(saved)))!==JSON.stringify(a))throw new Error('Retry record changed');sessionStorage.removeItem(storageKey);observedStorage.current=null;if(alive.current){setPending(null);setSelected(null);setMessage('Rental link recorded. Refresh and review the expense ledger; no payment was made.');setError('');onRecorded();}}
 async function send(a:RentalAttempt){
  if(lock.current||storageError)return;lock.current=true;setBusy(true);setError('');setMessage('');let stored=false;
  try{const existing=sessionStorage.getItem(storageKey);if(pending){if(!existing||existing!==observedStorage.current||JSON.stringify(parseRentalAttempt(JSON.parse(existing)))!==JSON.stringify(a))throw new Error('Retry record changed');}else{if(existing!==null)throw new Error('An unresolved request exists');const serialized=JSON.stringify(a);sessionStorage.setItem(storageKey,serialized);if(sessionStorage.getItem(storageKey)!==serialized)throw new Error('Retry record not stored');observedStorage.current=serialized;}stored=true;if(alive.current){setPending(a);setSelected(null);}
   const {data,error}=await createClient().rpc('confirm_rental_expense',rentalArguments(a));if(error)throw error;verifyRentalResult(data,a);finish(a);
  }catch{if(alive.current)setError(stored?'Confirmation not verified. It may already be recorded; check or retry the same request.':'Could not save the retry record; no request was sent. Check previous requests before proceeding.');}
  finally{lock.current=false;if(alive.current)setBusy(false);}
 }
 async function check(){
  if(!pending||lock.current)return;lock.current=true;setBusy(true);setError('');setMessage('');
  try{const {data,error}=await createClient().rpc('rental_confirmation_status',{p_id:pending.id});if(error)throw error;
   if(verifyRentalStatus(data,pending))finish(pending);else if(alive.current)setMessage('No completed confirmation was found yet. The request could still be processing; check again or retry the same request.');
  }catch{if(alive.current)setError('Could not verify the exact confirmation. Keep the retry record and investigate.');}
  finally{lock.current=false;if(alive.current)setBusy(false);}
 }
 function prepare(){
  if(!selected||!ack||lock.current||pending||storageError)return;
  try{
   if(!/^\d+$/.test(quantity))throw new Error('Invalid quantity');
   const a=parseRentalAttempt({id:crypto.randomUUID(),expense:selected.id,project:projectId,amount:selected.amount.toFixed(2),date:selected.expense_date,description:selected.description,item:item.trim(),supplier:supplier.trim(),quantity:Number(quantity),start,end});void send(a);
  }catch{setError('Check item, supplier, quantity, dates and expense before confirming.');}
 }
 function stop(){try{const current=sessionStorage.getItem(storageKey);if(current!==observedStorage.current||current===null)throw new Error('Retry record changed');sessionStorage.removeItem(storageKey);observedStorage.current=null;setPending(null);setStorageError(false);setDiscard(false);setMessage('Retry stopped; this does not cancel or undo a request. Inspect the records before another confirmation.');}catch{setError('Could not clear the retry record; it may have changed. Investigate before proceeding.');}}
 return <section className="rounded-xl border border-surface-border bg-white p-4 space-y-3 text-xs text-ink-secondary"><h4 className="font-bold text-sm text-navy">Experimental rental confirmation</h4><p>Select a loaded equipment expense already recorded for this site. Verify the rental, amount and duplicates yourself. This links the existing expense; it does not record or send a payment. Linked financial details are locked and a correction workflow is not yet available.</p>
  {message&&<p role="status">{message}</p>}{error&&<p role="alert">{error}</p>}
  {storageError&&<p role="alert">Saved retry data is unreadable; new requests are blocked until investigated.</p>}
  {(pending||storageError)&&<div className="rounded-lg bg-status-warning-bg p-3 space-y-2"><p>A request may have been sent. Browser storage is tab-specific and may be cleared or unavailable.</p>{pending&&<><p className="break-all">Request {pending.id} · expense {pending.expense} · project {pending.project}</p><p className="break-words">{pending.description} · {formatPeso(Number(pending.amount))} · {pending.date}; {pending.item} · {pending.supplier} · quantity {pending.quantity} · {pending.start} to {pending.end}</p><div className="flex flex-wrap gap-2"><Button size="sm" variant="secondary" disabled={busy} onClick={()=>void check()}>Check confirmation</Button><Button size="sm" variant="secondary" disabled={busy} onClick={()=>void send(pending)}>Retry same request</Button></div></>}
   <Button size="sm" variant="ghost" disabled={busy} onClick={()=>setDiscard(v=>!v)}>Review stopping retry</Button>{discard&&<div><p>Stopping does not cancel a request or undo a link. Independently inspect and investigate before proceeding.</p><Button size="sm" variant="danger" disabled={busy} onClick={stop}>I checked; stop retrying</Button></div>}</div>}
  {ready&&!pending&&!storageError&&<div className="space-y-2">{expenses.filter(e=>e.project_id===projectId&&e.category==='equipment').map(e=><div key={e.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-surface-border pt-2"><span className="break-words">{e.description} · {formatPeso(e.amount)} · {e.expense_date}</span><Button size="sm" variant="secondary" disabled={busy} onClick={()=>{setSelected(e);setItem('');setSupplier('');setQuantity('1');setStart('');setEnd('');setAck(false);setError('');}}>Review rental link</Button></div>)}{!expenses.some(e=>e.project_id===projectId&&e.category==='equipment')&&<p>No equipment expenses loaded on this page. Load older expenses if needed.</p>}</div>}
  <Modal isOpen={!!selected} onClose={()=>setSelected(null)} title="Confirm rental expense link?" description="This does not create an expense or prove a payment." dismissOnBackdrop={!busy} dismissOnEscape={!busy} showCloseButton={!busy}>
   {selected&&<div className="space-y-3 text-xs text-ink-secondary"><p className="break-all">Expense {selected.id} · {selected.description} · {formatPeso(selected.amount)} · {selected.expense_date}</p><p>Confirm the rental is real, belongs to this site, and is not separately duplicated or Bale/payroll. This action locks expense financial details; corrections are not yet supported.</p>
    <Input label="Rental item" value={item} maxLength={160} onChange={e=>setItem(e.target.value)}/><Input label="Supplier" value={supplier} maxLength={160} onChange={e=>setSupplier(e.target.value)}/><Input label="Quantity" inputMode="numeric" value={quantity} onChange={e=>setQuantity(e.target.value)}/><Input label="Rental start" type="date" value={start} onChange={e=>setStart(e.target.value)}/><Input label="Rental end" type="date" value={end} onChange={e=>setEnd(e.target.value)}/>
    <label className="flex items-start gap-2"><input type="checkbox" checked={ack} onChange={e=>setAck(e.target.checked)}/> I checked the rental and expense and reviewed possible duplicates.</label><div className="flex justify-end gap-2"><Button size="sm" variant="secondary" disabled={busy} onClick={()=>setSelected(null)}>Cancel</Button><Button size="sm" disabled={busy||!ack} onClick={prepare}>Confirm rental link</Button></div></div>}
  </Modal>
 </section>;
}
