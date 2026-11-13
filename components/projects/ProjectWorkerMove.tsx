'use client';
import React,{useEffect,useRef,useState} from 'react';
import {Button} from '@/components/ui/Button';
import {createClient} from '@/lib/supabase/client';
import {parseWorkerMoveAttempt,verifyWorkerMoveResult,type WorkerMoveAttempt} from '@/lib/workforce/atomicWorkerMove';

type Choice={id:string;name:string};
/** Founder-only UI. DB independently verifies role, site, history and assignment. */
export function ProjectWorkerMove({actorId,projectId,workers,projects,onCompleted}:{actorId:string;projectId:string;workers:Choice[];projects:Choice[];onCompleted:()=>Promise<unknown>}) {
 const key=`worker-move:${actorId}:${projectId}`;
 const [open,setOpen]=useState(false),[ready,setReady]=useState(false),[storageError,setStorageError]=useState('');
 const [pending,setPending]=useState<WorkerMoveAttempt|null>(null),[worker,setWorker]=useState(''),[target,setTarget]=useState(''),[confirm,setConfirm]=useState(false),[stop,setStop]=useState(false);
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
 const lock=useRef(false),alive=useRef(false);
 useEffect(()=>{
  alive.current=true;
  try{const raw=sessionStorage.getItem(key);if(raw){setPending(parseWorkerMoveAttempt(JSON.parse(raw),actorId,projectId));setOpen(true);}setReady(true);}
  catch{setStorageError('Cannot read the saved move retry. New moves are blocked until the record is independently reviewed.');setReady(true);setOpen(true);}
  return()=>{alive.current=false;};
 },[actorId,projectId,key]);
 const send=async(attempt:WorkerMoveAttempt)=>{
  if(lock.current)return;lock.current=true;setBusy(true);setError('');setMessage('');
  let stored=false;
  try{
   sessionStorage.setItem(key,JSON.stringify(attempt));stored=true;if(alive.current)setPending(attempt);
   const {data,error:rpcError}=await createClient().rpc('move_worker_project',{p_request:attempt.requestId,p_worker:attempt.workerId,p_from:attempt.fromProject,p_to:attempt.toProject});
   if(rpcError)throw rpcError;
   const result=verifyWorkerMoveResult(data,attempt);
   sessionStorage.removeItem(key);
   if(alive.current){setPending(null);setConfirm(false);setWorker('');setTarget('');setMessage(result.replayed?'The original move was confirmed. Check both project teams.':'Move recorded. Check both project teams.');}
   try { await onCompleted(); } catch { if(alive.current)setMessage('Move confirmed, but the team refresh failed. Refresh both project teams.'); }
  }catch{
   if(alive.current)setError(stored?'The move outcome is not confirmed. It may already be recorded. Retry the same request or independently inspect both teams and history.':'Could not store a retry record, so no move was sent this time.');
  }finally{lock.current=false;if(alive.current)setBusy(false);}
 };
 function begin(e:React.FormEvent){
  e.preventDefault();if(lock.current||!ready||pending||storageError||!confirm||!workers.some(x=>x.id===worker)||!projects.some(x=>x.id===target&&x.id!==projectId))return;
  try{const attempt=parseWorkerMoveAttempt({requestId:crypto.randomUUID(),actorId,workerId:worker,fromProject:projectId,toProject:target},actorId,projectId);void send(attempt);}catch{setError('Could not prepare a secure move request.');}
 }
 function stopRetry(){
  if(!pending||!stop||busy)return;
  try{sessionStorage.removeItem(key);setPending(null);setStop(false);setConfirm(false);setMessage('Retry stopped; this did not undo a move. Refresh both project teams and review assignment history before proceeding.');}
  catch{setError('Could not clear the saved retry. New moves remain blocked.');}
 }
 return <section className="rounded-xl border border-surface-border bg-white p-3 text-xs space-y-3">
  <button type="button" aria-expanded={open} onClick={()=>setOpen(v=>!v)} className="min-h-11 font-semibold text-brand">{open?'Close worker move':'Move a worker to another project'}</button>
  {open&&<div className="space-y-3 border-t border-surface-border pt-3">
   <p className="text-ink-secondary">Experimental Founder-only move: both site changes are recorded together. Attendance, payroll and Bale are not changed. Review the current team and destination before confirming.</p>
   {storageError&&<p role="alert" className="text-status-danger">{storageError}</p>}{error&&<p role="alert" className="text-status-danger">{error}</p>}{message&&<p role="status">{message}</p>}
   {pending&&<div className="space-y-2 rounded-lg border border-status-warning/25 bg-status-warning-bg p-3">
    <p className="font-semibold">Unconfirmed move. The request may have been recorded.</p>
    <p className="break-all">Worker {pending.workerId} · from {pending.fromProject} · to {pending.toProject} · request {pending.requestId}</p>
    <p>Retry uses the same request. Inspect both project teams and assignment history; an earlier attempt may still be processing.</p>
    <div className="flex flex-wrap gap-2"><Button type="button" size="sm" variant="secondary" disabled={busy} onClick={()=>void send(pending)}>Retry same move</Button><Button type="button" size="sm" variant="ghost" disabled={busy} onClick={()=>setStop(v=>!v)}>Review before stopping retry</Button></div>
    {stop&&<div className="space-y-2"><p>Stopping a retry does not undo a move. Only continue after independently checking both teams and history.</p><Button type="button" size="sm" variant="danger" disabled={busy} onClick={stopRetry}>I checked; stop retrying</Button></div>}
   </div>}
   {!pending&&!storageError&&<form onSubmit={begin} className="space-y-3">
    <label className="block font-semibold text-navy">Worker on this project<select className="mt-1 block min-h-11 w-full rounded-lg border border-surface-border px-3" value={worker} disabled={busy||!ready} onChange={e=>{setWorker(e.target.value);setConfirm(false);}}><option value="">Choose worker</option>{workers.map(w=><option key={w.id} value={w.id}>{w.name}</option>)}</select></label>
    <label className="block font-semibold text-navy">Destination project<select className="mt-1 block min-h-11 w-full rounded-lg border border-surface-border px-3" value={target} disabled={busy||!ready} onChange={e=>{setTarget(e.target.value);setConfirm(false);}}><option value="">Choose destination</option>{projects.filter(p=>p.id!==projectId).map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
    <label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={confirm} onChange={e=>setConfirm(e.target.checked)} disabled={busy}/><span>I checked the worker and destination. This changes the current team, not past attendance.</span></label>
    <Button type="submit" size="sm" disabled={busy||!ready||!worker||!target||!confirm}>Confirm move</Button>
   </form>}
  </div>}
 </section>;
}
