'use client';

import React, {useEffect, useState} from 'react';
import {Button} from '@/components/ui/Button';
import {createClient} from '@/lib/supabase/client';
import {formatSignedCost,type CorrectedSaved} from '@/lib/projects/correctedCostReview';
import {formatCostCents} from '@/lib/projects/projectCostReconciliation';
import {crossSiteLedgerPreviewEnabled} from '@/lib/finance/featureAvailability';
import {CROSS_SITE_SOURCE_REVIEW_BYTES} from '@/lib/projects/crossSiteCostReview';
import {parseCrossSiteSavedHeader,verifyCrossSiteSaved,verifyCrossSiteOverview,type CrossSiteSaved} from '@/lib/projects/crossSiteReviewLedger';
import {parseRecordedCostCoverage} from '@/lib/projects/recordedCostCoverage';
import Link from 'next/link';

type State = {status:'loading'|'empty'|'error'|'stale'|'incoming'} | {status:'ready';review:CorrectedSaved} | {status:'cross';review:CrossSiteSaved};

/** Latest independently checked saved review, not an automatic accounting posting. */
export function ProjectReviewedCostSummary(props:{projectId:string;userId:string;onReview:()=>void}) {
 return <Summary key={JSON.stringify([props.projectId,props.userId])} {...props} />;
}
function Summary({projectId,onReview}:{projectId:string;userId:string;onReview:()=>void}) {
 const [state,setState]=useState<State>({status:'loading'});
 const [coverage,setCoverage]=useState<ReturnType<typeof parseRecordedCostCoverage>|null>(null);
 const [refresh,setRefresh]=useState(0);
 useEffect(()=>{
  let active=true;
  setState({status:'loading'});setCoverage(null);
  void (async()=>{
   try {
    const client=createClient();
    const {data,error}=await client.rpc('project_cost_recorded_coverage',{p_project:projectId});
    if(error)throw error;
    const checked=parseRecordedCostCoverage(data,projectId),review=checked.review;
    if(review.found&&review.revision!==review.latestRevision)throw Error('Not the latest review');
    if(!active)return;
    setCoverage(checked);
    if(review.found&&review.freshness!=='matches'){setState({status:'stale'});return;}
    if(review.found&&!review.inventory.cases.some(c=>!c.sourceInSnapshot)){setState({status:'ready',review});return;}
    // Never add two full reviews. If both exist, only substitute a cross-site
    // review with identical evidence and all other decisions.
    if(!crossSiteLedgerPreviewEnabled()){setState({status:review.found?'incoming':'empty'});return;}
    try{
     const response=await client.rpc('project_cost_cross_site_review',{p_project:projectId,p_revision:null});if(response.error)throw response.error;
     const header=parseCrossSiteSavedHeader(response.data,projectId);
     if(!header.found){if(active)setState({status:review.found?'incoming':'empty'});return;}
     if(header.revision!==header.latestRevision)throw Error('Not the latest cross-site review');
     const tasks=Object.entries(header.refs).flatMap(([key,refs])=>refs.map(ref=>({key,...ref})));if(tasks.length>100)throw Error('Too many source revisions');
     const sources:Record<string,Record<string,unknown>>={};let bytes=0;
     for(let i=0;i<tasks.length;i+=5){if(!active)return;const batch=tasks.slice(i,i+5);const rows=await Promise.all(batch.map(r=>client.rpc('project_cost_corrected_review',{p_project:r.projectId,p_revision:r.revision})));
      if(!active)return;
      for(let j=0;j<batch.length;j++){if(rows[j].error)throw rows[j].error;bytes+=new TextEncoder().encode(JSON.stringify(rows[j].data)).length;if(bytes>CROSS_SITE_SOURCE_REVIEW_BYTES)throw Error('Source reviews too large');(sources[batch[j].key]??={})[batch[j].projectId]=rows[j].data;}}
     const cross=verifyCrossSiteSaved(header,sources);verifyCrossSiteOverview(review.found?review:null,cross);if(active)setState({status:'cross',review:cross});
    }catch{if(active)setState({status:review.found?'incoming':'error'});}
   } catch {if(active)setState({status:'error'});}
  })();
  return ()=>{active=false;};
 },[projectId,refresh]);
 const r=state.status==='ready'?state.review:null;
 const cross=state.status==='cross'?state.review:null;
 return <section aria-label="Reviewed project cost" className="space-y-2 rounded-xl border border-surface-border bg-white p-4 text-xs text-ink-secondary">
  <h3 className="text-sm font-semibold text-navy">Reviewed project cost</h3>
  <p>Combines paid worker payroll with the expenses, historical payroll and original-period corrections selected in the latest saved review. It is not added to the expense figures above.</p>
  {state.status==='loading'&&<p role="status">Checking the latest cost review…</p>}
  {coverage&&<div className="rounded-lg bg-status-warning-bg p-3 space-y-1" aria-label="Recorded payroll coverage signals">
   <p className="font-semibold text-navy">Check missing payroll attribution</p>
   <p>Across all projects: {coverage.unallocatedPaid} positive paid voucher(s) without site allocations, {coverage.inconsistentAllocations} with allocation totals that differ from voucher gross, and {coverage.unattributedHistory} historical worker payment record(s) without a site split. {coverage.attendanceMatches} unallocated voucher(s) have attendance at this site during their periods.</p>
   <p>These are investigation signals, not proof that the amounts belong to this site. Missing attendance or outside records cannot be detected; even zero signals do not prove completeness. Captured {coverage.capturedAt}; results can change. <Link href="/payroll" className="underline">Open payroll evidence</Link>.</p>
  </div>}
  {state.status==='empty'&&<p>No saved cost review yet. Open the review to check expenses, payroll and corrections before combining them.</p>}
  {state.status==='stale'&&<p role="alert">The saved cost review is out of date or its sources could not be checked. Its total is hidden; reload the review before using it.</p>}
  {state.status==='incoming'&&<p role="alert">This review has an incoming correction from another project. Its total is hidden because a matching current cross-site review could not be verified. Open the cost review to investigate.</p>}
  {cross&&<div aria-live="polite" className="space-y-1 rounded-lg bg-surface-inset p-3">
   <p className="font-semibold text-navy">Reviewed cross-site cost: {formatCostCents(cross.totals.total)}</p>
   <p>Included expenses {formatCostCents(cross.totals.expenses)} + paid worker payroll {formatCostCents(cross.totals.paid)} + included historical payroll {formatCostCents(cross.totals.historical)} + corrections {formatSignedCost(cross.totals.correction)}, including incoming {formatCostCents(cross.totals.crossSiteGross)}.</p>
   <p>Excluded expenses {formatCostCents(cross.totals.excludedExpenses)} · excluded historical payroll {formatCostCents(cross.totals.excludedHistorical)} · excluded correction cases {cross.totals.excludedCases}.</p>
   <p>Cross-site review revision {cross.revision}, recorded {cross.recordedAt}. This replaces the ordinary review amount; do not add them together. The separate source checks can become stale immediately and do not prove completeness or payment.</p>
  </div>}
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
