'use client';
import React,{useEffect,useRef,useState} from 'react';
import {Button} from '@/components/ui/Button';
import {createClient} from '@/lib/supabase/client';
import {parseLegacyCorrectionContext} from '@/lib/payroll/legacyCorrectionContext';
import type {PaidAdjustment} from '@/lib/payroll/paidAdjustments';
import type {CorrectionReview} from '@/lib/payroll/projectCostCorrection';
import type {AttributionProject} from '@/lib/payroll/historicalAttribution';

type Context=ReturnType<typeof parseLegacyCorrectionContext>;
/** Optional evidence alongside a correction for an older voucher. */
export function LegacyCorrectionContext({item,review,projects}:{item:PaidAdjustment;review:CorrectionReview;projects:AttributionProject[]}){
 const [open,setOpen]=useState(false),[context,setContext]=useState<Context|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');const alive=useRef(false),lock=useRef(false);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 async function load(){if(lock.current)return;lock.current=true;setBusy(true);setError('');setContext(null);try{
  const {data,error}=await createClient().rpc('project_cost_legacy_correction_context',{p_case:item.id});if(error)throw error;
  const checked=parseLegacyCorrectionContext(data,item,review);if(alive.current)setContext(checked);
 }catch{if(alive.current)setError('No current older-voucher split could be verified for this case. Check the original payroll or its project attribution before relying on this context.');}
 finally{lock.current=false;if(alive.current)setBusy(false);}}
 return <section aria-label="Older voucher correction context" className="space-y-2 rounded-lg border border-surface-border p-3">
  <button type="button" className="min-h-11 font-semibold text-brand underline" aria-expanded={open} disabled={busy} onClick={()=>{setOpen(v=>!v);setContext(null);setError('');}}>Check original older-voucher split</button>
  {open&&<div className="space-y-2"><p>For an older voucher, check the original site split before recording a correction. This is evidence only; it is not a payment or a total.</p>
   <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={()=>void load()}>Load original voucher split</Button>
   {error&&<p role="alert">{error}</p>}
   {context&&<><p>Original gross ₱{context.status.snapshot.gross_pay} · {context.status.case_count} original-period case(s). Reviewed note: {context.status.note}</p><ul>{context.status.split.map(row=><li key={row.project_id}>{projects.find(p=>p.id.toLowerCase()===row.project_id)?.name||row.project_id} · ₱{row.gross}</li>)}</ul><p>Evidence may change after loading. Corrections must be reviewed separately and remain in the original period.</p></>}
  </div>}
 </section>;
}
