'use client';
import { financeFoundationEnabled } from '@/lib/finance/featureAvailability';
import { WorkerAllowanceQueue } from './WorkerAllowanceQueue';
import { WeeklyWorkerPreview } from './WeeklyWorkerPreview';
import { PaidHistoryReview } from './PaidHistoryReview';

/** UI rollout switch only; database authorization remains mandatory. */
export function PayrollFoundationPanels() {
  if (!financeFoundationEnabled()) return null;
  return <><WorkerAllowanceQueue /><WeeklyWorkerPreview /><PaidHistoryReview /></>;
}
