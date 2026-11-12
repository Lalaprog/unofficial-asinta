'use client';
import { financeFoundationEnabled, supervisorPayrollPreviewEnabled } from '@/lib/finance/featureAvailability';
import { WorkerAllowanceQueue } from './WorkerAllowanceQueue';
import { WeeklyWorkerPreview } from './WeeklyWorkerPreview';
import { PaidHistoryReview } from './PaidHistoryReview';
import { SupervisorPayrollPreview } from './SupervisorPayrollPreview';

/** UI rollout switch only; database authorization remains mandatory. */
export function PayrollFoundationPanels() {
  if (!financeFoundationEnabled()) return null;
  return <><WorkerAllowanceQueue /><WeeklyWorkerPreview />{supervisorPayrollPreviewEnabled() && <SupervisorPayrollPreview />}<PaidHistoryReview /></>;
}
