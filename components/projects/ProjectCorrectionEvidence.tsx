'use client';
import React,{useEffect,useRef,useState} from 'react';
import {Button} from '@/components/ui/Button';
import {useAuth} from '@/lib/auth/authContext';
import {createClient} from '@/lib/supabase/client';
import {parseProjectCorrectionEvidence,type ProjectCorrectionEvidence as Evidence} from '@/lib/projects/projectCostCorrections';

/** On-demand evidence, not part of any estimate or saved review. */
export function ProjectCorrectionEvidence({projectId,userId}:{projectId:string;userId:string}){
 const {user,isFounder,assurance}=useAuth();const access=user?.id===userId&&isFounder&&assurance==='ready';
 const key=JSON.stringify([projectId,userId,access]);const current=useRef(key),sequence=useRef(0),alive=useRef(false),running=useRef(false);current.current=key;
 const [scope,setScope]=useState(''),[items,setItems]=useState<Evidence[]|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 useEffect(()=>{const seq=sequence;seq.current++;alive.current=true;setScope('');setItems(null);setError('');setBusy(running.current);return()=>{alive.current=false;seq.current++;};},[key]);
 async function load(){if(!access||running.current)return;running.current=true;setBusy(true);setItems(null);setError('');const token=++sequence.current;
  try{const {data,error:rpcError}=await createClient().rpc('project_cost_correction_attribution_sites',{p_project:projectId});if(rpcError)throw rpcError;const list=parseProjectCorrectionEvidence(data,projectId);if(alive.current&&current.current===key&&sequence.current===token){setScope(key);setItems(list);}}
  catch{if(alive.current&&current.current===key&&sequence.current===token)setError('Could not verify project correction evidence; do not assume none exists.');}
  finally{running.current=false;if(alive.current)setBusy(false);}}
 if(!access)return null;const shown=scope===key?items:null;
 return <section className="rounded-lg border border-surface-border p-3 space-y-2" aria-label="Project correction evidence">
  <h5 className="font-semibold text-navy">Worker correction site evidence</h5>
  <p>Latest recorded site splits only, not included in the estimate or saved review. These are human assertions, not proof of payment. Check original pay, all cases and duplicate expenses. An empty result does not prove there are no corrections; zero or unattributed effects do not appear here.</p>
  <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={()=>void load()}>{shown?'Reload correction evidence':'Load correction evidence for this site'}</Button>
  {busy&&<p role="status">Loading correction evidence…</p>}{error&&<p role="alert">{error}</p>}
  {shown&&(shown.length?<ul className="max-h-64 overflow-auto divide-y divide-surface-border">{shown.map(x=><li key={x.requestId} className="py-2 break-words"><p className="font-semibold text-navy">This site gross change ₱{x.siteChange} · full-case gross change ₱{x.totalChange}</p><p>Case {x.caseId} · {x.kind==='voucher'?'paid voucher':'external worker period'} · {x.caseStatus.replace('_',' ')} · net difference ₱{x.caseDifference} · revision {x.revision}.</p><p>Case reason: {x.reason}. Evidence: {x.note}.</p><p>Recorded by {x.recordedBy} at {x.recordedAt}.</p>{x.caseChanged&&<p role="alert">Case evidence changed; investigate before using this split.</p>}</li>)}</ul>:<p>No nonzero site correction evidence returned. Review other cases and unallocated corrections separately.</p>)}
 </section>;
}
