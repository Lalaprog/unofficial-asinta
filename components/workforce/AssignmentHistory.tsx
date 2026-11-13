'use client';
import React,{useEffect,useRef,useState} from 'react';
import {Button} from '@/components/ui/Button';
import {createClient} from '@/lib/supabase/client';
import {parseAssignmentHistory,type AssignmentEvent} from '@/lib/workforce/assignmentHistory';
/** Founder-only display gate; database authorization remains mandatory. */
export function AssignmentHistory({workerId,workerName}:{workerId:string;workerName:string}){
 const [open,setOpen]=useState(false),[items,setItems]=useState<AssignmentEvent[]>([]),[more,setMore]=useState(false),[loading,setLoading]=useState(false),[error,setError]=useState(false);const busy=useRef(false),seq=useRef(0);
 useEffect(()=>{const sequence=seq;return()=>{sequence.current++;};},[]);
 async function load(cursor?:AssignmentEvent){
  if(busy.current)return;busy.current=true;setLoading(true);setError(false);const token=++seq.current;
  try{const {data,error}=await createClient().rpc('founder_assignment_history',{p_worker:workerId,p_cursor_at:cursor?.occurredAt??null,p_cursor_id:cursor?.id??null,p_limit:25});if(error)throw error;const page=parseAssignmentHistory(data,workerId,cursor);if(token===seq.current){setItems(prev=>cursor?[...prev,...page.items]:page.items);setMore(page.hasMore);}}
  catch{if(token===seq.current){setItems([]);setMore(false);setError(true);}}
  finally{if(token===seq.current){busy.current=false;setLoading(false);}}
 }
 function toggle(){if(open){seq.current++;busy.current=false;setOpen(false);setLoading(false);setItems([]);setMore(false);setError(false);}else{setOpen(true);void load();}}
 return <div className="basis-full text-xs text-ink-secondary"><Button type="button" size="sm" variant="ghost" aria-expanded={open} onClick={toggle}>Assignment history for {workerName}</Button>
 {open&&<div className="space-y-2 rounded-lg border border-surface-border bg-white p-3"><p>Recorded changes since history tracking began. Baseline entries show only the state observed at installation, not when an assignment started or ended. Project names are current.</p>
 {loading&&<p role="status">Loading assignment history…</p>}{error&&<p role="alert">Could not verify assignment history. No empty or partial result is assumed.</p>}
 {!loading&&!error&&(items.length?<ul className="space-y-2">{items.map(e=><li key={e.id} className="break-words"><strong>{e.projectName}</strong> · {e.type==='baseline_active'?'Active at baseline':e.type==='baseline_inactive'?'Inactive at baseline':e.type==='assigned'?'Assigned':'Unassigned'} · {e.occurredAt}{e.actorId&&<span className="break-all"> · actor ID {e.actorId}</span>}</li>)}</ul>:<p>No history returned; this does not prove the worker had no earlier projects.</p>)}
 <div className="flex gap-2"><Button type="button" size="sm" variant="secondary" disabled={loading} onClick={()=>void load()}>Refresh assignment history</Button>{more&&!loading&&!error&&<Button type="button" size="sm" variant="secondary" onClick={()=>void load(items.at(-1))}>Show older assignments</Button>}</div></div>}
 </div>;
}
