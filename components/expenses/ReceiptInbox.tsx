'use client';
import React, {useCallback,useEffect,useRef,useState} from 'react';
import {Button} from '@/components/ui/Button';
import {createClient} from '@/lib/supabase/client';
import {parseReceiptItem,parseReceiptPage,prepareInboxItem,uploadAndFinishInbox,type ReceiptInboxItem} from '@/lib/expenses/receiptInbox';

type Prepared=Awaited<ReturnType<typeof prepareInboxItem>>;
type Attempt={metadata:Prepared;file:File};
export function ReceiptInbox({userId,canUse,canScan,onUse,onScan,onView}:{userId:string;canUse:boolean;canScan:boolean;onUse:(item:ReceiptInboxItem)=>void;onScan:(item:ReceiptInboxItem)=>void;onView:(path:string)=>void}) {
 const [open,setOpen]=useState(false),[items,setItems]=useState<ReceiptInboxItem[]>([]),[more,setMore]=useState(false),[loading,setLoading]=useState(false),[error,setError]=useState('');
 const [busy,setBusy]=useState(false),[attempt,setAttempt]=useState<Attempt|null>(null),[message,setMessage]=useState('');
 const seq=useRef(0),lock=useRef(false),mounted=useRef(true);
 useEffect(()=>{mounted.current=true;return ()=>{mounted.current=false;seq.current+=1}},[]);
 const load=useCallback(async(cursor?:ReceiptInboxItem)=>{
  const token=++seq.current;setLoading(true);setError('');
  try{
   const {data,error:err}=await createClient().rpc('receipt_photo_inbox_page',{p_cursor_at:cursor?.created_at??null,p_cursor_id:cursor?.id??null,p_limit:20});
   if(err) throw err;const page=parseReceiptPage(data,cursor);
   if(!mounted.current || token!==seq.current)return;
   setItems(old=>cursor?[...old,...page.items]:page.items);setMore(page.hasMore);
  }catch{if(mounted.current && token===seq.current)setError('Saved photos could not be loaded. Try again.');}
  finally{if(mounted.current && token===seq.current)setLoading(false);}
 },[]);
 useEffect(()=>{if(open)void load();else{seq.current+=1;setItems([]);setMore(false);setError('');}},[open,load]);
 const save=async(work:Attempt)=>{
  if(lock.current)return;lock.current=true;setBusy(true);setMessage('');
  try{
   const db=createClient();
   let record:ReceiptInboxItem | null=null;
   try {
    const {data,error:insertError}=await db.from('receipt_photo_inbox').insert(work.metadata).select('*').maybeSingle();
    if(!insertError && data) record=parseReceiptItem(data);
   } catch { /* Check by stable ID before deciding it failed. */ }
   if(!record){const {data,error:checkError}=await db.from('receipt_photo_inbox').select('*').eq('id',work.metadata.id).maybeSingle();if(!checkError && data) record=parseReceiptItem(data);}
   if(!record || record.id!==work.metadata.id || record.saved_by!==userId || record.object_path!==work.metadata.object_path || record.sha256!==work.metadata.sha256 || record.file_name!==work.metadata.file_name || record.file_size!==work.metadata.file_size || record.mime_type!==work.metadata.mime_type) throw new Error('The photo save could not be confirmed. Retry or refresh the inbox before starting again.');
   if(record.status!=='ready' && !await uploadAndFinishInbox(db,record,work.file)) throw new Error('Upload not confirmed. Retry this photo or refresh to recover its pending entry.');
   if(mounted.current){setAttempt(null);setMessage('Photo saved. It is not an expense.');await load();}
  }catch(err){if(mounted.current)setMessage(err instanceof Error?err.message:'Photo save could not be confirmed.');}
  finally{lock.current=false;if(mounted.current)setBusy(false);}
 };
 const start=async(file:File)=>{
  if(lock.current || attempt)return;
  lock.current=true;setBusy(true);setMessage('');
  try{const metadata=await prepareInboxItem(userId,file);const work={metadata,file};if(mounted.current){setAttempt(work);lock.current=false;setBusy(false);await save(work);}}
  catch(err){if(mounted.current)setMessage(err instanceof Error?err.message:'Could not prepare this photo.');}
  finally{lock.current=false;if(mounted.current)setBusy(false);}
 };
 const resume=async(item:ReceiptInboxItem,file:File)=>{
  if(lock.current || attempt)return;lock.current=true;setBusy(true);setMessage('');
  try {if(item.saved_by!==userId) throw new Error('Only the Founder who started this upload can finish it.');
   const complete=await uploadAndFinishInbox(createClient(),item,file);
   if(!complete)throw new Error('Upload not confirmed. Select the same photo and retry.');
   if(mounted.current){setMessage('Photo saved. It is not an expense.');await load();}
  }catch(err){if(mounted.current)setMessage(err instanceof Error?err.message:'Upload could not be confirmed.');}
  finally{lock.current=false;if(mounted.current)setBusy(false);}
 };
 return <section className="rounded-xl border border-surface-border bg-white p-4 space-y-3" aria-label="Saved receipt photos">
  <div className="flex flex-wrap items-center justify-between gap-2"><div><h2 className="text-sm font-bold text-navy">Saved receipt photos</h2><p className="text-xs text-ink-secondary">Keep separate photos for later; a photo alone is not an expense.</p></div><Button type="button" variant="secondary" size="sm" disabled={busy} onClick={()=>setOpen(!open)}>{open?'Close photos':'Open photos'}</Button></div>
  {open && <div className="space-y-3">
   <p className="text-xs text-ink-secondary">Save one photo at a time. Choose a saved photo for manual entry or scan it with AI. Scanning sends the photo to Groq (maximum 4 MB); review every suggestion. Saved copies remain available after use; check for duplicate expenses.</p>
   <label className={`inline-flex min-h-11 items-center rounded-lg border border-brand px-3 text-xs font-semibold text-brand ${busy || attempt?'opacity-50':'cursor-pointer'}`}>Save photo for later<input type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" disabled={busy || Boolean(attempt)} onChange={event=>{const file=event.target.files?.[0];event.target.value='';if(file)void start(file)}} /></label>
   {busy && <p role="status" className="text-xs text-ink-secondary">Saving photo…</p>}
   {message && <p role="status" className="text-xs text-ink-secondary">{message}</p>}
   {attempt && !busy && <div className="flex flex-wrap items-center gap-2 text-xs text-ink-secondary"><span>Unconfirmed: {attempt.metadata.file_name}. Retrying uses the same photo ID.</span><Button type="button" size="sm" variant="secondary" onClick={()=>void save(attempt)}>Retry photo save</Button><Button type="button" size="sm" variant="ghost" onClick={()=>{setAttempt(null);void load();}}>Stop retrying and check inbox</Button></div>}
   <div className="flex flex-wrap items-center gap-2"><Button type="button" variant="secondary" size="sm" disabled={loading || busy} onClick={()=>void load()}>Refresh photos</Button>{!canUse && <span className="text-xs text-ink-secondary">Finish or discard the current entry or draft before using a saved photo.</span>}</div>
   {loading && <p role="status" className="text-xs text-ink-secondary">Loading saved photos…</p>}
   {error && <div role="alert" className="text-xs text-status-danger">{error} <Button type="button" variant="secondary" size="sm" onClick={()=>void load()}>Retry photos</Button></div>}
   {!loading && !error && !items.length && <p className="text-xs text-ink-secondary">No saved photos yet.</p>}
   <div className="divide-y divide-surface-border/70">{items.map(item=><div key={item.id} className="flex flex-wrap items-center justify-between gap-2 py-3 text-xs">
    <div className="min-w-0"><div className="font-semibold break-words text-navy">{item.file_name}</div><div className="text-ink-secondary">{item.status==='ready'?'Saved photo':'Upload pending'} · {new Date(item.created_at).toLocaleString('en-PH',{timeZone:'Asia/Manila'})}</div></div>
    {item.status==='ready'?<div className="flex flex-wrap gap-2"><Button type="button" variant="secondary" size="sm" onClick={()=>onView(item.object_path)}>View</Button><Button type="button" variant="secondary" size="sm" disabled={!canScan || busy} onClick={()=>onScan(item)}>Scan with AI</Button><Button type="button" variant="primary" size="sm" disabled={!canUse || busy} onClick={()=>onUse(item)}>Use in expense</Button></div> : item.saved_by===userId ? <label className={`rounded-lg border border-brand px-3 py-2 font-semibold text-brand ${busy||attempt?'opacity-50':'cursor-pointer'}`}>Resume with same photo<input type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" disabled={busy||Boolean(attempt)} onChange={event=>{const file=event.target.files?.[0];event.target.value='';if(file)void resume(item,file)}} /></label> : <span className="text-ink-secondary">The Founder who started this upload must finish it.</span>}
   </div>)}</div>
   {more && !error && <Button type="button" variant="secondary" size="sm" disabled={loading || busy} onClick={()=>{const last=items.at(-1);if(last)void load(last);}}>Show older photos</Button>}
  </div>}
 </section>;
}
