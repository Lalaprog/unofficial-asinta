import {describe,expect,it} from 'vitest';
import {calculateCorrected,formatSignedCost,parseCorrectedInventory,parseCorrectedSaved,verifyCorrectedTotals} from '@/lib/projects/correctedCostReview';
import {actor,caseId,choices,history,inventory,request,result,saved,site} from './helpers/corrected-cost-ui-fixture';
describe('corrected review response validation',()=>{
 it('checks signed cents and independently recalculates saved results',()=>{const parsed=parseCorrectedInventory(inventory,site),x=calculateCorrected(parsed,choices);expect(x.totals).toMatchObject({expenses:5025n,paid:60000n,historical:40025n,correction:-1250n,total:103800n});expect(formatSignedCost(-1250n)).toBe('−₱12.50');expect(verifyCorrectedTotals(result,site,x.totals).total).toBe(103800n);expect(parseCorrectedSaved(saved(request),site)).toMatchObject({found:true,actorId:actor,totals:{total:103800n}});expect(()=>parseCorrectedSaved({...saved(request),result:{...result,incomplete_total:'1039.00'}},site)).toThrow(/differs/);});
 it('does not substitute zero for missing attribution or omit source cases',()=>{
  const missing=structuredClone(inventory);missing.corrections[0].evidence.latest_revision=0;missing.corrections[0].evidence.attribution=null as never;missing.corrections[0].site_gross_change=null as never;
  const parsed=parseCorrectedInventory(missing,site);expect(parsed.cases[0].siteChange).toBeNull();expect(()=>calculateCorrected(parsed,choices)).toThrow(/current resolved/);
  expect(()=>parseCorrectedInventory({...inventory,corrections:[]},site)).toThrow(/Missing voucher/);
  const bad=structuredClone(missing);bad.corrections[0].site_gross_change='0.00';expect(()=>parseCorrectedInventory(bad,site)).toThrow(/not zero/);
  const historyMismatch=structuredClone(inventory);historyMismatch.historical_review.historical[0].case_count=1;expect(()=>parseCorrectedInventory(historyMismatch,site)).toThrow(/Missing historical/);
 });
 it('shows a pending case as missing evidence and requires an explicit exclusion',()=>{
  const pending=structuredClone(inventory),row=pending.corrections[0],current=row.evidence.case;
  current.status='pending';current.resolved_at=null as never;current.resolved_by=null as never;current.resolution_note=null as never;
  current.related_cases[0].status='pending';current.related_cases[0].resolved_at=null as never;current.related_cases[0].resolved_by=null as never;current.related_cases[0].resolution_note=null as never;
  const signal=pending.historical_review.base.adjustment_cases[0];signal.status='pending';signal.resolved_at=null as never;signal.resolved_by=null as never;signal.resolution_note=null as never;
  row.evidence.latest_revision=0;row.evidence.attribution=null as never;row.site_gross_change=null as never;
  const parsed=parseCorrectedInventory(pending,site);expect(parsed.cases[0]).toMatchObject({status:'pending',siteChange:null,pendingSibling:true});expect(()=>calculateCorrected(parsed,choices)).toThrow(/current resolved/);
  const excluded=structuredClone(choices);excluded.corrections[`voucher:${caseId}`]={decision:'exclude',reason:'Pending case investigated later'};expect(calculateCorrected(parsed,excluded).totals).toMatchObject({excludedCases:1,total:105050n});
 });
 it('rejects malformed evidence, stale cases, excluded originals and incomplete decisions',()=>{
  const bad=structuredClone(inventory);bad.corrections[0].site_gross_change='-10.00';expect(()=>parseCorrectedInventory(bad,site)).toThrow(/split differs/);
  expect(()=>parseCorrectedInventory({...inventory,project_id:request},site)).toThrow();const parsed=parseCorrectedInventory(inventory,site);
  expect(()=>calculateCorrected(parsed,{...choices,corrections:{}})).toThrow(/every item/);
  const changed=structuredClone(inventory);changed.corrections[0].evidence.attribution.case_snapshot={...changed.corrections[0].evidence.attribution.case_snapshot,reason:'Old reason'};changed.corrections[0].evidence.attribution.case_changed=true;expect(()=>calculateCorrected(parseCorrectedInventory(changed,site),choices)).toThrow(/current resolved/);
  const historicalExcluded=structuredClone(choices);historicalExcluded.historical[history]={decision:'exclude',reason:'Duplicate'};expect(calculateCorrected(parsed,historicalExcluded).totals.total).toBe(63775n);
  const wrong=structuredClone(choices);wrong.corrections[`voucher:${caseId}`].reason=' ';expect(()=>calculateCorrected(parsed,wrong)).toThrow(/Explain/);
 });
});
