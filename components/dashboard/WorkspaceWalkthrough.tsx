'use client';

import { useEffect, useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { PageWalkthrough } from './DashboardWalkthrough';
import { getWorkspaceGuide, WORKSPACE_GUIDE_EVENT } from '@/lib/guides/workspace';

export function WorkspaceWalkthrough({ isFounder }: { isFounder: boolean }) {
  const path = usePathname();
  const params = useSearchParams();
  const queryTab = params?.get('tab') || 'terminal';
  const [attendanceTab, setAttendanceTab] = useState(queryTab);
  useEffect(() => { setAttendanceTab(queryTab); }, [path, queryTab]);
  useEffect(() => {
    const update = (event: Event) => { const tab = (event as CustomEvent<string>).detail; if (tab) setAttendanceTab(tab); };
    window.addEventListener('bale:attendance-tab', update);
    return () => window.removeEventListener('bale:attendance-tab', update);
  }, []);
  const config = getWorkspaceGuide(path, isFounder, attendanceTab);
  if (!config) return null;
  return <PageWalkthrough key={`${path}:${attendanceTab}:${isFounder}:${config.label}`} eventName={WORKSPACE_GUIDE_EVENT} label={config.label} targetAttribute="data-page-guide" steps={config.steps} />;
}
