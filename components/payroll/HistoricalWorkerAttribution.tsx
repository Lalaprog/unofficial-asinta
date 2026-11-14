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
import {boundAttributionArguments,parseBoundAttributionAttempt,parseBoundCaseInventory,verifyBoundAttribution,type BoundAttributionAttempt} from '@/lib/payroll/historicalCaseBinding';

type DraftSite={project_id:string;gross:string};
/** Candidate evidence entry. It does not post a cost or make a payment. */
export function HistoricalWorkerAttribution(props:{actor:string;source:ExternalRow;caseBinding?:boolean}){
 return <AttributionContents key={JSON.stringify([props.actor,props.source,!!props.caseBinding])} {...props}/>;
}
function AttributionContents({actor,source,caseBinding=false}:{actor:string;source:ExternalRow;caseBinding?:boolean}){
 // Both modes deliberately share a key: an old or unknown retry blocks the
 // new mode instead of being silently upgraded or overlooked (and vice versa).
 const storageKey=JSON.stringify(['historical-worker-attribution-v1',actor,source.request_id]);
 const [expanded,setExpanded]=useState(false),[ready,setReady]=useState(false),[pending,setPending]=useState<AttributionAttempt|null>(null),[pendingBound,setPendingBound]=useState<BoundAttributionAttempt|null>(null),[storageError,setStorageError]=useState(false),[stop,setStop]=useState(false);
 const [inventory,setInventory]=useState<BoundAttributionAttempt['reviewed_cases']|null>(null),[dialogBound,setDialogBound]=useState<BoundAttributionAttempt|null>(null);
 const [projects,setProjects]=useState<AttributionProject[]|null>(null),[cases,setCases]=useState<PeriodCase[]|null>(null),[status,setStatus]=useState<AttributionStatus|null>(null),[original,setOriginal]=useState<ExternalRow|null>(null);
 const [split,setSplit]=useState<DraftSite[]>([{project_id:'',gross:''}]),[note,setNote]=useState(''),[dialog,setDialog]=useState<AttributionAttempt|null>(null),[ack,setAck]=useState(false);
 const [busy,setBusy]=useState(false),[message,setMessage]=useState('');const scope=JSON.stringify([actor,source]);const alive=useRef(false),lock=useRef(false),seq=useRef(0),current=useRef(scope),observed=useRef<{raw:string|null}|null>(null),stopSnapshot=useRef<{raw:string|null}|null>(null);current.current=scope;
 useEffect(()=>{const sequence=seq;alive.current=true;sequence.current++;observed.current=null;stopSnapshot.current=null;setReady(false);setPending(null);setPendingBound(null);setInventory(null);setDialogBound(null);setStorageError(false);setProjects(null);setCases(null);setStatus(null);setOriginal(null);setDialog(null);setSplit([{project_id:'',gross:''}]);setNote('');setAck(false);setStop(false);setMessage('');setBusy(lock.current);try{const saved=sessionStorage.getItem(storageKey);observed.current={raw:saved};if(saved){if(caseBinding){const bound=parseBoundAttributionAttempt(JSON.parse(saved),actor,source.worker_id,source.request_id);setPendingBound(bound);setPending(bound.attribution);}else setPending(parseAttributionAttempt(JSON.parse(saved),actor,source.worker_id,source.request_id));}}catch{setStorageError(true);}setReady(true);return()=>{alive.current=false;sequence.current++;};
 // The source snapshot is serialized to track content rather than object identity.
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[scope,storageKey]);
 const live=(token:number)=>alive.current&&seq.current===token&&current.current===scope;
 const parseStored=(raw:string)=>caseBinding?parseBoundAttributionAttempt(JSON.parse(raw),actor,source.worker_id,source.request_id):parseAttributionAttempt(JSON.parse(raw),actor,source.worker_id,source.request_id);
 const expectedStored=(a:AttributionAttempt,bound:BoundAttributionAttempt|null)=>{if(caseBinding){if(!bound||!sameAttributionEvidence(bound.attribution,a))throw Error('Missing bound retry');return bound;}return a;};
 async function verify(a:AttributionAttempt,bound:BoundAttributionAttempt|null){
  const client=createClient();const [originalResult,bindingResult]=await Promise.all([client.rpc('historical_worker_attribution',{p_source:a.source.request_id}),caseBinding?client.rpc('historical_attribution_case_binding',{p_source:a.source.request_id}):Promise.resolve(null)]);
  if(originalResult.error||bindingResult?.error)throw Error('Evidence unavailable');
  const found=parseAttributionStatus(originalResult.data,a.source.worker_id,a.source.request_id);
  if(!found.found)return {found:false,changed:false};
  if(!attributionStatusMatches(found,a))throw Error('Attribution differs');
  if(caseBinding){if(!bound)throw Error('Missing bound retry');return {found:true,changed:verifyBoundAttribution(bindingResult?.data,found,bound).casesChanged};}
  return {found:true,changed:false};
 }
 async function load(){if(lock.current||pending||storageError)return;lock.current=true;setBusy(true);setMessage('');setProjects(null);setCases(null);setStatus(null);setOriginal(null);setInventory(null);const token=++seq.current;
  try{
   const client=createClient();const [catalog,history,current,existing]=await Promise.all([
    client.rpc('historical_worker_attribution_projects'),client.rpc('paid_period_assertion_case_list',{p_kind:'external_worker',p_source:source.request_id}),
    client.rpc('historical_external_worker_lookup',{p_request:source.request_id}),client.rpc('historical_worker_attribution',{p_source:source.request_id})]);
   if(catalog.error||history.error||current.error||existing.error)throw Error('Review unavailable');
   const originalRow=parseAttributionSource(current.data,source.worker_id,source.request_id);if(!sameAttributionEvidence(originalRow,source))throw Error('Source changed');
   const periods=snapshotFromExternal(originalRow),foundCases=parsePeriodCases(history.data,periods),foundStatus=parseAttributionStatus(existing.data,source.worker_id,source.request_id),foundProjects=parseAttributionProjects(catalog.data);
   if(foundCases.some(item=>!samePeriodSnapshot(item.original_snapshot,periods)))throw Error('Case source changed');
   if(foundStatus.found&&(foundStatus.source_changed||!sameAttributionEvidence(foundStatus.source,originalRow)))throw Error('Attribution source changed');
   const boundInventory=caseBinding?parseBoundCaseInventory(history.data,originalRow).inventory:null;
   if(live(token)){setProjects(foundProjects);setCases(foundCases);setStatus(foundStatus);setOriginal(originalRow);setInventory(boundInventory);}
  }catch{if(live(token))setMessage('Could not verify the original assertion, complete cases, projects and existing attribution. Reload and investigate.');}
  finally{lock.current=false;if(alive.current)setBusy(false);}
 }
 function prepare(){if(lock.current||pending||storageError||!projects||!cases||!status||status.found||!original)return;try{
  const attempt=parseAttributionAttempt({id:crypto.randomUUID(),actor,source:original,split,note:note.trim()},actor,source.worker_id,source.request_id);
  if(attempt.split.some(line=>!projects.some(project=>project.id.toLowerCase()===line.project_id)))throw Error('Project not in catalog');
  const bound=caseBinding?parseBoundAttributionAttempt({version:2,attribution:attempt,reviewed_cases:inventory},actor,source.worker_id,source.request_id):null;
  setDialogBound(bound);setDialog(attempt);setAck(false);setMessage('');
 }catch{setMessage('Select distinct projects, enter positive amounts totaling the full original gross, and provide a one-line evidence note.');}}
 function finish(a:AttributionAttempt,bound:BoundAttributionAttempt|null,changed:boolean){const saved=sessionStorage.getItem(storageKey);if(!saved||!sameAttributionEvidence(parseStored(saved),expectedStored(a,bound)))throw Error('Retry record changed');sessionStorage.removeItem(storageKey);observed.current={raw:null};if(alive.current){setPending(null);setPendingBound(null);setInventory(null);setProjects(null);setCases(null);setStatus(null);setOriginal(null);setDialog(null);setDialogBound(null);setMessage(changed?'Attribution evidence recorded, but original-period cases changed since the saved review. Reload and investigate; replay is not a fresh review. No payment or cost was posted.':'Attribution evidence recorded. Reload to review it. No payment, expense or project cost was posted.');}}
 async function check(){if(lock.current||!pending)return;lock.current=true;setBusy(true);setMessage('');const token=++seq.current;try{
  const result=await verify(pending,pendingBound);
  if(!result.found){if(live(token))setMessage('No matching attribution is visible yet; a request may still be in flight. This does not prove failure.');return;}
  if(live(token))finish(pending,pendingBound,result.changed);
 }catch{if(live(token))setMessage('Could not verify this exact attribution. Keep the retry record and investigate.');}finally{lock.current=false;if(alive.current)setBusy(false);}}
 async function send(a:AttributionAttempt,retry=false){if(lock.current||storageError)return;lock.current=true;setBusy(true);setMessage('');let stored=false;const token=++seq.current;
  let checked=false;const bound=retry?pendingBound:dialogBound;
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
    if(caseBinding&&(!bound||!sameAttributionEvidence(parseBoundCaseInventory(history.data,a.source).inventory,bound.reviewed_cases)))throw Error('Case inventory changed');
    if(!live(token))return;
   }
   checked=true;const expected=expectedStored(a,bound),old=sessionStorage.getItem(storageKey);if((retry&&!old)||(old&&!sameAttributionEvidence(parseStored(old),expected)))throw Error('Different or missing retry');
   if(!old)sessionStorage.setItem(storageKey,JSON.stringify(expected));const saved=sessionStorage.getItem(storageKey);if(!saved||!sameAttributionEvidence(parseStored(saved),expected))throw Error('Storage');stored=true;observed.current={raw:saved};if(live(token)){setPending(a);setPendingBound(bound);setDialog(null);}
   const {data,error}=caseBinding&&bound?await createClient().rpc('record_historical_attribution_with_cases',boundAttributionArguments(bound)):await createClient().rpc('record_historical_worker_attribution',attributionArguments(a));if(error)throw error;
   if(!data||data.request_id!==a.id||data.source_id!==a.source.request_id||typeof data.replayed!=='boolean')throw Error('Unverified response');
   const result=await verify(a,bound);if(!result.found)throw Error('Unverified evidence');if(live(token))finish(a,bound,result.changed);
  }catch{if(live(token)){setMessage(!checked?'Review could not be reverified or changed; no request was sent. Reload and investigate.':stored?'Outcome not verified. It may already be recorded or still in flight; check or retry exactly.':'Retry storage could not be verified; no request was sent this time. An earlier request may still complete.');if(!checked){setProjects(null);setCases(null);setStatus(null);setOriginal(null);setDialog(null);}else if(!stored)setStorageError(true);}}
  finally{lock.current=false;if(alive.current)setBusy(false);}
 }
 function reviewStop(){try{const raw=sessionStorage.getItem(storageKey);if(!observed.current||raw!==observed.current.raw)throw Error('Retry changed');if(pending&&(!raw||!sameAttributionEvidence(parseStored(raw),expectedStored(pending,pendingBound))))throw Error('Retry changed');stopSnapshot.current={raw};setStop(true);setMessage('');}catch{setStop(false);setMessage('Retry data changed or could not be read. Nothing was cleared; investigate before continuing.');}}
 function stopRetry(){try{if(!stopSnapshot.current||!observed.current||sessionStorage.getItem(storageKey)!==stopSnapshot.current.raw||observed.current.raw!==stopSnapshot.current.raw)throw Error('Retry changed');if(pending&&(!stopSnapshot.current.raw||!sameAttributionEvidence(parseStored(stopSnapshot.current.raw),expectedStored(pending,pendingBound))))throw Error('Retry changed');sessionStorage.removeItem(storageKey);observed.current={raw:null};stopSnapshot.current=null;setPending(null);setPendingBound(null);setStorageError(false);setStop(false);setProjects(null);setCases(null);setInventory(null);setStatus(null);setOriginal(null);setMessage('Retry stopped. This does not cancel or undo the request; investigate before continuing.');}catch{stopSnapshot.current=null;setStop(false);setMessage('Retry data changed or could not be read. Nothing was cleared; investigate before continuing.');}}
 function update(index:number,value:Partial<DraftSite>){setSplit(rows=>rows.map((row,i)=>i===index?{...row,...value}:row));}
 return <div className="mt-3 border-t border-surface-border pt-3 space-y-2"><button type="button" className="min-h-11 font-semibold text-brand underline" aria-expanded={expanded} onClick={()=>setExpanded(v=>!v)}>Project attribution for this external week</button>
 {expanded&&<div className="space-y-3"><p>Record a human-reviewed complete split of the original gross, not the net or Bale. Current assignments do not prove where past work happened. This is not proof of payment and does not add a project cost or change payroll. A split cannot yet be edited or reversed; independently review original records, duplicates and all cases first.</p>{caseBinding&&<p>Case-bound candidate: a retry keeps sensitive reviewed case details in this tab, readable by same-origin scripts and not durable across devices or lost storage. This does not prevent other or older writers from bypassing it.</p>}
 {message&&<p role="status">{message}</p>}{!ready&&<p>Checking saved retry data…</p>}
 {(pending||storageError)&&<div className="rounded-lg bg-status-warning-bg p-3 space-y-2"><p>A request may still complete. Tab storage can be lost; a missing result does not prove failure.</p>{storageError&&<p>Saved retry data is unavailable, malformed or from a different attribution mode. It cannot be silently upgraded or retried here; investigate the original request before stopping it.</p>}{pending&&<><p className="break-all">Request {pending.id} · original {pending.source.request_id} · {pending.source.worker_snapshot.name} · gross ₱{pending.source.gross}</p><p className="break-words">{pending.split.map(item=>`${item.project_id}: ₱${item.gross}`).join(' · ')} · {pending.note}</p><div className="flex flex-wrap gap-2"><Button type="button" size="sm" variant="secondary" disabled={busy} onClick={()=>void check()}>Check exact attribution</Button><Button type="button" size="sm" variant="secondary" disabled={busy} onClick={()=>void send(pending,true)}>Retry exact attribution</Button></div></>}
 <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={reviewStop}>Review stopping attribution retry</Button>{stop&&<div><p>Stopping does not cancel or undo the request.</p><Button type="button" size="sm" variant="danger" disabled={busy} onClick={stopRetry}>I investigated; stop attribution retry</Button></div>}</div>}
 {!pending&&!storageError&&<Button type="button" size="sm" variant="secondary" disabled={!ready||busy} onClick={()=>void load()}>Load attribution review</Button>}
 {projects&&cases&&status&&original&&<><p>{original.worker_snapshot.name} · {original.period_start} to {original.period_end} · original gross ₱{original.gross} · external paid date {original.paid_on} · original evidence: {original.evidence_note}. These separate reads can become stale immediately and will be rechecked before a new submission.</p>
 <p>Original-period cases: {cases.length}. Cases affect the whole period, not a site. {caseBinding?'The candidate writer checks and binds the reviewed inventory against selected case writers; later changes still need review.':'These are point-in-time reads and are not locked or bound to this write; check again if anything changes.'}</p>{cases.map(item=><p key={item.id} className="break-words">Case {item.id} · {item.status} · difference ₱{item.difference} · {item.reason}{item.resolution_note&&` · resolution: ${item.resolution_note}`}{item.settled_on&&` · external settlement date: ${item.settled_on}`}</p>)}
 {status.found?<div className="rounded-lg border border-surface-border p-3"><p>Attribution already recorded by {status.actor_id} at {status.recorded_at}; original-period cases currently {status.case_count}.</p>{caseBinding&&<p>This display has not verified a saved case binding. An older unbound attribution is not automatically upgraded.</p>}<ul>{status.split.map(line=><li key={line.project_id}>{projects.find(p=>p.id.toLowerCase()===line.project_id)?.name||line.project_id} · ₱{line.gross}</li>)}</ul><p>{status.note}</p><p>No editing or reversal is available in this candidate.</p></div>:<div className="space-y-3">
 {split.map((line,index)=><div key={index} className="grid gap-2 sm:grid-cols-2"><Select label={`Attribution project ${index+1}`} value={line.project_id} onChange={event=>update(index,{project_id:event.target.value})}><option value="">Choose a project</option>{projects.map(project=><option value={project.id} key={project.id}>{project.name} · {project.id}</option>)}</Select><Input label={`Project gross ${index+1} (₱)`} inputMode="decimal" value={line.gross} onChange={event=>update(index,{gross:event.target.value})}/>{split.length>1&&<Button type="button" size="sm" variant="ghost" onClick={()=>setSplit(rows=>rows.filter((_,i)=>i!==index))}>Remove project {index+1}</Button>}</div>)}
 <Button type="button" size="sm" variant="secondary" disabled={split.length>=50||busy} onClick={()=>setSplit(rows=>[...rows,{project_id:'',gross:''}])}>Add another project</Button><Input label="Attribution evidence note" maxLength={500} value={note} onChange={event=>setNote(event.target.value)}/><Button type="button" size="sm" disabled={busy} onClick={prepare}>Review project attribution</Button></div>}</>}
 </div>}
 <Modal isOpen={!!dialog} title="Record historical project attribution?" description="No payment, expense or project cost is posted." onClose={()=>setDialog(null)} dismissOnBackdrop={!busy} dismissOnEscape={!busy} showCloseButton={!busy}>
 {dialog&&<div className="space-y-3 text-xs text-ink-secondary"><p>{dialog.source.worker_snapshot.name} · {dialog.source.period_start}–{dialog.source.period_end} · original gross ₱{dialog.source.gross}.</p><ul>{dialog.split.map(line=><li key={line.project_id}>{projects?.find(p=>p.id.toLowerCase()===line.project_id)?.name||line.project_id} · ₱{line.gross}</li>)}</ul><p>Evidence: {dialog.note}. This split cannot be edited or reversed in this candidate.</p><label className="flex items-start gap-2"><input type="checkbox" checked={ack} onChange={event=>setAck(event.target.checked)}/> I checked original records, each site, possible duplicate costs and all original-period cases. No money or cost will be posted.</label><div className="flex justify-end gap-2"><Button type="button" variant="secondary" disabled={busy} onClick={()=>setDialog(null)}>Cancel</Button><Button type="button" disabled={busy||!ack} isLoading={busy} onClick={()=>{if(ack)void send(dialog);}}>Record attribution evidence</Button></div></div>}
 </Modal>
 </div>;
}
