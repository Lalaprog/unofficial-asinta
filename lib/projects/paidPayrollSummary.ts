import {parseCostSnapshot,type CostSnapshot} from './projectCostReconciliation';

/** Independently verify the same payroll and correction evidence as the full
 * reconciliation, without pretending the response contains expense evidence. */
export function parsePaidPayrollSummary(raw:unknown,projectId:string):Pick<CostSnapshot,'projectId'|'capturedAt'|'paid'|'adjustments'> {
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Invalid payroll summary');
 const row=raw as Record<string,unknown>;
 if(Object.keys(row).sort().join(',')!=='adjustment_cases,captured_at,paid_allocations,project_id')throw Error('Invalid payroll summary fields');
 const parsed=parseCostSnapshot({...row,expenses:[],rentals:[]},projectId);
 return {projectId:parsed.projectId,capturedAt:parsed.capturedAt,paid:parsed.paid,adjustments:parsed.adjustments};
}
