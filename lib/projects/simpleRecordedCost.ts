import {calculateCorrected,parseCorrectedInventory,type CorrectedChoices,type CorrectedTotals} from './correctedCostReview';
import {parseRecordedCostCoverage} from './recordedCostCoverage';
import {potentialDuplicateExpenses,potentialPayrollOverlap} from './projectCostReconciliation';

type Coverage=ReturnType<typeof parseRecordedCostCoverage>;
export type SimpleRecordedCost={coverage:Coverage;issues:string[];totals:CorrectedTotals|null};
/** Compute an indicative recorded amount only when known issues do not need a
 * decision. This never writes classifications or establishes completeness. */
export function parseSimpleRecordedCost(raw:unknown,projectId:string):SimpleRecordedCost{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Invalid recorded cost snapshot');
 const v=raw as Record<string,unknown>;
 if(v.project_id!==projectId||Object.keys(v).sort().join(',')!=='coverage,inventory,project_id')throw Error('Invalid recorded cost scope');
 const coverage=parseRecordedCostCoverage(v.coverage,projectId);
 let inv:ReturnType<typeof parseCorrectedInventory>;
 try{inv=parseCorrectedInventory(v.inventory,projectId);}catch{return {coverage,issues:['Expense, payroll or correction evidence changed or could not be verified.'],totals:null};}
 if(Date.parse(coverage.capturedAt)!==Date.parse(inv.historical.base.capturedAt))throw Error('Cost evidence captured at different times');
 const issues:string[]=[];
 if(coverage.unallocatedPaid||coverage.inconsistentAllocations||coverage.unattributedHistory)issues.push('Some paid or historical payroll records need project attribution or investigation.');
 const expenses=inv.historical.base.expenses,duplicates=potentialDuplicateExpenses(expenses);
 if(expenses.some(e=>e.baleHint||potentialPayrollOverlap(e)||duplicates.has(e.id)))issues.push('Some expenses may duplicate payroll, Bale or another expense.');
 if(inv.historical.historical.some(h=>h.overlappingVouchers>0))issues.push('A historical payroll record overlaps a voucher.');
 if(inv.cases.some(c=>!c.sourceInSnapshot||c.status==='pending'||c.pendingSibling||!c.review.attribution||c.review.attribution.case_changed||c.siteChange===null))issues.push('Some original-period corrections need review or a verified source project.');
 const sources=new Set<string>();let multiple=false;for(const c of inv.cases){const key=`${c.kind}:${c.sourceId}`;if(sources.has(key))multiple=true;sources.add(key);}
 if(multiple)issues.push('Multiple corrections for one payroll record need a distinct-effects review.');
 // Never replace a previously saved human decision with automatic inclusion.
 if(coverage.review.found)issues.push('Use the saved cost review rather than an automatic recorded amount.');
 if(issues.length)return {coverage,issues,totals:null};
 const choices:CorrectedChoices={expenses:{},historical:{},corrections:{}};
 for(const e of expenses)choices.expenses[e.id]={decision:'include',reason:null};
 for(const h of inv.historical.historical)choices.historical[h.requestId]={decision:'include',reason:null};
 for(const c of inv.cases)choices.corrections[c.key]={decision:'include',reason:'Previously recorded correction evidence'};
 try{return {coverage,issues,totals:calculateCorrected(inv,choices).totals};}
 catch{return {coverage,issues:['Recorded payroll or correction evidence needs further review.'],totals:null};}
}
