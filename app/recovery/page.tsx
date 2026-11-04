'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth/authContext';
import { clearRecoveryChoice } from '@/lib/auth/recovery';
import { AsintaLoader } from '@/components/ui/AsintaLoader';
import { AsintaEmblem, AsintaWordmark } from '@/components/ui/AsintaLogo';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';

/** Optional choice after email-code sign-in, never an authentication boundary. */
export default function RecoveryChoicePage() {
  const { user, assurance, isLoading } = useAuth();
  const router = useRouter();
  const [changing, setChanging] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!isLoading && (!user || assurance === 'required' || assurance === 'unavailable')) {
      router.replace('/?redirect_to=%2Frecovery');
    }
  }, [user, assurance, isLoading, router]);

  const continueToWorkspace = () => {
    clearRecoveryChoice();
    router.replace(user?.role === 'founder' ? '/dashboard' : '/attendance');
    router.refresh();
  };

  const savePassword = async (event: React.FormEvent) => {
    event.preventDefault(); setError(null);
    if (password !== confirmation) { setError('The passwords do not match.'); return; }
    setSaving(true);
    try {
      const response = await fetch('/api/auth/recovery-password', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newPassword: password }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(body.error || 'Could not change your password. Please try again.');
        return;
      }
      setPassword(''); setConfirmation(''); continueToWorkspace();
    } catch {
      setError('The password change could not be confirmed. Sign in again before retrying.');
    } finally { setSaving(false); }
  };

  if (isLoading || !user || assurance !== 'ready') {
    return <AsintaLoader variant="fullscreen" title="Checking account security…" subtitle="Preparing your workspace securely" />;
  }
  return (
    <main className="min-h-[100lvh] flex items-center justify-center bg-surface p-4">
      <div className="w-full max-w-md rounded-2xl border border-surface-border bg-white p-6 sm:p-8 shadow-xl space-y-5">
        <div className="flex items-center gap-3"><AsintaEmblem size={36} /><AsintaWordmark height={20} /></div>
        <div>
          <h1 className="text-xl font-extrabold text-navy">You’re signed in</h1>
          <p className="mt-2 text-xs text-ink-secondary leading-relaxed">Would you like to change your password now? You can also continue without changing it.</p>
        </div>
        {changing ? (
          <form onSubmit={savePassword} className="space-y-4">
            <Input label="New password" type="password" autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} required />
            <Input label="Confirm new password" type="password" autoComplete="new-password" value={confirmation} onChange={e => setConfirmation(e.target.value)} required />
            <p className="text-xs text-ink-secondary">Use at least 8 characters with letters and numbers.</p>
            {error && <p role="alert" className="text-xs text-status-danger">{error}</p>}
            <div className="flex gap-2">
              <Button type="button" variant="secondary" onClick={() => { setChanging(false); setPassword(''); setConfirmation(''); setError(null); }} disabled={saving}>Back</Button>
              <Button type="submit" variant="primary" isLoading={saving}>Save and continue</Button>
            </div>
          </form>
        ) : (
          <div className="flex flex-col gap-2">
            <Button variant="primary" onClick={() => setChanging(true)}>Change password now</Button>
            <Button variant="secondary" onClick={continueToWorkspace}>Not now — continue</Button>
          </div>
        )}
      </div>
    </main>
  );
}
