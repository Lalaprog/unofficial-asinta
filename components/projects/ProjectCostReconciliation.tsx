'use client';
import React,{useEffect,useRef,useState} from 'react';
import {Button} from '@/components/ui/Button';
import {WorkspaceJumpLinks} from '@/components/ui/WorkspaceJumpLinks';
import {createClient} from '@/lib/supabase/client';
import {costCents,estimateProjectCost,formatCostCents,parseCostSnapshot,potentialDuplicateExpenses,type CostChoice,type CostSnapshot} from '@/lib/projects/projectCostReconciliation';
import {PotentialDuplicateExpense} from './PotentialDuplicateExpense';
import {PotentialPayrollOverlap} from './PotentialPayrollOverlap';
import {historicalWorkerAttributionPreviewEnabled,historicalCostReviewPreviewEnabled,projectCostReviewLedgerPreviewEnabled,projectCostCorrectionPreviewEnabled,correctedProjectCostReviewPreviewEnabled} from '@/lib/finance/featureAvailability';
import {CorrectedProjectCostReview} from './CorrectedProjectCostReview';
import {ProjectCostReviewLedger} from './ProjectCostReviewLedger';
import {ProjectAdjustmentSignals} from './ProjectAdjustmentSignals';
import {HistoricalWorkerAttributions} from './HistoricalWorkerAttributions';
import {HistoricalCostReview} from './HistoricalCostReview';
import {ProjectCorrectionEvidence} from './ProjectCorrectionEvidence';

/** Temporary review scratchpad only. It never records classifications or costs. */
export function ProjectCostReconciliation({projectId,userId,reviewTarget=null}:{projectId:string;userId:string;reviewTarget?:'corrected'|'scratch'|null}){
 const scratchTarget=useRef<HTMLHeadingElement>(null);
 const primaryReview=correctedProjectCostReviewPreviewEnabled();
 const [advancedOpen,setAdvancedOpen]=useState(reviewTarget==='scratch');
 useEffect(()=>{if(reviewTarget==='scratch')setAdvancedOpen(true);},[reviewTarget]);
 useEffect(()=>{if(reviewTarget==='scratch'&&(!primaryReview||advancedOpen))scratchTarget.current?.focus();},[reviewTarget,primaryReview,advancedOpen]);
 const [rawSnapshot,setSnapshot]=useState<CostSnapshot|null>(null),[snapshotEvidence,setSnapshotEvidence]=useState<unknown>(null),[snapshotScope,setSnapshotScope]=useState(''),[loading,setLoading]=useState(false),[error,setError]=useState('');
 const [choices,setChoices]=useState<Record<string,CostChoice>>({}),[reasons,setReasons]=useState<Record<string,string>>({}),[ack,setAck]=useState(false);const alive=useRef(false),seq=useRef(0),busy=useRef(false),scope=JSON.stringify([projectId,userId]),active=useRef(scope);active.current=scope;const snapshot=snapshotScope===scope?rawSnapshot:null;
 useEffect(()=>{const sequence=seq;sequence.current++;alive.current=true;busy.current=false;setLoading(false);setSnapshot(null);setSnapshotEvidence(null);setChoices({});setReasons({});setAck(false);setError('');return()=>{alive.current=false;sequence.current++;busy.current=false;};},[projectId,userId]);
 async function load(){if(busy.current)return;busy.current=true;setLoading(true);setSnapshot(null);setSnapshotEvidence(null);setChoices({});setReasons({});setAck(false);setError('');const token=++seq.current;
  try{const {data,error:rpcError}=await createClient().rpc('project_cost_reconciliation_preview',{p_project:projectId});if(rpcError)throw rpcError;const parsed=parseCostSnapshot(data,projectId);if(alive.current&&active.current===scope&&token===seq.current){setSnapshotScope(scope);setSnapshot(parsed);setSnapshotEvidence(data);}}
  catch(e){if(alive.current&&active.current===scope&&token===seq.current)setError(e&&typeof e==='object'&&'code' in e&&e.code==='54000'?'This project exceeds a cost-review size limit. No total was calculated; larger-project review is not yet available. Do not delete records to fit the limit.':'Could not verify a complete reconciliation snapshot. No total is available; refresh or investigate.');}
  finally{if(active.current===scope&&token===seq.current){busy.current=false;if(alive.current)setLoading(false);}}
 }
 const reviewed=!!snapshot&&snapshot.expenses.every(e=>choices[e.id]==='include'||choices[e.id]==='exclude');
 const estimate=snapshot&&reviewed&&ack?estimateProjectCost(snapshot,choices):null;
 const duplicates=potentialDuplicateExpenses(snapshot?.expenses??[]);
 return <section className="rounded-xl border border-surface-border bg-white p-4 space-y-3 text-xs text-ink-secondary">
  {primaryReview&&<><h4 className="text-sm font-bold text-navy">Project cost review</h4><p>Use the main review for expenses, paid worker costs, historical pay and original-period corrections. Other tools remain available below when you need to investigate a record.</p><div id="cost-corrected-review" tabIndex={-1} className="scroll-mt-24"><CorrectedProjectCostReview key={`${scope}:corrected-review`} projectId={projectId} userId={userId} openFromOverview={reviewTarget==='corrected'} /></div><button type="button" className="min-h-11 font-semibold text-brand underline" aria-expanded={advancedOpen} aria-controls="advanced-project-cost-tools" onClick={()=>setAdvancedOpen(v=>!v)}>Other cost investigation tools</button></>}
  <div id="advanced-project-cost-tools" hidden={primaryReview&&!advancedOpen} className="space-y-3">
  <h4 ref={scratchTarget} tabIndex={-1} className="text-sm font-bold text-navy">Experimental project-cost review</h4>
  <p>This temporary scratchpad compares recorded expenses, paid worker allocations and confirmed rental links from one database snapshot. It saves nothing and does not prove payment or a final project cost.</p>
  <WorkspaceJumpLinks label="Cost review tools" links={[
   {href:'#cost-scratch',label:'Scratch estimate'},
   ...(historicalCostReviewPreviewEnabled() ? [{href:'#cost-historical-review',label:'Historical review'}] : []),
   ...(historicalWorkerAttributionPreviewEnabled() ? [{href:'#cost-historical-evidence',label:'Historical evidence'}] : []),
   ...(projectCostCorrectionPreviewEnabled() ? [{href:'#cost-correction-evidence',label:'Correction evidence'}] : []),
   ...(correctedProjectCostReviewPreviewEnabled() ? [{href:'#cost-corrected-review',label:'Corrected review'}] : []),
   ...(projectCostReviewLedgerPreviewEnabled() && !historicalCostReviewPreviewEnabled() ? [{href:'#cost-review-ledger',label:'Review history'}] : []),
  ]} />
  <p id="cost-scratch" tabIndex={-1} className="scroll-mt-24 rounded-lg bg-status-warning-bg p-3">Review each expense for Bale, payroll or rental duplicates before choosing. A confirmed rental is already represented by its linked expense—never add it again. The AI Bale hint is not proof. Legacy or externally paid payroll, correction amounts, missing allocations and unrecorded expenses may be absent from the estimate. Matching voucher adjustment cases are shown separately, without allocating them. Check original records and other projects independently.</p>
  <Button type="button" size="sm" variant="secondary" disabled={loading} onClick={load}>{snapshot?'Reload review snapshot':'Load review snapshot'}</Button>
  {loading&&<p role="status">Loading complete review snapshot…</p>}{error&&<p role="alert">{error}</p>}
  {snapshot&&<>
   <p>Snapshot captured {snapshot.capturedAt}. It can become stale immediately. Reload before relying on it; choices are cleared on reload, navigation or account change.</p>
   <h5 className="font-semibold text-navy">Paid worker allocations ({snapshot.paid.length})</h5>
   {snapshot.paid.length?<ul className="max-h-64 overflow-auto divide-y divide-surface-border">{snapshot.paid.map(p=><li key={p.payrollId} className="py-2"><p className="font-semibold text-navy break-words">{p.workerName} · {p.start} to {p.end} · {formatCostCents(costCents(p.gross))}</p><p>Paid date recorded {p.paymentDate} · Voucher {p.payrollId}</p><p>Whole worker-week voucher: gross {formatCostCents(costCents(p.voucherGross))}, Bale {formatCostCents(costCents(p.voucherBale))}, other deductions {formatCostCents(costCents(p.voucherOther))}, net {formatCostCents(costCents(p.voucherNet))}. Bale is a worker-wide comparison, not a site allocation or additional cost.</p></li>)}</ul>:<p>No matching paid allocations returned. This does not prove there are no payroll costs.</p>}
   <ProjectAdjustmentSignals snapshot={snapshot} />
   <h5 className="font-semibold text-navy">Review every recorded expense ({snapshot.expenses.length})</h5>
   {snapshot.expenses.length?<div className="max-h-[32rem] overflow-auto divide-y divide-surface-border">{snapshot.expenses.map(e=><fieldset key={e.id} className="space-y-2 py-3"><legend className="sr-only">Expense {e.id}</legend><p className="font-semibold text-navy break-words">{e.description} · {formatCostCents(costCents(e.amount))}</p><p>{e.category} · {e.date} · {e.baleHint?'AI flagged possible Bale; verify':'No AI Bale flag; still verify'}</p><p className="break-all">Expense {e.id}</p><PotentialDuplicateExpense ids={duplicates.get(e.id)}/><PotentialPayrollOverlap expense={e}/>{e.rental&&<p>Confirmed rental: {e.rental.item} · {e.rental.supplier} · {e.rental.start} to {e.rental.end}. This is the same expense, not an extra amount.</p>}
    <div className="flex flex-wrap gap-3"><label className="flex items-center gap-1"><input type="radio" name={`cost-${e.id}`} checked={choices[e.id]==='include'} onChange={()=>{setChoices(c=>({...c,[e.id]:'include'}));setAck(false);}}/> Include expense</label><label className="flex items-center gap-1"><input type="radio" name={`cost-${e.id}`} checked={choices[e.id]==='exclude'} onChange={()=>{setChoices(c=>({...c,[e.id]:'exclude'}));setAck(false);}}/> Exclude from this preview</label></div>
    {projectCostReviewLedgerPreviewEnabled()&&choices[e.id]==='exclude'&&<label className="block">Reason for excluding {e.description}<input type="text" className="mt-1 block min-h-11 w-full rounded-lg border border-surface-border p-2" maxLength={300} value={reasons[e.id]??''} onChange={event=>setReasons(r=>({...r,[e.id]:event.target.value}))} /></label>}
   </fieldset>)}</div>:<p>No recorded expenses returned. This does not prove all expenses were recorded.</p>}
   <label className="flex items-start gap-2"><input type="checkbox" checked={ack} disabled={!reviewed} onChange={e=>setAck(e.target.checked)}/> I reviewed every expense and paid allocation for possible duplicates and understand this is an incomplete, unsaved estimate.</label>
   {estimate&&<div aria-live="polite" className="rounded-lg border border-surface-border p-3 space-y-1"><p className="font-semibold text-navy">Temporary, incomplete estimate: {formatCostCents(estimate.total)}</p><p>Included recorded expenses {formatCostCents(estimate.expenses)} + paid worker gross allocations {formatCostCents(estimate.payroll)}.</p><p>Expenses excluded from this preview: {formatCostCents(estimate.excluded)}. Rentals are not added separately.</p><p>Not saved, posted, automatically reconciled, or a profit figure. Refresh and independently verify before use.</p></div>}
  </>}
  {historicalCostReviewPreviewEnabled()&&<div id="cost-historical-review" tabIndex={-1} className="scroll-mt-24"><HistoricalCostReview key={`${scope}:combined`} projectId={projectId} userId={userId}/></div>}
  {historicalWorkerAttributionPreviewEnabled()&&<div id="cost-historical-evidence" tabIndex={-1} className="scroll-mt-24"><HistoricalWorkerAttributions key={`${scope}:attributions`} projectId={projectId} userId={userId} /></div>}
  {projectCostCorrectionPreviewEnabled()&&<div id="cost-correction-evidence" tabIndex={-1} className="scroll-mt-24"><ProjectCorrectionEvidence key={`${scope}:corrections`} projectId={projectId} userId={userId} /></div>}
  {projectCostReviewLedgerPreviewEnabled()&&!historicalCostReviewPreviewEnabled()&&<div id="cost-review-ledger" tabIndex={-1} className="scroll-mt-24"><ProjectCostReviewLedger key={`${scope}:ledger`} projectId={projectId} userId={userId} snapshot={snapshot} raw={snapshot?snapshotEvidence:null} choices={choices} reasons={reasons} /></div>}
  </div>
 </section>;
}
