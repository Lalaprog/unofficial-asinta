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
  return <><WorkerAllowanceQueue /><WeeklyWorkerPreview />{supervisorPayrollPreviewEnabled() && <SupervisorPayrollPreview />}{supervisorPayrollLedgerPreviewEnabled() && <SupervisorPayrollLedger />}<PaidHistoryReview />{historicalExternalWorkerPreviewEnabled() && <HistoricalExternalWorker />}</>;
}
