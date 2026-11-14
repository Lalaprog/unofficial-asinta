'use client';
import React,{useEffect,useRef,useState} from 'react';
import {Button} from '@/components/ui/Button';
import {useAuth} from '@/lib/auth/authContext';
import {createClient} from '@/lib/supabase/client';
import {crossSiteSourceReviewPreviewEnabled} from '@/lib/finance/featureAvailability';
import {formatSignedCost,parseCorrectedSaved,type CorrectedCase} from '@/lib/projects/correctedCostReview';
import {CROSS_SITE_SOURCE_REVIEW_BYTES,parseCrossSiteContext,verifyCrossSiteSources,type CrossSiteContext} from '@/lib/projects/crossSiteCostReview';
import {costCents,formatCostCents} from '@/lib/projects/projectCostReconciliation';
import {correctionAmount} from '@/lib/payroll/projectCostCorrection';

/** Read-only evidence inspection; not a cross-site destination review. */
export function CrossSiteSourceEvidence({projectId,userId,item,onChange}:{projectId:string;userId:string;item:CorrectedCase;onChange?:(key:string,value:{context:unknown;reviews:Record<string,unknown>}|null)=>void}){
 const {user,isFounder,assurance}=useAuth();
 if(!crossSiteSourceReviewPreviewEnabled()||user?.id!==userId||!isFounder||assurance!=='ready'||item.sourceInSnapshot||item.siteChange===null||correctionAmount(item.siteChange).cents<=0n)return null;
 return <Contents key={JSON.stringify([projectId,userId,item])} projectId={projectId} item={item} onChange={onChange}/>;
}
function Contents({projectId,item,onChange}:{projectId:string;item:CorrectedCase;onChange?:(key:string,value:{context:unknown;reviews:Record<string,unknown>}|null)=>void}){
 const [open,setOpen]=useState(false),[context,setContext]=useState<CrossSiteContext|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [notes,setNotes]=useState<Record<string,{review:string;correction:string}>>({});
 const alive=useRef(false),seq=useRef(0),lock=useRef(false);
 useEffect(()=>{const sequence=seq;alive.current=true;return()=>{alive.current=false;sequence.current++;};},[]);
 async function load(){if(lock.current)return;lock.current=true;const token=++seq.current;setBusy(true);setError('');setContext(null);setNotes({});onChange?.(item.key,null);
  try{const client=createClient();const {data,error}=await client.rpc('project_cost_cross_site_review_context',{p_destination:projectId,p_kind:item.kind,p_case:item.id});if(error)throw error;if(!alive.current||seq.current!==token)return;const parsed=parseCrossSiteContext(data,projectId,item);const reviews:Record<string,unknown>={};let bytes=0;
   // Limit simultaneous requests; every site must be validated, never truncate.
   for(let i=0;i<parsed.sources.length;i+=5){const batch=parsed.sources.slice(i,i+5);const rows=await Promise.all(batch.map(s=>client.rpc('project_cost_corrected_review',{p_project:s.projectId,p_revision:null})));if(!alive.current||seq.current!==token)return;for(let j=0;j<batch.length;j++){if(rows[j].error)throw rows[j].error;bytes+=new TextEncoder().encode(JSON.stringify(rows[j].data)).length;if(bytes>CROSS_SITE_SOURCE_REVIEW_BYTES)throw Error('Source reviews exceed the display limit');reviews[batch[j].projectId]=rows[j].data;}}
   verifyCrossSiteSources(parsed,item,reviews);const labels:Record<string,{review:string;correction:string}>={};for(const source of parsed.sources){const saved=parseCorrectedSaved(reviews[source.projectId],source.projectId);if(!saved.found)throw Error('Original review unavailable');labels[source.projectId]={review:saved.note,correction:saved.choices.corrections[item.key].reason??''};}if(alive.current&&seq.current===token){setNotes(labels);setContext(parsed);onChange?.(item.key,{context:parsed.raw,reviews});}
  }catch{if(alive.current&&seq.current===token)setError('Could not verify every current original-site review. Reload and investigate missing, changed, excluded or overlapping evidence.');}
  finally{lock.current=false;if(alive.current&&seq.current===token)setBusy(false);}}
 return <section className="mt-2 rounded-lg border border-surface-border p-3 space-y-2" aria-label={`Incoming source reviews ${item.key}`}>
  <button type="button" className="min-h-11 font-semibold text-brand underline" disabled={busy} aria-expanded={open} onClick={()=>{if(open){setContext(null);setNotes({});setError('');onChange?.(item.key,null);}setOpen(v=>!v);}}>Inspect incoming source-site reviews</button>
  {open&&<div className="space-y-2"><p>Read-only inspection for this one case. It does not include the correction in this project, save a destination review, change payroll or prove payment. Source reviews can change immediately and their decisions can be wrong.</p>{error&&<p role="alert">{error}</p>}
   <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={()=>void load()}>Load original-site reviews</Button>{busy&&<p role="status">Checking all original-site reviews…</p>}
   {context&&<div><p>Incoming gross effect {formatCostCents(context.incoming)}. The original and correction were included in every checked original-site review at the time of each read; this is not proof of completeness or future freshness.</p><ul>{context.sources.map(s=><li key={s.projectId} className="break-words">Project {s.projectId} · original {formatCostCents(costCents(s.originalGross))} · correction {formatSignedCost(correctionAmount(s.grossChange).cents)} · revision {s.revision} · reviewer {s.actorId} · {s.recordedAt} · request {s.requestId}<p>Source review note: {notes[s.projectId]?.review}. Included correction reason: {notes[s.projectId]?.correction}.</p></li>)}</ul></div>}
  </div>}
 </section>;
}
