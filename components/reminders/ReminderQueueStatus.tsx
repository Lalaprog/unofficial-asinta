'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { isReminderSettings } from '@/lib/reminders/settings';

/** An environment switch alone does not establish that reminders are running. */
export function ReminderQueueStatus() {
  const [status, setStatus] = useState<'loading' | 'off' | 'unknown'>('loading');
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    setStatus('loading');
    try {
      const response = await fetch('/api/reminders/settings', {cache:'no-store'});
      const data = await response.json();
      if (!response.ok || typeof data?.rolloutReady !== 'boolean' || !isReminderSettings(data?.settings)) throw Error('unknown');
      // A false master switch is conclusive; an enabled switch does not prove
      // the scheduler/provider is working, so don't report sending as ON.
      if (generation.current === current) setStatus(data.settings.master_enabled === false ? 'off' : 'unknown');
    } catch { if (generation.current === current) setStatus('unknown'); }
  }, []);
  useEffect(() => {
    void refresh();
    window.addEventListener('focus', refresh);
    return () => { generation.current += 1; window.removeEventListener('focus', refresh); };
  }, [refresh]);

  return <div className="flex flex-wrap items-center gap-2">
    <Badge variant="neutral" size="sm">{status === 'loading' ? 'Checking automatic reminders…' : status === 'off' ? 'Automatic reminders: OFF' : 'Automatic reminder status unavailable'}</Badge>
    {status === 'unknown' && <Button type="button" variant="secondary" size="sm" onClick={refresh}>Retry status</Button>}
  </div>;
}
