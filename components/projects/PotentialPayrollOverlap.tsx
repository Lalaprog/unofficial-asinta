import React from 'react';
import {potentialPayrollOverlap,type CostExpense} from '@/lib/projects/projectCostReconciliation';

export function PotentialPayrollOverlap({expense}:{expense:CostExpense}) {
 if(!potentialPayrollOverlap(expense))return null;
 return <p className="rounded-lg bg-status-warning-bg p-2 text-status-warning">Possible payroll or Bale overlap based on category or description. Compare the original records before including; this may be a separate legitimate expense. Other overlaps may not be detected.</p>;
}
