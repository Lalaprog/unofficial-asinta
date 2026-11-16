'use client';
import { financeFoundationEnabled, historicalExternalWorkerPreviewEnabled, supervisorPayrollLedgerPreviewEnabled, supervisorPayrollPreviewEnabled } from '@/lib/finance/featureAvailability';
import { AdvancedTools } from '@/components/ui/AdvancedTools';
import { SupervisorPayrollLedger } from './SupervisorPayrollLedger';
import { HistoricalExternalWorker } from './HistoricalExternalWorker';
import { WorkerAllowanceQueue } from './WorkerAllowanceQueue';
import { WeeklyWorkerPreview } from './WeeklyWorkerPreview';
import { PaidHistoryReview } from './PaidHistoryReview';
import { SupervisorPayrollPreview } from './SupervisorPayrollPreview';

/**
 * One primary task (this week's worker pay) plus one closed drawer.
 * Previously seven panels competed for attention on the same screen, which
 * made the page unreadable. Nothing was removed; the review, allowance,
 * Supervisor and historical tools moved into "More payroll tools".
 */
export function PayrollFoundationPanels() {
  if (!financeFoundationEnabled()) return null;
  const hasSupervisorTools = supervisorPayrollPreviewEnabled() || supervisorPayrollLedgerPreviewEnabled();
  return <section id="payroll-workspaces" tabIndex={-1} aria-labelledby="payroll-workspaces-heading" className="scroll-mt-24 space-y-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">
    <div>
      <h2 id="payroll-workspaces-heading" className="text-base font-semibold text-navy">1. This week&rsquo;s worker pay</h2>
      <p className="mt-1 text-xs leading-relaxed text-ink-secondary">Load the week, check the amounts, then save a draft. Approval and payment are separate steps inside the table.</p>
    </div>
    <WeeklyWorkerPreview />
    <AdvancedTools
      title="More payroll tools"
      description="Allowances, Supervisor pay, historical pay and paid-record reviews. Open only when you need them."
    >
      <div className="workspace-bento">
        <div><WorkerAllowanceQueue /></div>
        {hasSupervisorTools && <>
          {supervisorPayrollPreviewEnabled() && <div><SupervisorPayrollPreview /></div>}
          {supervisorPayrollLedgerPreviewEnabled() && <div><SupervisorPayrollLedger /></div>}
        </>}
        <div><PaidHistoryReview /></div>
        {historicalExternalWorkerPreviewEnabled() && <div><HistoricalExternalWorker /></div>}
      </div>
    </AdvancedTools>
  </section>;
}
