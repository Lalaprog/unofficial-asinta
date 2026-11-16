'use client';
import React,{useEffect,useRef,useState} from 'react';
import {Button} from '@/components/ui/Button';
import {createClient} from '@/lib/supabase/client';
import {costCents,formatCostCents} from '@/lib/projects/projectCostReconciliation';
import {parseHistoricalProjectAttributions,type HistoricalProjectAttribution} from '@/lib/projects/historicalWorkerAttributions';

/** On-demand, separate evidence only. Never included in saved/scratch totals. */
export function HistoricalWorkerAttributions({projectId,userId}:{projectId:string;userId:string}){
 const [items,setItems]=useState<HistoricalProjectAttribution[]|null>(null),[scope,setScope]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const key=JSON.stringify([projectId,userId]),active=useRef(key),alive=useRef(false),sequence=useRef(0),running=useRef(false);active.current=key;
 useEffect(()=>{const seq=sequence;alive.current=true;seq.current++;running.current=false;setItems(null);setScope('');setError('');setBusy(false);return()=>{alive.current=false;seq.current++;running.current=false;};},[projectId,userId]);
 async function load(){if(running.current)return;running.current=true;setBusy(true);setError('');setItems(null);const token=++sequence.current;
  try{const {data,error:rpcError}=await createClient().rpc('project_historical_worker_attributions',{p_project:projectId});if(rpcError)throw rpcError;const result=parseHistoricalProjectAttributions(data,projectId);if(alive.current&&active.current===key&&token===sequence.current){setScope(key);setItems(result);}}
  catch{if(alive.current&&active.current===key&&token===sequence.current)setError('Could not verify historical attribution evidence. Do not assume that none exists.');}
  finally{if(alive.current&&active.current===key&&token===sequence.current){running.current=false;setBusy(false);}}
 }
 const shown=scope===key?items:null;
 return <section className="rounded-lg border border-surface-border p-3 space-y-2" aria-label="Experimental historical worker attribution evidence">
  <h5 className="font-semibold text-navy">Historical worker attribution evidence</h5>
  <p>These are Founder-entered splits of external payroll assertions, not proof of payment. They are <strong>not included</strong> in this scratchpad or saved-review total. Check original records, duplicate expenses and all correction cases; never add the full worker-week gross at every site. Empty results do not prove there are no historical costs. This separate snapshot can become stale immediately.</p>
  <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={()=>void load()}>{shown?'Reload historical evidence':'Load historical evidence'}</Button>
  {busy&&<p role="status">Loading historical evidence…</p>}{error&&<p role="alert">{error}</p>}
  {shown&&(shown.length?<ul className="max-h-64 overflow-auto divide-y divide-surface-border">{shown.map(item=><li key={item.requestId} className="py-2 break-words"><p className="font-semibold text-navy">{item.workerName} · {item.start} to {item.end} · this site {formatCostCents(costCents(item.siteGross))}</p><p>Whole worker-week gross {formatCostCents(costCents(item.originalGross))} · recorded payment date {item.paidOn}. Original assertion {item.sourceId}.</p><p>Original-period cases: {item.caseCount}. These may involve other sites and are not allocated here; review them separately.</p><p>Attribution note: {item.note} · recorded by {item.recordedBy} at {item.recordedAt}.</p></li>)}</ul>:<p>No attribution evidence returned for this project. Unattributed or missing historical pay may still exist.</p>)}
 </section>;
}
