'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { isReminderSettings, type ReminderSettings } from '@/lib/reminders/settings';
import { Button } from '@/components/ui/Button';

/** Preparation only: neither the database lock nor the master switch is lifted. */
export function ReminderPreferences() {
  const [saved, setSaved] = useState<ReminderSettings | null>(null);
  const [email, setEmail] = useState(false);
  const [sms, setSms] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const saveLock = useRef(false);
  const generation = useRef(0);

  const load = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true); setSaved(null); setNotice('');
    try {
      const response = await fetch('/api/reminders/settings', { cache: 'no-store' });
      const data = await response.json();
      // This component is deliberately locked for the staged rollout. It must
      // not present an unexpected or malformed response as a safe setting.
      if (!response.ok || data.rolloutReady !== false || !isReminderSettings(data.settings) || data.settings.master_enabled !== false) throw Error('unavailable');
      if (generation.current !== current) return;
      setSaved(data.settings); setEmail(data.settings.email_enabled); setSms(data.settings.sms_enabled);
    } catch {
      if (generation.current === current) setNotice('Could not load reminder preferences. Refresh before trying again.');
    } finally {
      if (generation.current === current) setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); return () => { generation.current += 1; }; }, [load]);

  const save = async () => {
    if (!saved || saveLock.current) return;
    saveLock.current = true; setSaving(true); setNotice('');
    try {
      const response = await fetch('/api/reminders/settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ master_enabled: false, email_enabled: email, sms_enabled: sms, revision: saved.revision }),
      });
      const data = await response.json();
      if (!response.ok || data.rolloutReady !== false || !isReminderSettings(data.settings) || data.settings.master_enabled !== false || data.settings.email_enabled !== email || data.settings.sms_enabled !== sms) throw Error('unconfirmed');
      setSaved(data.settings); setNotice('Preferences saved. Automatic reminders are still off.');
    } catch {
      // A failed response can follow a committed update. Never repeat a stale
      // revision or imply that nothing changed: require a fresh read.
      setSaved(null); setNotice('Save was not confirmed. Refresh preferences before trying again.');
    } finally { saveLock.current = false; setSaving(false); }
  };

  return (
    <div className="p-4 rounded-2xl bg-surface-inset/50 border border-surface-border space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-bold text-navy">Automatic reminders</span>
        <span className="text-ink-muted font-semibold">Not active</span>
      </div>
      <p className="text-ink-secondary">Automatic email and SMS reminders are still being prepared. You can save your channel preferences now; this will not send messages or turn reminders on.</p>
      <label className="flex items-center gap-2 text-ink-muted"><input type="checkbox" checked={false} disabled readOnly /> Automatic reminders</label>
      {loading ? <p role="status" className="text-ink-secondary">Loading preferences…</p> : saved ? (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            <label className="flex items-center gap-2 text-navy"><input type="checkbox" checked={email} disabled={saving} onChange={(e) => setEmail(e.target.checked)} /> Email</label>
            <label className="flex items-center gap-2 text-navy"><input type="checkbox" checked={sms} disabled={saving} onChange={(e) => setSms(e.target.checked)} /> SMS</label>
          </div>
          <p className="text-ink-muted">When available, reminders are planned for three days before, on the due date, three days after, and weekly thereafter, Monday–Saturday during Manila business hours. SMS charges may apply.</p>
          <Button type="button" size="sm" onClick={save} isLoading={saving} disabled={saving || (email === saved.email_enabled && sms === saved.sms_enabled)}>Save preferences</Button>
        </div>
      ) : <Button type="button" variant="secondary" size="sm" onClick={load}>Refresh preferences</Button>}
      {notice && <p role="status" className="text-ink-secondary">{notice}</p>}
    </div>
  );
}
