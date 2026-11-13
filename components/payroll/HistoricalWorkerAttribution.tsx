'use client';
import React,{useEffect,useRef,useState} from 'react';
import {Button} from '@/components/ui/Button';
import {Input} from '@/components/ui/Input';
import {Select} from '@/components/ui/Select';
import {Modal} from '@/components/ui/Modal';
import {createClient} from '@/lib/supabase/client';
import type {ExternalRow} from '@/lib/payroll/historicalExternalWorker';
import {parsePeriodCases,samePeriodSnapshot,snapshotFromExternal,type PeriodCase} from '@/lib/payroll/paidPeriodCases';
import {attributionArguments,attributionStatusMatches,parseAttributionAttempt,parseAttributionProjects,parseAttributionSource,parseAttributionStatus,sameAttributionEvidence,type AttributionAttempt,type AttributionProject,type AttributionStatus} from '@/lib/payroll/historicalAttribution';

type DraftSite={project_id:string;gross:string};
/** Candidate evidence entry. It does not post a cost or make a payment. */
export function HistoricalWorkerAttribution(props:{actor:string;source:ExternalRow}){
 return <AttributionContents key={JSON.stringify([props.actor,props.source])} {...props}/>;
}
function AttributionContents({actor,source}:{actor:string;source:ExternalRow}){
 const storageKey=JSON.stringify(['historical-worker-attribution-v1',actor,source.request_id]);
 const [expanded,setExpanded]=useState(false),[ready,setReady]=useState(false),[pending,setPending]=useState<AttributionAttempt|null>(null),[storageError,setStorageError]=useState(false),[stop,setStop]=useState(false);
 const [projects,setProjects]=useState<AttributionProject[]|null>(null),[cases,setCases]=useState<PeriodCase[]|null>(null),[status,setStatus]=useState<AttributionStatus|null>(null),[original,setOriginal]=useState<ExternalRow|null>(null);
 const [split,setSplit]=useState<DraftSite[]>([{project_id:'',gross:''}]),[note,setNote]=useState(''),[dialog,setDialog]=useState<AttributionAttempt|null>(null),[ack,setAck]=useState(false);
 const [busy,setBusy]=useState(false),[message,setMessage]=useState('');const alive=useRef(false),lock=useRef(false),seq=useRef(0);
 useEffect(()=>{const sequence=seq;alive.current=true;sequence.current++;setReady(false);try{const saved=sessionStorage.getItem(storageKey);setPending(saved?parseAttributionAttempt(JSON.parse(saved),actor,source.worker_id,source.request_id):null);setStorageError(false);}catch{setStorageError(true);}setReady(true);return()=>{alive.current=false;sequence.current++;};},[actor,source.request_id,source.worker_id,storageKey]);
 async function load(){if(lock.current||pending||storageError)return;lock.current=true;setBusy(true);setMessage('');setProjects(null);setCases(null);setStatus(null);setOriginal(null);const token=++seq.current;
  try{
   const client=createClient();const [catalog,history,current,existing]=await Promise.all([
    client.rpc('historical_worker_attribution_projects'),client.rpc('paid_period_assertion_case_list',{p_kind:'external_worker',p_source:source.request_id}),
    client.rpc('historical_external_worker_lookup',{p_request:source.request_id}),client.rpc('historical_worker_attribution',{p_source:source.request_id})]);
   if(catalog.error||history.error||current.error||existing.error)throw Error('Review unavailable');
   const originalRow=parseAttributionSource(current.data,source.worker_id,source.request_id);if(!sameAttributionEvidence(originalRow,source))throw Error('Source changed');
   const periods=snapshotFromExternal(originalRow),foundCases=parsePeriodCases(history.data,periods),foundStatus=parseAttributionStatus(existing.data,source.worker_id,source.request_id),foundProjects=parseAttributionProjects(catalog.data);
   if(foundCases.some(item=>!samePeriodSnapshot(item.original_snapshot,periods)))throw Error('Case source changed');
   if(foundStatus.found&&(foundStatus.source_changed||!sameAttributionEvidence(foundStatus.source,originalRow)))throw Error('Attribution source changed');
   if(alive.current&&token===seq.current){setProjects(foundProjects);setCases(foundCases);setStatus(foundStatus);setOriginal(originalRow);}
  }catch{if(alive.current&&token===seq.current)setMessage('Could not verify the original assertion, complete cases, projects and existing attribution. Reload and investigate.');}
  finally{lock.current=false;if(alive.current&&token===seq.current)setBusy(false);}
 }
 function prepare(){if(lock.current||pending||storageError||!projects||!cases||!status||status.found||!original)return;try{
  const attempt=parseAttributionAttempt({id:crypto.randomUUID(),actor,source:original,split,note:note.trim()},actor,source.worker_id,source.request_id);
  if(attempt.split.some(line=>!projects.some(project=>project.id.toLowerCase()===line.project_id)))throw Error('Project not in catalog');
  setDialog(attempt);setAck(false);setMessage('');
 }catch{setMessage('Select distinct projects, enter positive amounts totaling the full original gross, and provide a one-line evidence note.');}}
 function finish(a:AttributionAttempt){const saved=sessionStorage.getItem(storageKey);if(!saved||!sameAttributionEvidence(parseAttributionAttempt(JSON.parse(saved),actor,source.worker_id,source.request_id),a))throw Error('Retry record changed');sessionStorage.removeItem(storageKey);if(alive.current){setPending(null);setProjects(null);setCases(null);setStatus(null);setOriginal(null);setDialog(null);setMessage('Attribution evidence recorded. Reload to review it. No payment, expense or project cost was posted.');}}
 async function check(){if(lock.current||!pending)return;lock.current=true;setBusy(true);setMessage('');const token=++seq.current;try{
  const {data,error}=await createClient().rpc('historical_worker_attribution',{p_source:pending.source.request_id});if(error)throw error;const found=parseAttributionStatus(data,pending.source.worker_id,pending.source.request_id);
  if(!found.found){if(alive.current&&token===seq.current)setMessage('No matching attribution is visible yet; a request may still be in flight. This does not prove failure.');return;}
  if(!attributionStatusMatches(found,pending))throw Error('Attribution differs');if(alive.current&&token===seq.current)finish(pending);
 }catch{if(alive.current&&token===seq.current)setMessage('Could not verify this exact attribution. Keep the retry record and investigate.');}finally{lock.current=false;if(alive.current&&token===seq.current)setBusy(false);}}
 async function send(a:AttributionAttempt){if(lock.current||storageError)return;lock.current=true;setBusy(true);setMessage('');let stored=false;const token=++seq.current;
  let checked=false;
  try{
   // Reduce (but do not eliminate) the review/write race. Exact retries must
   // remain replayable even if a case was subsequently opened or resolved.
   if(!pending){
    if(!projects||!cases||!status||status.found||!original)throw Error('Review unavailable');
    const client=createClient();const [catalog,history,current,existing]=await Promise.all([
     client.rpc('historical_worker_attribution_projects'),client.rpc('paid_period_assertion_case_list',{p_kind:'external_worker',p_source:a.source.request_id}),
     client.rpc('historical_external_worker_lookup',{p_request:a.source.request_id}),client.rpc('historical_worker_attribution',{p_source:a.source.request_id})]);
    if(catalog.error||history.error||current.error||existing.error)throw Error('Review unavailable');
    const currentSource=parseAttributionSource(current.data,a.source.worker_id,a.source.request_id);
    const currentCases=parsePeriodCases(history.data,snapshotFromExternal(a.source));
    if(!sameAttributionEvidence(currentSource,a.source)||!sameAttributionEvidence(currentCases,cases)||!sameAttributionEvidence(parseAttributionProjects(catalog.data),projects)||parseAttributionStatus(existing.data,a.source.worker_id,a.source.request_id).found)throw Error('Review changed');
    if(!alive.current||token!==seq.current)return;
   }
   checked=true;const old=sessionStorage.getItem(storageKey);if(old&&!sameAttributionEvidence(parseAttributionAttempt(JSON.parse(old),actor,source.worker_id,source.request_id),a))throw Error('Different retry');
   if(!old)sessionStorage.setItem(storageKey,JSON.stringify(a));const saved=sessionStorage.getItem(storageKey);if(!saved||!sameAttributionEvidence(parseAttributionAttempt(JSON.parse(saved),actor,source.worker_id,source.request_id),a))throw Error('Storage');stored=true;if(alive.current&&token===seq.current){setPending(a);setDialog(null);}
   const {data,error}=await createClient().rpc('record_historical_worker_attribution',attributionArguments(a));if(error)throw error;
   if(!data||data.request_id!==a.id||data.source_id!==a.source.request_id||typeof data.replayed!=='boolean')throw Error('Unverified response');
   const statusResult=await createClient().rpc('historical_worker_attribution',{p_source:a.source.request_id});if(statusResult.error||!attributionStatusMatches(parseAttributionStatus(statusResult.data,a.source.worker_id,a.source.request_id),a))throw Error('Unverified evidence');if(alive.current&&token===seq.current)finish(a);
  }catch{if(alive.current&&token===seq.current){setMessage(!checked?'Review could not be reverified or changed; no request was sent. Reload and investigate.':stored?'Outcome not verified. It may already be recorded or still in flight; check or retry exactly.':'Retry storage could not be verified; no request was sent.');if(!checked){setProjects(null);setCases(null);setStatus(null);setOriginal(null);setDialog(null);}else if(!stored)setStorageError(true);}}
  finally{lock.current=false;if(alive.current&&token===seq.current)setBusy(false);}
 }
 function stopRetry(){try{sessionStorage.removeItem(storageKey);setPending(null);setStorageError(false);setStop(false);setProjects(null);setCases(null);setStatus(null);setOriginal(null);setMessage('Retry stopped. This does not cancel or undo the request; investigate before continuing.');}catch{setMessage('Could not clear retry storage.');}}
 function update(index:number,value:Partial<DraftSite>){setSplit(rows=>rows.map((row,i)=>i===index?{...row,...value}:row));}
 return <div className="mt-3 border-t border-surface-border pt-3 space-y-2"><button type="button" className="min-h-11 font-semibold text-brand underline" aria-expanded={expanded} onClick={()=>setExpanded(v=>!v)}>Project attribution for this external week</button>
 {expanded&&<div className="space-y-3"><p>Record a human-reviewed complete split of the original gross, not the net or Bale. Current assignments do not prove where past work happened. This is not proof of payment and does not add a project cost or change payroll. A split cannot yet be edited or reversed; independently review original records, duplicates and all cases first.</p>
 {message&&<p role="status">{message}</p>}{!ready&&<p>Checking saved retry data…</p>}
 {(pending||storageError)&&<div className="rounded-lg bg-status-warning-bg p-3 space-y-2"><p>A request may still complete. Tab storage can be lost; a missing result does not prove failure.</p>{pending&&<><p className="break-all">Request {pending.id} · original {pending.source.request_id} · {pending.source.worker_snapshot.name} · gross ₱{pending.source.gross}</p><p className="break-words">{pending.split.map(item=>`${item.project_id}: ₱${item.gross}`).join(' · ')} · {pending.note}</p><div className="flex flex-wrap gap-2"><Button type="button" size="sm" variant="secondary" disabled={busy} onClick={()=>void check()}>Check exact attribution</Button><Button type="button" size="sm" variant="secondary" disabled={busy} onClick={()=>void send(pending)}>Retry exact attribution</Button></div></>}
 <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={()=>setStop(v=>!v)}>Review stopping attribution retry</Button>{stop&&<div><p>Stopping does not cancel or undo the request.</p><Button type="button" size="sm" variant="danger" disabled={busy} onClick={stopRetry}>I investigated; stop attribution retry</Button></div>}</div>}
 {!pending&&!storageError&&<Button type="button" size="sm" variant="secondary" disabled={!ready||busy} onClick={()=>void load()}>Load attribution review</Button>}
 {projects&&cases&&status&&original&&<><p>{original.worker_snapshot.name} · {original.period_start} to {original.period_end} · original gross ₱{original.gross} · external paid date {original.paid_on} · original evidence: {original.evidence_note}. These separate reads can become stale immediately; they will be rechecked before a new submission, but are not locked to the write.</p>
 <p>Original-period cases: {cases.length}. Cases affect the whole period, not a site. They are a point-in-time read and are not locked or bound to this write; check again if anything changes.</p>{cases.map(item=><p key={item.id} className="break-words">Case {item.id} · {item.status} · difference ₱{item.difference} · {item.reason}{item.resolution_note&&` · resolution: ${item.resolution_note}`}{item.settled_on&&` · external settlement date: ${item.settled_on}`}</p>)}
 {status.found?<div className="rounded-lg border border-surface-border p-3"><p>Attribution already recorded by {status.actor_id} at {status.recorded_at}; original-period cases currently {status.case_count}.</p><ul>{status.split.map(line=><li key={line.project_id}>{projects.find(p=>p.id.toLowerCase()===line.project_id)?.name||line.project_id} · ₱{line.gross}</li>)}</ul><p>{status.note}</p><p>No editing or reversal is available in this candidate.</p></div>:<div className="space-y-3">
 {split.map((line,index)=><div key={index} className="grid gap-2 sm:grid-cols-2"><Select label={`Attribution project ${index+1}`} value={line.project_id} onChange={event=>update(index,{project_id:event.target.value})}><option value="">Choose a project</option>{projects.map(project=><option value={project.id} key={project.id}>{project.name} · {project.id}</option>)}</Select><Input label={`Project gross ${index+1} (₱)`} inputMode="decimal" value={line.gross} onChange={event=>update(index,{gross:event.target.value})}/>{split.length>1&&<Button type="button" size="sm" variant="ghost" onClick={()=>setSplit(rows=>rows.filter((_,i)=>i!==index))}>Remove project {index+1}</Button>}</div>)}
 <Button type="button" size="sm" variant="secondary" disabled={split.length>=50||busy} onClick={()=>setSplit(rows=>[...rows,{project_id:'',gross:''}])}>Add another project</Button><Input label="Attribution evidence note" maxLength={500} value={note} onChange={event=>setNote(event.target.value)}/><Button type="button" size="sm" disabled={busy} onClick={prepare}>Review project attribution</Button></div>}</>}
 </div>}
 <Modal isOpen={!!dialog} title="Record historical project attribution?" description="No payment, expense or project cost is posted." onClose={()=>setDialog(null)} dismissOnBackdrop={!busy} dismissOnEscape={!busy} showCloseButton={!busy}>
 {dialog&&<div className="space-y-3 text-xs text-ink-secondary"><p>{dialog.source.worker_snapshot.name} · {dialog.source.period_start}–{dialog.source.period_end} · original gross ₱{dialog.source.gross}.</p><ul>{dialog.split.map(line=><li key={line.project_id}>{projects?.find(p=>p.id.toLowerCase()===line.project_id)?.name||line.project_id} · ₱{line.gross}</li>)}</ul><p>Evidence: {dialog.note}. This split cannot be edited or reversed in this candidate.</p><label className="flex items-start gap-2"><input type="checkbox" checked={ack} onChange={event=>setAck(event.target.checked)}/> I checked original records, each site, possible duplicate costs and all original-period cases. No money or cost will be posted.</label><div className="flex justify-end gap-2"><Button type="button" variant="secondary" disabled={busy} onClick={()=>setDialog(null)}>Cancel</Button><Button type="button" disabled={busy||!ack} isLoading={busy} onClick={()=>{if(ack)void send(dialog);}}>Record attribution evidence</Button></div></div>}
 </Modal>
 </div>;
}
