'use client';
import { financeFoundationEnabled } from '@/lib/finance/featureAvailability';
import { AdvancedTools } from '@/components/ui/AdvancedTools';
import { SupervisorDayPanel } from './SupervisorDayPanel';
import { SupervisorLeavePanel } from './SupervisorLeavePanel';

/**
 * Supervisor attendance and leave are a separate workflow from the crew Roll
 * Call, and used to compete with it for attention. They now live in one
 * closed drawer; the Roll Call remains the only thing on the page by default.
 */
export function SupervisorFoundationPanels() {
  if (!financeFoundationEnabled()) return null;
  return <AdvancedTools
    title="My own attendance and leave"
    description="The Supervisor's own working days and leave requests. This is separate from the crew Roll Call."
  >
    <div className="workspace-bento"><div><SupervisorDayPanel /></div><div><SupervisorLeavePanel /></div></div>
  </AdvancedTools>;
}
