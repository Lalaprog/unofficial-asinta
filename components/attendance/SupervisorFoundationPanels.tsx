'use client';
import { financeFoundationEnabled } from '@/lib/finance/featureAvailability';
import { SupervisorDayPanel } from './SupervisorDayPanel';
import { SupervisorLeavePanel } from './SupervisorLeavePanel';

/** UI rollout switch only; database authorization remains mandatory. */
export function SupervisorFoundationPanels() {
  if (!financeFoundationEnabled()) return null;
  return <section id="supervisor-attendance-tools" tabIndex={-1} aria-labelledby="supervisor-workspaces-heading" className="scroll-mt-24 space-y-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">
    <div>
      <h2 id="supervisor-workspaces-heading" className="text-sm font-semibold text-navy">Supervisor attendance &amp; leave</h2>
      <p className="mt-1 text-xs text-ink-secondary">Separate from the crew Roll Call below.</p>
    </div>
    <div className="workspace-bento"><div><SupervisorDayPanel /></div><div><SupervisorLeavePanel /></div></div>
  </section>;
}
