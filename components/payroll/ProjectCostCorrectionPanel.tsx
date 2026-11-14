'use client';
import React,{useEffect,useRef,useState} from 'react';
import {Button} from '@/components/ui/Button';
import {Input} from '@/components/ui/Input';
import {Select} from '@/components/ui/Select';
import {Modal} from '@/components/ui/Modal';
import {useAuth} from '@/lib/auth/authContext';
import {createClient} from '@/lib/supabase/client';
import {parseAttributionProjects,sameAttributionEvidence,type AttributionProject} from '@/lib/payroll/historicalAttribution';
import {correctionArguments,parseCorrectionAttempt,parseCorrectionReview,type CorrectionAttempt,type CorrectionCase,type CorrectionKind,type CorrectionReview} from '@/lib/payroll/projectCostCorrection';

type Line={project_id:string;gross_change:string};
/** Disabled by default. Evidence only; does not post costs or change paid periods. */
export function ProjectCostCorrectionPanel({actor,kind,item}:{actor:string;kind:CorrectionKind;item:CorrectionCase}){
 const {user,isFounder,assurance}=useAuth();const access=!!user&&user.id===actor&&isFounder&&assurance==='ready';
 const scope=JSON.stringify([actor,kind,item.id,item,access]);const storageKey=JSON.stringify(['project-cost-correction-v1',actor,kind,item.id]);
 const [expanded,setExpanded]=useState(false),[ready,setReady]=useState(false),[storageError,setStorageError]=useState(false),[pending,setPending]=useState<CorrectionAttempt|null>(null),[stop,setStop]=useState(false);
 const [projects,setProjects]=useState<AttributionProject[]|null>(null),[review,setReview]=useState<CorrectionReview|null>(null),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
 const [gross,setGross]=useState(''),[lines,setLines]=useState<Line[]>([]),[note,setNote]=useState(''),[dialog,setDialog]=useState<CorrectionAttempt|null>(null),[ack,setAck]=useState(false);
 const alive=useRef(false),lock=useRef(false),seq=useRef(0),current=useRef(scope);current.current=scope;
 useEffect(()=>{const sequence=seq;sequence.current++;alive.current=true;setExpanded(false);setReady(false);setStorageError(false);setPending(null);setReview(null);setProjects(null);setDialog(null);setGross('');setLines([]);setNote('');setAck(false);setStop(false);setBusy(lock.current);setMessage(lock.current?'A previous request may still complete. Investigate it before proceeding.':'');
  if(access){try{const saved=sessionStorage.getItem(storageKey);if(saved)setPending(parseCorrectionAttempt(JSON.parse(saved),actor,kind,item));}catch{setStorageError(true);}setReady(true);}
  return()=>{alive.current=false;sequence.current++;};
 // Parent keys the component by case and identity; avoid resetting for equal object instances.
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[scope,storageKey]);
 const live=(token:number)=>alive.current&&seq.current===token&&current.current===scope;
 async function load(){if(!access||lock.current)return;lock.current=true;setBusy(true);setMessage('');setProjects(null);setReview(null);const token=++seq.current;
  try{const client=createClient();const [a,b]=await Promise.all([client.rpc('historical_worker_attribution_projects'),client.rpc('project_cost_correction_attribution',{p_kind:kind,p_case:item.id,p_revision:null})]);if(a.error||b.error)throw Error('Unavailable');
   const catalog=parseAttributionProjects(a.data),data=parseCorrectionReview(b.data,kind,item);if(live(token)){setProjects(catalog);setReview(data);}
  }catch{if(live(token))setMessage('Case, original evidence or project catalog could not be verified. Reload the case history and investigate.');}
  finally{lock.current=false;if(alive.current)setBusy(false);}}
 function prepare(){if(!access||!ready||storageError||pending||lock.current||!review||!projects||review.attribution?.case_changed)return;try{
  const attempt=parseCorrectionAttempt({actor,request:crypto.randomUUID(),kind,case_id:item.id,expected_revision:review.latest_revision,expected_case:review.case,gross_change:gross,split:lines,note:note.trim()},actor,kind,item);
  if(attempt.split.some(line=>!projects.some(p=>p.id.toLowerCase()===line.project_id)))throw Error('Select available sites');setAck(false);setDialog(attempt);setMessage('');
 }catch(e){setMessage(e instanceof Error?e.message:'Check the amounts and evidence note.');}}
 async function send(attempt:CorrectionAttempt){if(!access||!ready||storageError||lock.current)return;lock.current=true;setBusy(true);setMessage('');const token=++seq.current;let stored=false;
  try{const a=parseCorrectionAttempt(attempt,actor,kind,item);const prior=sessionStorage.getItem(storageKey);if(prior&&!sameAttributionEvidence(parseCorrectionAttempt(JSON.parse(prior),actor,kind,item),a))throw Error('Different retry');
   if(!prior)sessionStorage.setItem(storageKey,JSON.stringify(a));const storedValue=sessionStorage.getItem(storageKey);if(!storedValue||!sameAttributionEvidence(parseCorrectionAttempt(JSON.parse(storedValue),actor,kind,item),a))throw Error('Storage');stored=true;if(live(token)){setPending(a);setDialog(null);}
   const {data,error}=await createClient().rpc('record_project_cost_correction_attribution',correctionArguments(a));if(error)throw error;
   if(!data||data.request_id!==a.request||data.source_kind!==a.kind||data.case_id!==a.case_id||data.revision!==a.expected_revision+1||typeof data.replayed!=='boolean')throw Error('Unverified response');
   if(!live(token))return;const saved=sessionStorage.getItem(storageKey);if(!saved||!sameAttributionEvidence(parseCorrectionAttempt(JSON.parse(saved),actor,kind,item),a))throw Error('Retry changed');sessionStorage.removeItem(storageKey);
   if(live(token)){setPending(null);setReview(null);setProjects(null);setLines([]);setGross('');setNote('');setMessage('Evidence recorded. Reload to review it. No project cost, payment or payroll was changed.');}
  }catch{if(live(token)){setDialog(null);setReview(null);setProjects(null);setMessage(stored?'Outcome not confirmed. It may already be recorded or still in flight; investigate or retry exactly.':'Retry storage could not be verified; no request was sent.');if(!stored)setStorageError(true);}}
  finally{lock.current=false;if(alive.current)setBusy(false);}}
 function stopRetry(){try{sessionStorage.removeItem(storageKey);setPending(null);setStorageError(false);setStop(false);setReview(null);setProjects(null);setMessage('Retry stopped. This cannot cancel or undo a request; investigate all revisions before another decision.');}catch{setMessage('Could not clear retry data.');}}
 if(!access)return null;
 return <div className="mt-3 space-y-2 border-t border-surface-border pt-3">
  <button type="button" className="min-h-11 font-semibold text-brand underline" aria-expanded={expanded} onClick={()=>setExpanded(x=>!x)}>Project-cost correction evidence</button>
  {expanded&&<div className="space-y-3"><p>Review the <strong>gross cost effect</strong> separately from the net case difference. No-transfer decisions can still affect costs. This records evidence only: it does not post costs or move money. Existing project reviews remain unchanged.</p>
   <p>Check original records, every case, source attribution and potential duplicate expenses. Other cases and overlaps may change while you review; this screen cannot prove completeness.</p>
   {message&&<p role="status">{message}</p>}{!ready&&<p>Checking retry data…</p>}
   {(pending||storageError)&&<div className="space-y-2 rounded-lg bg-status-warning-bg p-3"><p>A request may still complete. Tab retry data contains sensitive evidence and can be lost; a missing result does not prove failure.</p>
    {pending&&<><p className="break-all">Request {pending.request} · case {pending.case_id} · revision {pending.expected_revision+1} · gross change ₱{pending.gross_change}</p><p>{pending.split.length?pending.split.map(x=>`${x.project_id}: ₱${x.gross_change}`).join(' · '):'No project changes'} · {pending.note}</p><Button type="button" size="sm" variant="secondary" disabled={busy} onClick={()=>void send(pending)}>Retry exact correction evidence</Button></>}
    <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={()=>setStop(v=>!v)}>Review stopping correction retry</Button>{stop&&<div><p>Stopping does not cancel or undo an action.</p><Button type="button" variant="danger" size="sm" disabled={busy} onClick={stopRetry}>I investigated; stop correction retry</Button></div>}</div>}
   {!pending&&!storageError&&<Button type="button" variant="secondary" size="sm" disabled={!ready||busy} onClick={()=>void load()}>Load correction evidence</Button>}
   {projects&&review&&<div className="space-y-3"><p>Original case: {item.status.replace('_',' ')} · net difference ₱{item.difference} · {item.reason}.</p>
    {review.attribution?<div className="rounded-lg border border-surface-border p-3"><p>Latest full replacement · revision {review.attribution.revision} · gross change ₱{review.attribution.gross_change}</p><ul>{review.attribution.split.map(line=><li key={line.project_id}>{projects.find(p=>p.id.toLowerCase()===line.project_id)?.name||line.project_id} · ₱{line.gross_change}</li>)}</ul><p>{review.attribution.split.length===0?'No project changes. ':''}{review.attribution.note}</p><p>Recorded by {review.attribution.recorded_by} at {review.attribution.recorded_at}.</p>{review.attribution.case_changed&&<p role="alert">Case evidence changed. Investigate before another revision.</p>}</div>:<p>No correction site evidence has been recorded for this case.</p>}
    {!review.attribution?.case_changed&&<><p>Each new revision replaces the full previous split; it is not an additional amount. A zero total may have no sites or balanced positive and negative site changes.</p>
     <Input label="Total signed gross change (₱)" inputMode="decimal" value={gross} onChange={e=>setGross(e.target.value)} hint="For example -15.00, 0.00 or 20.00."/>
     {lines.map((line,index)=><div key={index} className="grid gap-2 sm:grid-cols-2"><Select label={`Correction site ${index+1}`} value={line.project_id} onChange={e=>setLines(old=>old.map((x,i)=>i===index?{...x,project_id:e.target.value}:x))}><option value="">Choose a site</option>{projects.map(p=><option key={p.id} value={p.id}>{p.name} · {p.id}</option>)}</Select><Input label={`Signed site change ${index+1} (₱)`} inputMode="decimal" value={line.gross_change} onChange={e=>setLines(old=>old.map((x,i)=>i===index?{...x,gross_change:e.target.value}:x))}/><Button type="button" size="sm" variant="ghost" onClick={()=>setLines(old=>old.filter((_,i)=>i!==index))}>Remove site {index+1}</Button></div>)}
     <Button type="button" size="sm" variant="secondary" disabled={busy||lines.length>=50} onClick={()=>setLines(old=>[...old,{project_id:'',gross_change:''}])}>Add correction site</Button><Input label="Correction evidence note" maxLength={500} value={note} onChange={e=>setNote(e.target.value)}/><Button type="button" size="sm" disabled={busy||!ready} onClick={prepare}>Review correction evidence</Button></>}
   </div>}
  </div>}
  <Modal isOpen={!!dialog} title="Record correction evidence?" description="This does not post a cost or transfer money." onClose={()=>setDialog(null)} dismissOnBackdrop={!busy} dismissOnEscape={!busy} showCloseButton={!busy}>
   {dialog&&<div className="space-y-3 text-xs text-ink-secondary"><p>Case {dialog.case_id} · net difference ₱{item.difference} · replacement gross change ₱{dialog.gross_change}.</p><ul>{dialog.split.map(line=><li key={line.project_id}>{projects?.find(p=>p.id.toLowerCase()===line.project_id)?.name||line.project_id} · ₱{line.gross_change}</li>)}</ul><p>{dialog.split.length===0?'No project changes. ':''}Evidence: {dialog.note}.</p><label className="flex items-start gap-2"><input type="checkbox" checked={ack} onChange={e=>setAck(e.target.checked)}/> I reviewed original source evidence, all cases and potential overlaps. This replaces the previous split and does not move money or update a cost total.</label><div className="flex justify-end gap-2"><Button type="button" variant="secondary" disabled={busy} onClick={()=>setDialog(null)}>Cancel</Button><Button type="button" disabled={busy||!ack} isLoading={busy} onClick={()=>{if(ack)void send(dialog);}}>Record correction evidence</Button></div></div>}
  </Modal>
 </div>;
}
