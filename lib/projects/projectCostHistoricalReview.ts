import {costCents,estimateProjectCost,parseCostSnapshot,type CostChoice,type CostSnapshot} from './projectCostReconciliation';
import {parseHistoricalProjectAttributions,type HistoricalProjectAttribution} from './historicalWorkerAttributions';
export type HistoricalCostItem=HistoricalProjectAttribution&{overlappingVouchers:number};
export type HistoricalCostSnapshot={base:CostSnapshot;historical:HistoricalCostItem[]};
/** Fail closed on absent, cross-project, malformed or inconsistent evidence. */
export function parseHistoricalCostSnapshot(raw:unknown,projectId:string):HistoricalCostSnapshot{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Invalid combined project review');
 const v=raw as Record<string,unknown>;if(v.project_id!==projectId||!Array.isArray(v.historical)||Object.keys(v).sort().join(',')!=='base,historical,project_id')throw Error('Invalid combined project review');
 const base=parseCostSnapshot(v.base,projectId),historical=parseHistoricalProjectAttributions({project_id:projectId,items:v.historical},projectId);
 return {base,historical:historical.map((item,index)=>{
  const x=v.historical as Record<string,unknown>[];const count=x[index]?.overlapping_vouchers;
  if(typeof count!=='number'||!Number.isSafeInteger(count)||count<0)throw Error('Invalid overlapping voucher signal');
  // Catch an inconsistent response even if the count was forged or truncated.
  if(base.paid.some(p=>p.workerId===item.workerId&&p.start<=item.end&&p.end>=item.start)&&count===0)throw Error('Overlapping voucher signal missing');
  return {...item,overlappingVouchers:count};
 })};
}
/** Explicit choices for every record; flagged history cannot be included. */
export function estimateHistoricalProjectCost(snapshot:HistoricalCostSnapshot,expenses:Record<string,CostChoice>,history:Record<string,CostChoice>){
 const validKeys=(actual:Record<string,CostChoice>,expected:string[])=>Object.keys(actual).length===expected.length&&expected.every(id=>Object.hasOwn(actual,id));
 if(!validKeys(expenses,snapshot.base.expenses.map(e=>e.id))||!validKeys(history,snapshot.historical.map(h=>h.requestId)))throw Error('Review every returned item');
 const base=estimateProjectCost(snapshot.base,expenses);let historical=0n,excludedHistorical=0n;
 for(const h of snapshot.historical){const decision=history[h.requestId];if(decision!=='include'&&decision!=='exclude')throw Error('Review every historical item');
  if(decision==='include'){if(h.caseCount||h.overlappingVouchers)throw Error('Investigate case or overlap first');historical+=costCents(h.siteGross);}else excludedHistorical+=costCents(h.siteGross);
 }
 return {...base,historical,excludedHistorical,total:base.total+historical};
}
