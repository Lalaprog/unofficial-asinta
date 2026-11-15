'use client';

import React, {useEffect, useState} from 'react';
import {Button} from '@/components/ui/Button';
import {createClient} from '@/lib/supabase/client';
import {formatSignedCost,parseCorrectedSaved,type CorrectedSaved} from '@/lib/projects/correctedCostReview';
import {formatCostCents} from '@/lib/projects/projectCostReconciliation';

type State = {status:'loading'|'empty'|'error'|'stale'|'incoming'} | {status:'ready';review:CorrectedSaved};

/** Latest independently checked saved review, not an automatic accounting posting. */
export function ProjectReviewedCostSummary(props:{projectId:string;userId:string;onReview:()=>void}) {
 return <Summary key={JSON.stringify([props.projectId,props.userId])} {...props} />;
}
function Summary({projectId,onReview}:{projectId:string;userId:string;onReview:()=>void}) {
 const [state,setState]=useState<State>({status:'loading'});
 const [refresh,setRefresh]=useState(0);
 useEffect(()=>{
  let active=true;
  setState({status:'loading'});
  void (async()=>{
   try {
    const {data,error}=await createClient().rpc('project_cost_corrected_review',{p_project:projectId,p_revision:null});
    if(error)throw error;
    const review=parseCorrectedSaved(data,projectId);
    if(review.found&&review.revision!==review.latestRevision)throw Error('Not the latest review');
    if(!active)return;
    if(!review.found)setState({status:'empty'});
    else if(review.freshness!=='matches')setState({status:'stale'});
    // This reader cannot include an incoming correction without the separate
    // cross-site protocol. Even an explicit exclusion would make its amount
    // unsuitable as the overview cost for this destination.
    else if(review.inventory.cases.some(c=>!c.sourceInSnapshot))setState({status:'incoming'});
    else setState({status:'ready',review});
   } catch {if(active)setState({status:'error'});}
  })();
  return ()=>{active=false;};
 },[projectId,refresh]);
 const r=state.status==='ready'?state.review:null;
 return <section aria-label="Reviewed project cost" className="space-y-2 rounded-xl border border-surface-border bg-white p-4 text-xs text-ink-secondary">
  <h3 className="text-sm font-semibold text-navy">Reviewed project cost</h3>
  <p>Combines paid worker payroll with the expenses, historical payroll and original-period corrections selected in the latest saved review. It is not added to the expense figures above.</p>
  {state.status==='loading'&&<p role="status">Checking the latest cost review…</p>}
  {state.status==='empty'&&<p>No saved cost review yet. Open the review to check expenses, payroll and corrections before combining them.</p>}
  {state.status==='stale'&&<p role="alert">The saved cost review is out of date or its sources could not be checked. Its total is hidden; reload the review before using it.</p>}
  {state.status==='incoming'&&<p role="alert">This review has an incoming correction from another project. Its total is hidden because this overview cannot verify or include that cross-site effect. Open the cost review to investigate.</p>}
  {state.status==='error'&&<p role="alert">The cost review could not be verified. No total is assumed; retry or open the review.</p>}
  {r&&<div aria-live="polite" className="space-y-1 rounded-lg bg-surface-inset p-3">
   <p className="font-semibold text-navy">Reviewed cost: {formatCostCents(r.totals.total)}</p>
   <p>Included expenses {formatCostCents(r.totals.expenses)} + paid worker payroll {formatCostCents(r.totals.paid)} + included historical payroll {formatCostCents(r.totals.historical)} + corrections {formatSignedCost(r.totals.correction)}.</p>
   <p>Excluded expenses {formatCostCents(r.totals.excludedExpenses)} · excluded historical payroll {formatCostCents(r.totals.excludedHistorical)} · excluded correction cases {r.totals.excludedCases}.</p>
   <p>Review revision {r.revision}, recorded {r.recordedAt}. The source check can become stale immediately and does not prove completeness or payment; missing costs and unlinked or overlapping cases may be absent.</p>
  </div>}
  <div className="flex flex-wrap gap-2"><Button type="button" size="sm" variant="secondary" disabled={state.status==='loading'} onClick={()=>setRefresh(v=>v+1)}>Refresh reviewed cost</Button><Button type="button" size="sm" variant="secondary" onClick={onReview}>Open cost review</Button></div>
 </section>;
}
