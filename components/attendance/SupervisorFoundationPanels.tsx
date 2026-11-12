'use client';
import { financeFoundationEnabled } from '@/lib/finance/featureAvailability';
import { SupervisorDayPanel } from './SupervisorDayPanel';
import { SupervisorLeavePanel } from './SupervisorLeavePanel';

/** UI rollout switch only; database authorization remains mandatory. */
export function SupervisorFoundationPanels() {
  if (!financeFoundationEnabled()) return null;
  return <><SupervisorDayPanel /><SupervisorLeavePanel /></>;
}
