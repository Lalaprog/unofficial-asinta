'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { KeyRound, CheckCircle2, LogOut } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/lib/auth/authContext';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';

/**
 * Forces a newly provisioned user (whose `user_metadata.must_change_password`
 * is `true`) to replace their Founder-issued temporary password with their own
 * personal password before accessing the BALE workspace.
 */
export const PasswordSetupGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user, logout } = useAuth();
  const supabase = useMemo(() => createClient(), []);

  const [mustChange, setMustChange] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    if (!user?.id) {
      setMustChange(false);
      return;
    }

    supabase.auth
      .getUser()
      .then(({ data }) => {
        if (!active) return;
        const flag = Boolean(data?.user?.user_metadata?.must_change_password);
        setMustChange(flag);
      })
      .catch(() => {
        if (active) setMustChange(false);
      });

    return () => {
      active = false;
    };
  }, [supabase, user?.id]);

  if (!mustChange || !user) {
    return <>{children}</>;
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (newPassword.length < 8) {
      setError('Your new password must be at least 8 characters long.');
      return;
    }
    if (!/[A-Za-z]/.test(newPassword) || !/\d/.test(newPassword)) {
      setError('Your new password must contain at least one letter and one number.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match. Please re-enter both fields.');
      return;
    }

    setIsSaving(true);
    try {
      const response = await fetch('/api/auth/setup-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newPassword }),
      });
      const result = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };

      if (!response.ok || !result.ok) {
        setError(result.error || 'Could not update your password. Please try again.');
        return;
      }

      await supabase.auth.refreshSession().catch(() => {});
      setMustChange(false);
      setNewPassword('');
      setConfirmPassword('');
    } catch {
      setError('Network error while saving your password. Please try again.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-surface flex flex-col">
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-white p-8 rounded-3xl border border-surface-border shadow-xl space-y-5">
          <div className="flex items-center space-x-3">
            <div className="w-12 h-12 rounded-2xl bg-navy/10 text-navy flex items-center justify-center border border-navy/20">
              <KeyRound className="w-6 h-6" />
            </div>
            <div>
              <div className="text-[11px] font-bold uppercase tracking-wider text-ink-secondary">
                First Sign-In Security Step
              </div>
              <h2 className="text-xl font-extrabold text-navy">Set Your Personal Password</h2>
            </div>
          </div>

          <p className="text-xs text-ink-secondary leading-relaxed">
            Welcome, <strong className="text-navy">{user.name}</strong> ({user.email}). Your
            account was provisioned with a temporary password. Please choose a new personal
            password before opening your BALE workspace.
          </p>

          <form onSubmit={handleSubmit} className="space-y-4 text-xs">
            <Input
              label="New Personal Password"
              type="password"
              placeholder="At least 8 characters (letters & numbers)"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoComplete="new-password"
              required
            />

            <Input
              label="Confirm New Password"
              type="password"
              placeholder="Re-enter your new password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              autoComplete="new-password"
              required
            />

            {error && (
              <div
                role="alert"
                className="p-3 rounded-xl bg-status-danger-bg border border-status-danger/20 text-status-danger text-xs font-medium"
              >
                {error}
              </div>
            )}

            <div className="pt-2 flex items-center justify-between gap-3">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => logout()}
                leftIcon={<LogOut className="w-3.5 h-3.5" />}
              >
                Sign Out
              </Button>

              <Button
                type="submit"
                variant="primary"
                size="md"
                isLoading={isSaving}
                leftIcon={<CheckCircle2 className="w-4 h-4" />}
              >
                Save Password &amp; Continue
              </Button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};
