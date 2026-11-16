import React from 'react';
import {costCents,formatCostCents,type CostSnapshot} from '@/lib/projects/projectCostReconciliation';

/** Evidence only: the difference belongs to a whole voucher, not to this site. */
export function ProjectAdjustmentSignals({snapshot}:{snapshot:CostSnapshot}){
 const amount=(difference:string)=>`${difference.startsWith('-')?'−':''}${formatCostCents(costCents(difference.replace(/^-/,'')))}`;
 return <div className="space-y-2 rounded-lg bg-status-warning-bg p-3">
  <h5 className="font-semibold text-navy">Original-period adjustment cases ({snapshot.adjustments.length})</h5>
  <p>These cases relate to worker vouchers with a paid allocation at this site. The difference is for the whole voucher, not a site allocation. A positive difference means more may be due; a negative difference indicates a possible overpayment. A case can appear at multiple sites. No amount below is added to this estimate; a recorded settlement is not proof of payment.</p>
  {snapshot.adjustments.length?<ul className="max-h-64 overflow-auto divide-y divide-surface-border">{snapshot.adjustments.map(a=><li key={a.id} className="py-2 break-words"><p className="font-semibold text-navy">{snapshot.paid.find(p=>p.payrollId===a.payrollId)?.workerName} · {a.status==='pending'?'Pending review':a.status==='settled_external'?'External settlement recorded':'No transfer recorded'} · whole-voucher difference {amount(a.difference)}</p><p>Voucher {a.payrollId} · case {a.id}</p><p>Reason: {a.reason}</p>{a.status!=='pending'&&<p>Resolution: {a.resolutionNote}{a.settledOn&&` · recorded date ${a.settledOn}`}</p>}</li>)}</ul>:<p>No matching cases in the included vouchers. This does not prove all corrections or costs are recorded.</p>}
 </div>;
}
