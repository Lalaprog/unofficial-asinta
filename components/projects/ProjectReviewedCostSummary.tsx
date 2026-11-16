'use client';

import React, {useEffect, useState} from 'react';
import {Button} from '@/components/ui/Button';
import {createClient} from '@/lib/supabase/client';
import {formatSignedCost,type CorrectedSaved} from '@/lib/projects/correctedCostReview';
import {formatCostCents} from '@/lib/projects/projectCostReconciliation';
import {crossSiteAtomicOverviewEnabled,legacyVoucherAttributionPreviewEnabled,simpleRecordedCostPreviewEnabled} from '@/lib/finance/featureAvailability';
import {parseSimpleRecordedCost,type SimpleRecordedCost} from '@/lib/projects/simpleRecordedCost';
import {parseAtomicCrossSiteOverview,type CrossSiteSaved} from '@/lib/projects/crossSiteReviewLedger';
import {parseRecordedCostCoverage} from '@/lib/projects/recordedCostCoverage';
import {matchingLegacyBase,matchingLegacyOverview,parseLegacyCrossSiteOverview,parseLegacyRecordedCoverage,parseLegacyRecordedSnapshot} from '@/lib/projects/legacyRecordedCostCoverage';
import type {LegacyCostSaved} from '@/lib/projects/legacyVoucherCostReview';
import Link from 'next/link';

type State = {status:'loading'|'empty'|'error'|'stale'|'incoming'|'legacy-unavailable'|'legacy-changed'} | {status:'ready';review:CorrectedSaved} | {status:'cross';review:CrossSiteSaved} | {status:'legacy';review:LegacyCostSaved} | {status:'mixed';cross:CrossSiteSaved;legacy:LegacyCostSaved;total:bigint} | {status:'recorded';snapshot:SimpleRecordedCost} | {status:'needs-review';snapshot:SimpleRecordedCost};

/** Latest independently checked saved review, not an automatic accounting posting. */
export function ProjectReviewedCostSummary(props:{projectId:string;userId:string;onReview:()=>void}) {
 return <Summary key={JSON.stringify([props.projectId,props.userId])} {...props} />;
}
function Summary({projectId,onReview}:{projectId:string;userId:string;onReview:()=>void}) {
 const [state,setState]=useState<State>({status:'loading'});
 const [coverage,setCoverage]=useState<ReturnType<typeof parseRecordedCostCoverage>|null>(null);
 const [legacySignals,setLegacySignals]=useState<{siteAttributions:number;changedAttributions:number}|null>(null);
 const [refresh,setRefresh]=useState(0);
 useEffect(()=>{
  let active=true;
  setState({status:'loading'});setCoverage(null);setLegacySignals(null);
  void (async()=>{
   try {
    const client=createClient();
    const legacyEnabled=legacyVoucherAttributionPreviewEnabled(),simpleEnabled=simpleRecordedCostPreviewEnabled();
    const {data,error}=await client.rpc(legacyEnabled&&simpleEnabled?'project_cost_legacy_recorded_snapshot':legacyEnabled?'project_cost_legacy_recorded_coverage':simpleEnabled?'project_recorded_cost_snapshot':'project_cost_recorded_coverage',{p_project:projectId});
    if(error)throw error;
    const combined=legacyEnabled&&simpleEnabled?parseLegacyRecordedSnapshot(data,projectId):null;
    const legacyCoverage=combined?.legacy??(legacyEnabled?parseLegacyRecordedCoverage(data,projectId):null);
    const simple=combined?combined.simple:simpleEnabled?parseSimpleRecordedCost(data,projectId):null;
    const checked=legacyCoverage??simple?.coverage??parseRecordedCostCoverage(data,projectId),review=checked.review;
    if(review.found&&review.revision!==review.latestRevision)throw Error('Not the latest review');
    if(!active)return;
    setCoverage(checked);
    if(legacyCoverage){
     setLegacySignals({siteAttributions:legacyCoverage.siteAttributions,changedAttributions:legacyCoverage.changedAttributions});
     if(legacyCoverage.changedAttributions>0){setState({status:'legacy-changed'});return;}
     if(legacyCoverage.siteAttributions>0){const matching=matchingLegacyOverview(legacyCoverage);if(matching){setState({status:'legacy',review:matching});return;}if(!crossSiteAtomicOverviewEnabled()||!matchingLegacyBase(legacyCoverage)){setState({status:'legacy-unavailable'});return;}}
    }
    if(!legacyCoverage?.siteAttributions){
     if(simple&&!review.found&&simple.totals){setState({status:'recorded',snapshot:simple});return;}
     if(simple&&!review.found&&(!crossSiteAtomicOverviewEnabled()||!!legacyCoverage?.changedAttributions)){setState({status:'needs-review',snapshot:simple});return;}
     if(review.found&&review.freshness!=='matches'){setState({status:'stale'});return;}
     if(review.found&&!review.inventory.cases.some(c=>!c.sourceInSnapshot)){setState({status:'ready',review});return;}
    }
    // Every source and, when enabled, legacy coverage must come from one
    // database snapshot; never combine separate browser requests.
    if(!crossSiteAtomicOverviewEnabled()){setState({status:review.found?'incoming':'empty'});return;}
    try{
     const response=await client.rpc(legacyEnabled?'project_cost_legacy_cross_site_overview':'project_cost_cross_site_overview',{p_project:projectId});if(response.error)throw response.error;
     if(legacyEnabled){const current=parseLegacyCrossSiteOverview(response.data,projectId);if(!active)return;
      setCoverage(current.legacy);setLegacySignals({siteAttributions:current.legacy.siteAttributions,changedAttributions:current.legacy.changedAttributions});
      // Changed evidence takes precedence even when another split is present;
      // direct the Founder to investigate it rather than just request a review.
      if(current.legacy.changedAttributions>0){setState({status:'legacy-changed'});return;}
      if(current.legacy.siteAttributions>0){const matching=matchingLegacyOverview(current.legacy);setState(matching?{status:'legacy',review:matching}:current.mixed?{status:'mixed',...current.mixed}:{status:'legacy-unavailable'});return;}
      setState(current.cross?{status:'cross',review:current.cross}:{status:current.legacy.review.found?'incoming':'empty'});return;
     }
     const current=parseAtomicCrossSiteOverview(response.data,projectId);if(!active)return;
     setCoverage(current.coverage);
     setState(current.cross?{status:'cross',review:current.cross}:simple?{status:'needs-review',snapshot:simple}:{status:current.coverage.review.found?'incoming':'empty'});
    }catch{if(active)setState(legacyCoverage?.siteAttributions?{status:'legacy-unavailable'}:simple&&!review.found?{status:'needs-review',snapshot:simple}:{status:review.found?'incoming':'error'});}
   } catch {if(active)setState({status:'error'});}
  })();
  return ()=>{active=false;};
 },[projectId,refresh]);
 const r=state.status==='ready'?state.review:null;
 const cross=state.status==='cross'?state.review:null;
 const legacy=state.status==='legacy'?state.review:null;
 return <section aria-label="Reviewed project cost" className="space-y-2 rounded-xl border border-surface-border bg-white p-4 text-xs text-ink-secondary">
  <h3 className="text-sm font-semibold text-navy">Reviewed project cost</h3>
  <p>Shows recorded expenses and paid worker costs, including attributed historical pay and original-period corrections where checked. It is not added to the expense figures above.</p>
  {state.status==='loading'&&<p role="status">Checking the latest cost review…</p>}
  {coverage&&<div className="rounded-lg bg-status-warning-bg p-3 space-y-1" aria-label="Recorded payroll coverage signals">
   <p className="font-semibold text-navy">Check missing payroll attribution</p>
   <p>Across all projects: {coverage.unallocatedPaid} positive paid voucher(s) without site allocations, {coverage.inconsistentAllocations} with allocation totals that differ from voucher gross, and {coverage.unattributedHistory} historical worker payment record(s) without a site split. {coverage.attendanceMatches} unallocated voucher(s) have attendance at this site during their periods.</p>
   {legacySignals&&<p>{legacySignals.siteAttributions} older voucher split(s) name this site; {legacySignals.changedAttributions} recorded older voucher split(s) across all projects have changed or need investigation.</p>}
   <p>These are investigation signals, not proof that the amounts belong to this site. Missing attendance or outside records cannot be detected; even zero signals do not prove completeness. Captured {coverage.capturedAt}; results can change. <Link href="/payroll" className="underline">Open payroll evidence</Link>.</p>
  </div>}
  {state.status==='empty'&&<p>No saved cost review yet. Open the review to check expenses, payroll and corrections before combining them.</p>}
  {state.status==='needs-review'&&<div role="alert" className="rounded-lg bg-status-warning-bg p-3"><p>Recorded cost needs review before an amount can be shown.</p><ul className="list-disc pl-5">{state.snapshot.issues.map(issue=><li key={issue}>{issue}</li>)}</ul></div>}
  {state.status==='recorded'&&state.snapshot.totals&&<div aria-live="polite" className="space-y-1 rounded-lg bg-surface-inset p-3"><p className="font-semibold text-navy">Recorded cost so far: {formatCostCents(state.snapshot.totals.total)}</p><p>Expenses {formatCostCents(state.snapshot.totals.expenses)} + paid worker payroll {formatCostCents(state.snapshot.totals.paid)} + historical worker pay {formatCostCents(state.snapshot.totals.historical)} + original-period corrections {formatSignedCost(state.snapshot.totals.correction)}.</p><p>This is an unsaved amount from recorded data, not proof of payment or a complete accounting. Missing or duplicate records can go undetected. Linked confirmed rentals are included as expenses, not added again. Possible Bale or payroll overlaps need review, but not every overlap can be detected. Review the records before relying on it.</p></div>}
  {state.status==='stale'&&<p role="alert">The saved cost review is out of date or its sources could not be checked. Its total is hidden; reload the review before using it.</p>}
  {state.status==='incoming'&&<p role="alert">This review has an incoming correction from another project. Its total is hidden because a matching current cross-site review could not be verified. Open the cost review to investigate.</p>}
  {state.status==='legacy-unavailable'&&<p role="alert">Older voucher attribution exists for this site, but a matching current older-voucher cost review could not be verified. The ordinary total is hidden; open the cost review and investigate changed sources or corrections.</p>}
  {state.status==='legacy-changed'&&<p role="alert">An older voucher split or its corrections changed and needs investigation. The total is hidden until the evidence can be checked.</p>}
  {legacy&&<div aria-live="polite" className="space-y-1 rounded-lg bg-surface-inset p-3"><p className="font-semibold text-navy">Reviewed cost including older vouchers: {formatCostCents(legacy.totals.total)}</p><p>Ordinary review {formatCostCents(legacy.totals.base.total)} + included older voucher gross {formatCostCents(legacy.totals.included)}. Excluded older voucher gross {formatCostCents(legacy.totals.excluded)}.</p><p>Older-voucher review revision {legacy.revision}, recorded {legacy.recordedAt}. This replaces the ordinary review amount; do not add them. It is incomplete, can become stale and does not prove payment.</p></div>}
  {state.status==='mixed'&&<div aria-live="polite" className="space-y-1 rounded-lg bg-surface-inset p-3"><p className="font-semibold text-navy">Reviewed cost including older pay and incoming corrections: {formatCostCents(state.total)}</p><p>Cross-site review {formatCostCents(state.cross.totals.total)} + included older voucher gross {formatCostCents(state.legacy.totals.included)}. The ordinary review is already included; do not add it again.</p><p>Cross-site revision {state.cross.revision} and older-voucher revision {state.legacy.revision} were checked together. Results can change and do not prove completeness or payment.</p></div>}
  {cross&&<div aria-live="polite" className="space-y-1 rounded-lg bg-surface-inset p-3">
   <p className="font-semibold text-navy">Reviewed cross-site cost: {formatCostCents(cross.totals.total)}</p>
   <p>Included expenses {formatCostCents(cross.totals.expenses)} + paid worker payroll {formatCostCents(cross.totals.paid)} + included historical payroll {formatCostCents(cross.totals.historical)} + corrections {formatSignedCost(cross.totals.correction)}, including incoming {formatCostCents(cross.totals.crossSiteGross)}.</p>
   <p>Excluded expenses {formatCostCents(cross.totals.excludedExpenses)} · excluded historical payroll {formatCostCents(cross.totals.excludedHistorical)} · excluded correction cases {cross.totals.excludedCases}.</p>
   <p>Cross-site review revision {cross.revision}, recorded {cross.recordedAt}. This replaces the ordinary review amount; do not add them together. The evidence was checked together at one point in time; it can change afterward and does not prove completeness or payment.</p>
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
