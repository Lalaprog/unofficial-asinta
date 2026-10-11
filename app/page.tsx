'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, Clock, Eye, EyeOff, KeyRound, Loader2, Lock, Mail, ShieldCheck } from 'lucide-react';
import { useAuth } from '@/lib/auth/authContext';
import { createClient } from '@/lib/supabase/client';
import { friendlyMfaError, normalizeTotpCode } from '@/lib/auth/mfa';
import { canRoleAccessPath, getSafeRedirectPath, type AppRole } from '@/lib/auth/routes';
import {
  AUTH_NOTICE_STORAGE_KEY,
  authNoticeMessage,
  parseAuthNotice,
} from '@/lib/auth/session';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { AsintaEmblem, AsintaWordmark } from '@/components/ui/AsintaLogo';

const MIDDLEWARE_ERRORS: Record<string, string> = {
  no_profile:
    'Your account is authenticated but has no BALE role assigned. Please contact the firm administrator.',
  invalid_role:
    'Your account has an unrecognized role in the database. Please contact the firm administrator.',
};

/**
 * Canonical authentication URL for BALE. The unified role-aware login lives
 * at "/" — the account's database role decides which workspace opens next.
 */
export default function LoginPage() {
  const router = useRouter();
  const { login } = useAuth();
  const supabase = useMemo(() => createClient(), []);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [redirectNotice, setRedirectNotice] = useState<string | null>(null);
  /**
   * Set by the session watcher when a session ends. Without it a Founder whose
   * session timed out mid-task just lands back here with no explanation.
   */
  const [sessionNotice, setSessionNotice] = useState<string | null>(null);

  /**
   * Second factor. Password sign-in yields a session at aal1; when the account
   * has a verified TOTP factor, Supabase reports nextLevel 'aal2' and this step
   * runs BEFORE any workspace is opened. The code is verified by Supabase Auth,
   * never by us.
   */
  const [mfaChallenge, setMfaChallenge] = useState<{ factorId: string; role: AppRole } | null>(null);
  const [mfaCode, setMfaCode] = useState('');
  const [mfaError, setMfaError] = useState<string | null>(null);
  const [isVerifyingMfa, setIsVerifyingMfa] = useState(false);

  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get('error');
    if (code && MIDDLEWARE_ERRORS[code]) setError(MIDDLEWARE_ERRORS[code]);

    try {
      const notice = parseAuthNotice(window.sessionStorage.getItem(AUTH_NOTICE_STORAGE_KEY));
      if (notice) {
        // Read once: a refresh should not replay a message about an old session.
        window.sessionStorage.removeItem(AUTH_NOTICE_STORAGE_KEY);
        setSessionNotice(authNoticeMessage(notice.code));
      }
    } catch {
      // Storage unavailable — no notice, no false claim.
    }
  }, []);

  /** Sends the user to their role's workspace (or the requested path). */
  const proceedToWorkspace = (role: AppRole) => {
    const requestedPath = getSafeRedirectPath(
      new URLSearchParams(window.location.search).get('redirect_to')
    );
    const fallback = role === 'founder' ? '/dashboard' : '/attendance';
    const destination =
      requestedPath && canRoleAccessPath(role, requestedPath) ? requestedPath : fallback;
    const roleLabel = role === 'founder' ? 'Founder' : 'Supervisor';

    setRedirectNotice(`${roleLabel} role detected. Redirecting…`);
    window.setTimeout(() => router.replace(destination), 900);
  };

  const handleVerifyMfa = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!mfaChallenge) return;

    const normalized = normalizeTotpCode(mfaCode);
    if (!normalized) {
      setMfaError('Enter the 6-digit code from your authenticator app.');
      return;
    }

    setIsVerifyingMfa(true);
    setMfaError(null);
    try {
      const { error: verifyError } = await supabase.auth.mfa.challengeAndVerify({
        factorId: mfaChallenge.factorId,
        code: normalized,
      });

      if (verifyError) {
        setMfaError(friendlyMfaError(verifyError.message));
        return;
      }

      const role = mfaChallenge.role;
      setMfaChallenge(null);
      setMfaCode('');
      proceedToWorkspace(role);
    } catch (caught) {
      setMfaError(caught instanceof Error ? friendlyMfaError(caught.message) : 'Verification failed.');
    } finally {
      setIsVerifyingMfa(false);
    }
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setRedirectNotice(null);
    setIsLoading(true);

    try {
      const result = await login(email, password);
      if (!result.success) {
        setError(result.error || 'Invalid credentials');
        setIsLoading(false);
        return;
      }

      if (result.role !== 'founder' && result.role !== 'supervisor') {
        setError(MIDDLEWARE_ERRORS.invalid_role);
        setIsLoading(false);
        return;
      }

      const role = result.role as AppRole;

      // Ask Supabase whether this session needs a second factor. `nextLevel`
      // is 'aal2' only when a VERIFIED factor exists for this account.
      const { data: assurance } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      if (assurance?.nextLevel === 'aal2' && assurance.currentLevel !== 'aal2') {
        const { data: factorData } = await supabase.auth.mfa.listFactors();
        const verified = (factorData?.totp ?? []).find((factor: any) => factor.status === 'verified');
        if (verified) {
          setMfaChallenge({ factorId: verified.id, role });
          setIsLoading(false);
          return;
        }
      }

      proceedToWorkspace(role);
    } catch (caughtError: unknown) {
      setError(caughtError instanceof Error ? caughtError.message : 'Authentication error');
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-surface flex flex-col justify-between p-4 sm:p-6 relative overflow-hidden">
      {/* Subtle architectural CHB watermark */}
      <div className="pointer-events-none select-none fixed -right-12 -bottom-16 opacity-[0.035] text-navy">
        <AsintaEmblem size={420} monochrome />
      </div>

      <div className="max-w-md w-full mx-auto pt-10 sm:pt-16 relative z-10">
        <div className="bg-white rounded-3xl p-6 sm:p-8 border border-surface-border shadow-[8px_8px_24px_rgba(11,31,58,0.08),-8px_-8px_24px_rgba(255,255,255,0.95)]">
          <div className="flex items-center justify-between pb-5 border-b border-surface-border/60">
            <div className="flex items-center space-x-3">
              <div className="w-11 h-11 rounded-2xl bg-surface-inset/60 border border-surface-border flex items-center justify-center shadow-neu-raised-sm">
                <AsintaEmblem size={28} />
              </div>
              <div className="flex flex-col">
                <AsintaWordmark height={20} />
                <span className="text-[10px] font-bold text-ink-secondary uppercase tracking-widest mt-1">
                  BALE · Design &amp; Build Ledger
                </span>
              </div>
            </div>
            <Badge variant="navy" size="sm">BALE</Badge>
          </div>

          <div className="mt-5">
            <h1 className="text-xl font-extrabold text-navy tracking-tight">Sign In</h1>
            <p className="text-xs text-ink-secondary mt-0.5">
              Architecture curated to your style — built with quality and precision.
            </p>
          </div>

          {error && (
            <div className="mt-4 p-3 rounded-xl bg-status-danger-bg border border-status-danger/20 text-status-danger text-xs flex items-center space-x-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {sessionNotice && (
            <div
              role="status"
              className="mt-4 p-3 rounded-xl bg-status-warning-bg border border-status-warning/20 text-status-warning text-xs flex items-center space-x-2"
            >
              <Clock className="w-4 h-4 shrink-0" />
              <span>{sessionNotice}</span>
            </div>
          )}

          {redirectNotice && (
            <div className="mt-4 p-3 rounded-xl bg-status-info-bg border border-status-info/20 text-status-info text-xs flex items-center space-x-2">
              <ShieldCheck className="w-4 h-4 shrink-0" />
              <span>{redirectNotice}</span>
            </div>
          )}

          {mfaChallenge && (
            <form onSubmit={handleVerifyMfa} className="mt-6 space-y-4">
              <div className="p-3 rounded-xl bg-status-info-bg border border-status-info/20 text-status-info flex items-start gap-2 text-xs">
                <KeyRound className="w-4 h-4 shrink-0 mt-0.5" />
                <span>
                  Password accepted. Enter the current 6-digit code from your authenticator app to
                  finish signing in.
                </span>
              </div>

              {mfaError && (
                <div className="p-3 rounded-xl bg-status-danger-bg border border-status-danger/20 text-status-danger text-xs flex items-center space-x-2">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>{mfaError}</span>
                </div>
              )}

              <Input
                label="Authenticator code"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="123456"
                value={mfaCode}
                onChange={(event) => setMfaCode(event.target.value)}
                required
                leftIcon={<Loader2 className="w-4 h-4 opacity-0" />}
              />

              <Button type="submit" variant="primary" size="lg" className="w-full" isLoading={isVerifyingMfa}>
                Verify &amp; continue
              </Button>

              <button
                type="button"
                onClick={() => {
                  setMfaChallenge(null);
                  setMfaCode('');
                  setMfaError(null);
                }}
                className="w-full text-center text-[11px] font-semibold text-ink-secondary hover:text-navy hover:underline"
              >
                Use a different account
              </button>
            </form>
          )}

          <form
            onSubmit={handleSubmit}
            className={mfaChallenge ? 'hidden' : 'mt-6 space-y-4'}
            aria-hidden={mfaChallenge ? 'true' : undefined}
          >
            <Input
              label="Email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="name@asinta.ph"
              autoComplete="email"
              required
              leftIcon={<Mail className="w-4 h-4" />}
            />
            <Input
              label="Password"
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Enter your account password"
              autoComplete="current-password"
              required
              leftIcon={<Lock className="w-4 h-4" />}
              rightIcon={
                <button
                  type="button"
                  onClick={() => setShowPassword((previous) => !previous)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  aria-pressed={showPassword}
                  className="text-ink-muted hover:text-navy focus:outline-none focus:ring-2 focus:ring-navy/30 rounded-md p-0.5 transition-colors"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              }
            />
            <Button
              type="submit"
              variant="primary"
              size="lg"
              className="w-full mt-2"
              isLoading={isLoading}
            >
              Sign In
            </Button>
          </form>
        </div>
      </div>

      <div className="text-center text-xs text-ink-muted py-6 relative z-10">
        © 2026 Asinta Corp. · Design &amp; Build
      </div>
    </div>
  );
}
