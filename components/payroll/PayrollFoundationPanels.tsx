'use client';
import { financeFoundationEnabled, historicalExternalWorkerPreviewEnabled, supervisorPayrollLedgerPreviewEnabled, supervisorPayrollPreviewEnabled } from '@/lib/finance/featureAvailability';
import { SupervisorPayrollLedger } from './SupervisorPayrollLedger';
import { HistoricalExternalWorker } from './HistoricalExternalWorker';
import { WorkerAllowanceQueue } from './WorkerAllowanceQueue';
import { WeeklyWorkerPreview } from './WeeklyWorkerPreview';
import { PaidHistoryReview } from './PaidHistoryReview';
import { SupervisorPayrollPreview } from './SupervisorPayrollPreview';

/** UI rollout switch only; database authorization remains mandatory. */
export function PayrollFoundationPanels() {
  if (!financeFoundationEnabled()) return null;
  const hasSupervisorTools = supervisorPayrollPreviewEnabled() || supervisorPayrollLedgerPreviewEnabled();
  return <section id="payroll-workspaces" tabIndex={-1} aria-labelledby="payroll-workspaces-heading" className="scroll-mt-24 space-y-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">
    <div>
      <h2 id="payroll-workspaces-heading" className="text-base font-semibold text-navy">Payroll workspaces</h2>
      <p className="mt-1 text-xs leading-relaxed text-ink-secondary">Choose a task to open its controls. Recorded payments and reviews remain separate.</p>
    </div>
    <div className="workspace-bento">
      <div><WeeklyWorkerPreview /></div>
      <div><WorkerAllowanceQueue /></div>
      {hasSupervisorTools && <>
        {supervisorPayrollPreviewEnabled() && <div><SupervisorPayrollPreview /></div>}
        {supervisorPayrollLedgerPreviewEnabled() && <div><SupervisorPayrollLedger /></div>}
      </>}
      <div><PaidHistoryReview /></div>
      {historicalExternalWorkerPreviewEnabled() && <div><HistoricalExternalWorker /></div>}
    </div>
  </section>;
}
