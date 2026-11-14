'use client';
import React,{useEffect,useRef,useState} from 'react';
import {Button} from '@/components/ui/Button';
import {useAuth} from '@/lib/auth/authContext';
import {createClient} from '@/lib/supabase/client';
import {crossSiteIllustrationPreviewEnabled} from '@/lib/finance/featureAvailability';
import {parseCrossSiteEvidence,verifyCrossSiteIllustration,type CrossSiteEvidence,type CrossSiteIllustration as Result} from '@/lib/payroll/crossSiteIllustration';
import type {CorrectionCase,CorrectionKind,CorrectionReview} from '@/lib/payroll/projectCostCorrection';
import type {AttributionProject} from '@/lib/payroll/historicalAttribution';

/** Read-only and independently default-off; the database is the authorization boundary. */
export function CrossSiteIllustration({actor,kind,item,review,projects}:{actor:string;kind:CorrectionKind;item:CorrectionCase;review:CorrectionReview;projects:AttributionProject[]}){
 const {user,isFounder,assurance}=useAuth();
 if(!crossSiteIllustrationPreviewEnabled()||user?.id!==actor||!isFounder||assurance!=='ready')return null;
 return <Contents key={JSON.stringify([actor,kind,item,review])} kind={kind} item={item} review={review} projects={projects}/>;
}
function Contents({kind,item,review,projects}:{kind:CorrectionKind;item:CorrectionCase;review:CorrectionReview;projects:AttributionProject[]}){
 const [open,setOpen]=useState(false),[evidence,setEvidence]=useState<CrossSiteEvidence|null>(null),[result,setResult]=useState<Result|null>(null),[ack,setAck]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const alive=useRef(false),seq=useRef(0),lock=useRef(false);
 useEffect(()=>{const sequence=seq;alive.current=true;return()=>{alive.current=false;sequence.current++;};},[]);
 async function load(){if(lock.current)return;lock.current=true;setBusy(true);setError('');setEvidence(null);setResult(null);setAck(false);const token=++seq.current;
  try{const {data,error}=await createClient().rpc('project_cost_cross_site_evidence',{p_kind:kind,p_case:item.id});if(error)throw error;const parsed=parseCrossSiteEvidence(data,kind,item,review);if(alive.current&&seq.current===token)setEvidence(parsed);}
  catch{if(alive.current&&seq.current===token)setError('Could not verify the original sites and current single-case evidence. Reload the case or investigate missing, stale or overlapping evidence.');}
  finally{lock.current=false;if(alive.current&&seq.current===token)setBusy(false);}}
 async function verify(){if(lock.current||!evidence||!ack)return;lock.current=true;setBusy(true);setError('');setResult(null);const token=++seq.current;
  try{const {data,error}=await createClient().rpc('project_cost_cross_site_preview',{p_kind:kind,p_case:item.id,p_expected:evidence.raw,p_ack:true});if(error)throw error;const checked=verifyCrossSiteIllustration(data,evidence.illustration);if(alive.current&&seq.current===token)setResult(checked);}
  catch{if(alive.current&&seq.current===token){setEvidence(null);setAck(false);setError('The illustration could not be verified or the source changed. Reload the evidence; do not treat missing amounts as zero.');}}
  finally{lock.current=false;if(alive.current&&seq.current===token)setBusy(false);}}
 const visible=result??evidence?.illustration;
 return <section className="space-y-2 rounded-lg border border-surface-border p-3" aria-label="Cross-site illustration">
  <button type="button" className="min-h-11 font-semibold text-brand underline" aria-expanded={open} disabled={busy} onClick={()=>{if(open){setEvidence(null);setResult(null);setAck(false);setError('');}setOpen(x=>!x);}}>Illustrate correction across sites</button>
  {open&&<div className="space-y-3"><p>This is an incomplete illustration for one original and one resolved case, not a project total, saved review, payment or transfer. It does not establish that any site included the original. Other cases or later changes can make it unavailable or stale. Site names are current labels; verify each project ID.</p>
   {error&&<p role="alert">{error}</p>}
   <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={()=>void load()}>Load cross-site evidence</Button>
   {visible&&<><p>Original ₱{visible.original_gross} · change ₱{visible.gross_change} · illustrated corrected gross ₱{visible.corrected_gross}</p>
    <ul aria-label="Illustrated site amounts">{visible.sites.map(line=><li key={line.project_id} className="break-words">{projects.find(p=>p.id.toLowerCase()===line.project_id)?.name||'Unknown site'} · {line.project_id} · original ₱{line.original_gross} · change ₱{line.gross_change} · corrected ₱{line.corrected_gross}</li>)}</ul>
    {!result&&<><label className="flex items-start gap-2"><input type="checkbox" checked={ack} disabled={busy} onChange={e=>{setAck(e.target.checked);setResult(null);}}/> I reviewed this original, the full site split and the one resolved case. This does not save a decision or change a cost.</label><Button type="button" size="sm" disabled={busy||!ack} onClick={()=>void verify()}>Verify cross-site illustration</Button></>}
    {result&&<p role="status">Illustration verified against the server snapshot. It is incomplete and may already be stale; reload before relying on it.</p>}</>}
  </div>}
 </section>;
}
