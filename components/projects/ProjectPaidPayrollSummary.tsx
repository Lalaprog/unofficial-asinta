'use client';

import React,{useEffect,useRef,useState} from 'react';
import {Button} from '@/components/ui/Button';
import {createClient} from '@/lib/supabase/client';
import {costCents,formatCostCents,parseCostSnapshot} from '@/lib/projects/projectCostReconciliation';

type Summary={capturedAt:string;count:number;gross:bigint;cases:number};

/** A bounded, on-demand evidence subtotal, not a reconciled project total. */
export function ProjectPaidPayrollSummary(props:{projectId:string;userId:string;onReview:()=>void}){
 return <SummaryContent key={JSON.stringify([props.projectId,props.userId])} {...props}/>;
}
function SummaryContent({projectId,onReview}:{projectId:string;userId:string;onReview:()=>void}){
 const [value,setValue]=useState<Summary|null>(null),[loading,setLoading]=useState(false),[error,setError]=useState(false);
 const alive=useRef(false),sequence=useRef(0),busy=useRef(false);
 useEffect(()=>{const seq=sequence;alive.current=true;return()=>{alive.current=false;seq.current++;};},[]);
 async function load(){
  if(busy.current)return;busy.current=true;setLoading(true);setValue(null);setError(false);const token=++sequence.current;
  try{
   const result=await createClient().rpc('project_cost_reconciliation_preview',{p_project:projectId});if(result.error)throw result.error;
   const snapshot=parseCostSnapshot(result.data,projectId);
   const gross=snapshot.paid.reduce((total,p)=>total+costCents(p.gross),0n);
   if(alive.current&&token===sequence.current)setValue({capturedAt:snapshot.capturedAt,count:snapshot.paid.length,gross,cases:snapshot.adjustments.length});
  }catch{if(alive.current&&token===sequence.current)setError(true);}
  finally{busy.current=false;if(alive.current&&token===sequence.current)setLoading(false);}
 }
 return <section aria-label="Paid worker payroll for this site" className="space-y-2 rounded-xl border border-surface-border bg-white p-4 text-xs text-ink-secondary">
  <h3 className="text-sm font-semibold text-navy">Recorded paid worker payroll for this site</h3>
  <p>Review the gross wages and approved allowances attributed to this site after a weekly voucher is approved and its external payment is recorded. This is a separate, incomplete cost component, not proof of payment or a total project cost.</p>
  <div className="flex flex-wrap gap-2"><Button type="button" size="sm" variant="secondary" disabled={loading} onClick={()=>void load()}>{value?'Refresh paid payroll summary':'Load paid payroll summary'}</Button><Button type="button" size="sm" variant="secondary" onClick={onReview}>Review expense and payroll evidence</Button></div>
  {loading&&<p role="status">Checking the bounded project snapshot…</p>}
  {error&&<p role="alert">The project snapshot could not be verified or exceeded its limits. No payroll subtotal is assumed; retry or investigate the evidence.</p>}
  {value&&<div aria-live="polite" className="space-y-1 rounded-lg bg-surface-inset p-3">
   <p className="font-semibold text-navy">Recorded site payroll gross: {formatCostCents(value.gross)} · {value.count} paid allocation(s)</p>
   <p>Snapshot captured {value.capturedAt}; it can change immediately. No matching allocation does not prove there was no payroll cost.</p>
   <p>Related original-voucher correction cases: {value.cases}. Their amounts are not included or automatically assigned to this site. Historical or external pay, other costs and missing records may be absent.</p>
  </div>}
  <p>Not included in the expense-only figures above. Do not add this to expenses without checking for duplicated payroll, Bale and rentals; review original records before relying on any total.</p>
 </section>;
}
