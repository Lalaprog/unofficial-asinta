'use client';

import React,{useEffect,useRef,useState} from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { createClient } from '@/lib/supabase/client';
import { categoryWorkforceEnabled,parseCategoryAttempt,parseCategoryCatalog,parseCategoryHistory,parseCategoryResult,prepareCategoryAttempt,type CategoryAction,type CategoryAttempt,type CategoryEvent,type WorkerCategory } from '@/lib/workforce/categoryCatalog';
import {CATEGORY_CHANGED} from '@/lib/workforce/useActiveCategories';

/** Founder-only management; the database enforces authorization. */
export function WorkerCategoryManager({userId}:{userId:string}) {
 const [open,setOpen]=useState(false);
 return <section className="rounded-2xl border border-surface-border bg-white p-4">
  <button type="button" aria-expanded={open} onClick={()=>setOpen(v=>!v)} className="min-h-11 w-full text-left text-sm font-semibold text-navy">Worker category catalog {open?'▴':'▾'}</button>
  {open&&<CategoryContents key={userId} userId={userId}/>}
 </section>;
}
function CategoryContents({userId}:{userId:string}) {
 const storageKey=`worker-category-attempt:${userId}`;
 const [catalog,setCatalog]=useState<WorkerCategory[]|null>(null),[name,setName]=useState(''),[edit,setEdit]=useState<{category:WorkerCategory;name:string}|null>(null);
 const [pending,setPending]=useState<CategoryAttempt|null>(null),[storageReady,setStorageReady]=useState(false),[storageError,setStorageError]=useState('');
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState(''),[confirmDiscard,setConfirmDiscard]=useState(false);
 const lock=useRef(false),alive=useRef(true);
 useEffect(()=>{
  alive.current=true;
  try {const raw=sessionStorage.getItem(storageKey);if(raw)setPending(parseCategoryAttempt(JSON.parse(raw)));setStorageReady(true);}
  catch {setStorageReady(true);setStorageError('This browser could not read the saved retry record. New changes are blocked; inspect the catalog and history before clearing the local record.');}
  return()=>{alive.current=false;};
 },[storageKey]);
 async function load(){
  if(lock.current||!storageReady)return;
  lock.current=true;setBusy(true);setError('');setCatalog(null);setEdit(null);
  try{const {data,error:rpcError}=await createClient().rpc('worker_category_catalog');if(rpcError)throw rpcError;const parsed=parseCategoryCatalog(data);if(alive.current)setCatalog(parsed);}
  catch{if(alive.current)setError('Could not verify the catalog. Retry before making changes.');}
  finally{lock.current=false;if(alive.current)setBusy(false);}
 }
 async function send(attempt:CategoryAttempt){
  if(lock.current)return;
  lock.current=true;setBusy(true);setError('');setMessage('');setPending(attempt);
  let stored=false;
  try{
   // Persist before sending; if storage fails, do not issue the mutation.
   sessionStorage.setItem(storageKey,JSON.stringify(attempt));stored=true;
   const {data,error:rpcError}=await createClient().rpc('change_worker_category',{p_request_id:attempt.requestId,p_category_id:attempt.categoryId,p_action:attempt.action,p_label:attempt.label,p_expected_revision:attempt.expectedRevision});
   if(rpcError)throw rpcError;
   const result=parseCategoryResult(data,attempt);
   sessionStorage.removeItem(storageKey);
   window.dispatchEvent(new Event(CATEGORY_CHANGED));
   if(alive.current){setPending(null);setCatalog(null);setEdit(null);setName('');setMessage(result.replayed?'The original request was confirmed. Refresh the catalog before another change.':'Change recorded. Refresh the catalog before another change.');}
  }catch{
   if(alive.current)setError(stored?'The outcome is not confirmed. The change may have been saved. Retry the same request, or inspect the catalog and history before stopping the retry.':'The retry record could not be stored, so no request was sent this time. A previous attempt may still have been saved; inspect the catalog and history.');
  }finally{lock.current=false;if(alive.current)setBusy(false);}
 }
 function begin(action:CategoryAction,category:WorkerCategory|null,label:string){
  if(lock.current||pending||!catalog||!storageReady||storageError)return;
  try{const attempt=prepareCategoryAttempt(action,category,label);void send(attempt);}catch(e){setError(e instanceof Error?e.message:'Could not prepare the change.');}
 }
 function discard(){
  if(!confirmDiscard||busy||!pending)return;
  try{sessionStorage.removeItem(storageKey);setPending(null);setCatalog(null);setError('');setMessage('Retry stopped. Refresh the catalog and inspect category history before deciding whether to make another change.');setConfirmDiscard(false);}
  catch{setError('Could not clear the saved retry. No new changes are available.');}
 }
 return <div className="space-y-4 border-t border-surface-border pt-4 text-xs">
  <p className="rounded-lg bg-status-warning-bg p-3 text-ink-secondary">{categoryWorkforceEnabled()?'Only the Founder can change these categories. Renaming updates current worker craft labels and may require unpaid payroll drafts to be reviewed again; paid records are not rewritten. Archived categories remain on existing workers but cannot be chosen for new registrations. Refresh workforce after changes.':'Experimental catalog only. This does not change existing worker positions, historic records, worker registration or craft groups. Categories are not yet used by the workforce screens.'}</p>
  {storageError&&<p role="alert" className="text-status-danger">{storageError}</p>}
  {error&&<p role="alert" className="text-status-danger">{error}</p>}{message&&<p role="status" className="text-ink-secondary">{message}</p>}
  {pending&&<div className="space-y-2 rounded-lg border border-status-warning/25 bg-status-warning-bg p-3">
   <p className="font-semibold text-navy">Unconfirmed {pending.action} request. The server may already have saved it.</p>
   <p className="break-all">Request ID: {pending.requestId} · Category ID: {pending.categoryId}{pending.label?` · Name: ${pending.label}`:''}</p>
   <p>Retry uses the same request ID. A previous attempt may still be processing: wait, refresh the catalog and inspect its history before stopping the retry. Starting a new request can have a different outcome.</p>
   <div className="flex flex-wrap gap-2"><Button size="sm" variant="secondary" isLoading={busy} onClick={()=>void send(pending)}>Retry same request</Button><Button size="sm" variant="ghost" disabled={busy} onClick={()=>setConfirmDiscard(v=>!v)}>Review before stopping retry</Button></div>
   {confirmDiscard&&<div className="space-y-2"><p>After independently checking the category and its history, you can stop this retry. This does not undo any server change.</p><Button size="sm" variant="danger" disabled={busy} onClick={discard}>I checked; stop retrying</Button></div>}
  </div>}
  <div className="flex flex-wrap gap-2"><Button type="button" variant="secondary" size="sm" disabled={busy||!storageReady} onClick={()=>void load()}>{catalog?'Refresh catalog':'Load catalog'}</Button></div>
  {busy&&<p role="status">Contacting server…</p>}
  {catalog&&<>
   <form className="flex flex-col items-end gap-2 sm:flex-row" onSubmit={e=>{e.preventDefault();begin('add',null,name);}}><Input label="New category" maxLength={80} value={name} onChange={e=>setName(e.target.value)} disabled={busy||!!pending||!!storageError}/><Button type="submit" size="sm" disabled={busy||!!pending||!!storageError||!name.trim()}>Add category</Button></form>
   {catalog.length===0?<p>No categories are recorded in this catalog.</p>:<ul className="space-y-2">{catalog.map(c=><li key={c.id} className="space-y-2 rounded-lg border border-surface-border p-3">
    <div className="flex flex-wrap items-center justify-between gap-2"><span className="break-words font-semibold text-navy">{c.label}{c.archived?' · archived':''}</span><span>Revision {c.revision}</span></div>
    {edit?.category.id===c.id&&<form className="flex flex-col items-end gap-2 sm:flex-row" onSubmit={e=>{e.preventDefault();begin('rename',c,edit.name);}}><Input label={`Rename ${c.label}`} maxLength={80} value={edit.name} onChange={e=>setEdit({...edit,name:e.target.value})} disabled={busy||!!pending}/><Button size="sm" type="submit" disabled={busy||!!pending||!edit.name.trim()||edit.name.trim()===c.label}>Save name</Button><Button size="sm" type="button" variant="ghost" disabled={busy||!!pending} onClick={()=>setEdit(null)}>Cancel</Button></form>}
    <div className="flex flex-wrap gap-2">{!c.archived&&<Button size="sm" variant="secondary" disabled={busy||!!pending||!!storageError} onClick={()=>setEdit({category:c,name:c.label})}>Rename {c.label}</Button>}
     <CategoryStateAction category={c} disabled={busy||!!pending||!!storageError} onConfirm={()=>begin(c.archived?'restore':'archive',c,'')}/></div>
    <CategoryHistory categoryId={c.id} disabled={busy}/>
   </li>)}</ul>}
  </>}
 </div>;
}
function CategoryStateAction({category,disabled,onConfirm}:{category:WorkerCategory;disabled:boolean;onConfirm:()=>void}) {
 const [confirm,setConfirm]=useState(false),action=category.archived?'Restore':'Archive';
 return confirm?<span className="flex flex-wrap items-center gap-2"><span>{action} {category.label}? Existing workers will not be changed.</span><Button size="sm" variant="secondary" disabled={disabled} onClick={()=>{setConfirm(false);onConfirm();}}>Confirm {action.toLowerCase()}</Button><Button size="sm" variant="ghost" disabled={disabled} onClick={()=>setConfirm(false)}>Cancel</Button></span>:<Button size="sm" variant="secondary" disabled={disabled} onClick={()=>setConfirm(true)}>{action} {category.label}</Button>;
}
function CategoryHistory({categoryId,disabled}:{categoryId:string;disabled:boolean}) {
 const [open,setOpen]=useState(false),[items,setItems]=useState<CategoryEvent[]|null>(null),[more,setMore]=useState(false),[error,setError]=useState(''),[loading,setLoading]=useState(false);
 const lock=useRef(false),alive=useRef(true);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 async function load(next:boolean){
  if(lock.current||disabled)return;const last=next?items?.[items.length-1]:null;if(next&&!last)return;
  lock.current=true;setLoading(true);setError('');if(!next)setItems(null);
  try{const {data,error:rpcError}=await createClient().rpc('worker_category_history',{p_category_id:categoryId,p_before_at:last?.occurred_at??null,p_before_id:last?.request_id??null});if(rpcError)throw rpcError;
   const page=parseCategoryHistory(data);const existing=next?items??[]:[];const ids=new Set(existing.map(e=>e.request_id));if(page.items.some(e=>ids.has(e.request_id)))throw new Error('Duplicate event');
   if(alive.current){setItems([...existing,...page.items]);setMore(page.has_more);}
  }catch{if(alive.current)setError('History could not be verified. Retry before relying on it.');}
  finally{lock.current=false;if(alive.current)setLoading(false);}
 }
 return <div><button type="button" className="min-h-11 text-left font-semibold text-navy underline" aria-expanded={open} onClick={()=>setOpen(v=>!v)}>Category change history</button>
  {open&&<div className="space-y-2"><p>Events show recorded catalog changes, not historical worker assignments.</p><Button size="sm" variant="secondary" disabled={disabled||loading} onClick={()=>void load(false)}>{items?'Refresh history':'Load history'}</Button>
   {loading&&<p role="status">Loading category history…</p>}{error&&<p role="alert" className="text-status-danger">{error}</p>}
   {items&&(!items.length?<p>No events returned.</p>:<ul className="space-y-1">{items.map(event=><li key={event.request_id} className="break-words rounded bg-surface-inset p-2">{event.occurred_at} · {event.action} · {event.before_label??'New'} → {event.after_label}{event.after_archived?' (archived)':''} · revision {event.after_revision}<div className="break-all">Actor ID {event.actor_id} · request ID {event.request_id}</div></li>)}</ul>)}
   {items&&more&&!error&&<Button size="sm" variant="secondary" disabled={disabled||loading} onClick={()=>void load(true)}>Show more history</Button>}
  </div>}
 </div>;
}
