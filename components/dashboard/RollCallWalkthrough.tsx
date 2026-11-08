'use client';

import { PageWalkthrough, ROLL_CALL_GUIDE_EVENT } from './DashboardWalkthrough';

const COMMON = [
  { target: 'site', title: 'Project and date', description: 'Choose the site and date carefully before marking attendance. Saved attendance belongs to that site and date.' },
  { target: 'summary', title: 'Crew status', description: 'See how many workers are marked and how many still need a status. Your device can keep an unfinished draft; it is not official attendance until submitted.' },
  { target: 'filters', title: 'Find a worker', description: 'Search, filter by craft or show unmarked workers. Filters change the visible list, not the full submission requirements.' },
  { target: 'crew', title: 'Mark the crew', description: 'Choose a status for each worker. Check any warning about attendance at another site before submitting.' },
] as const;
const FOUNDER = [...COMMON, { target: 'submit', title: 'Save Roll Call', description: 'Review the selections and submit. Supervisor attendance may need Founder review; check warnings before payroll.' }] as const;
const SUPERVISOR = [...COMMON, { target: 'submit', title: 'Submit Roll Call', description: 'Review the selections and submit. Your linked Supervisor attendance can be auto-logged and may need Founder review.' }] as const;

export function RollCallWalkthrough({ isSupervisor }: { isSupervisor: boolean }) {
  return <PageWalkthrough eventName={ROLL_CALL_GUIDE_EVENT} label="Roll Call guide" targetAttribute="data-roll-call-guide" steps={isSupervisor ? SUPERVISOR : FOUNDER} />;
}
