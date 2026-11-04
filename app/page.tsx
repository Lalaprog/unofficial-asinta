'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, Clock, Eye, EyeOff, KeyRound, Loader2, Lock, Mail } from 'lucide-react';
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
import { AsintaEmblem, AsintaWordmark, BaleLogo } from '@/components/ui/AsintaLogo';
import { AsintaLoader } from '@/components/ui/AsintaLoader';

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
  const [isEnteringWorkspace, setIsEnteringWorkspace] = useState(false);
  const [sessionNotice, setSessionNotice] = useState<string | null>(null);

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
        window.sessionStorage.removeItem(AUTH_NOTICE_STORAGE_KEY);
        setSessionNotice(authNoticeMessage(notice.code));
      }
    } catch {
      // Storage unavailable — no notice, no false claim.
    }
  }, []);

  const proceedToWorkspace = (role: AppRole) => {
    const requestedPath = getSafeRedirectPath(
      new URLSearchParams(window.location.search).get('redirect_to')
    );
    const fallback = role === 'founder' ? '/dashboard' : '/attendance';
    const destination =
      requestedPath && canRoleAccessPath(role, requestedPath) ? requestedPath : fallback;

    setIsEnteringWorkspace(true);
    router.refresh();
    router.replace(destination);
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
        setIsVerifyingMfa(false);
        return;
      }

      const role = mfaChallenge.role;
      setMfaChallenge(null);
      setMfaCode('');
      proceedToWorkspace(role);
    } catch (caught) {
      setMfaError(caught instanceof Error ? friendlyMfaError(caught.message) : 'Verification failed.');
      setIsVerifyingMfa(false);
    }
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
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

  if (isLoading || isVerifyingMfa || isEnteringWorkspace) {
    return (
      <AsintaLoader
        variant="fullscreen"
        title="Verifying credentials & preparing your workspace…"
        subtitle="Synchronizing studio ledger & site records"
      />
    );
  }

  return (
    <div className="min-h-[100lvh] bg-surface flex flex-col justify-between p-4 sm:p-6 lg:p-10 relative overflow-hidden">
      {/* Ambient Architectural Blueprint Grid & Visible CHB Watermark */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 overflow-hidden select-none"
      >
        <div
          className="absolute inset-0 opacity-[0.035]"
          style={{
            backgroundImage:
              'linear-gradient(to right, #1B4978 1px, transparent 1px), linear-gradient(to bottom, #1B4978 1px, transparent 1px)',
            backgroundSize: '36px 36px',
          }}
        />
        <div className="absolute -right-12 -bottom-12 opacity-[0.11] hidden lg:block">
          <AsintaEmblem size={440} />
        </div>
        <div className="absolute -left-16 -top-16 opacity-[0.07] hidden lg:block">
          <AsintaEmblem size={300} />
        </div>
      </div>

      <main className="flex-1 flex items-center justify-center relative z-10 my-auto">
        <div className="w-full max-w-4xl grid grid-cols-1 lg:grid-cols-12 rounded-2xl sm:rounded-3xl bg-white border border-surface-border shadow-[0_20px_50px_rgba(11,31,58,0.10)] overflow-hidden animate-page-enter">
          {/* Mobile Architectural Showcase Header (Visible on phones & tablets) */}
          <div className="lg:hidden bg-gradient-to-br from-[#0B1F3A] via-[#132C4E] to-[#1B4978] text-white p-5 relative overflow-hidden">
            <div
              aria-hidden="true"
              className="pointer-events-none absolute -right-6 -bottom-6 opacity-15"
            >
              <AsintaEmblem size={120} />
            </div>
            <div className="relative z-10 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div className="inline-flex items-center gap-3 rounded-xl bg-white px-3.5 py-2 shadow-md">
                  <AsintaEmblem size={28} />
                  <div className="h-5 w-px bg-surface-border" />
                  <AsintaWordmark height={18} />
                </div>
                <div className="inline-flex items-center rounded-lg bg-white/95 px-2.5 py-1 shadow-sm">
                  <BaleLogo height={16} />
                </div>
              </div>
              <p className="text-xs text-white/85 font-medium leading-snug">
                Architecture curated to your style — built with quality and precision.
              </p>
            </div>
          </div>

          {/* Left Panel: Desktop Architectural Brand Showcase */}
          <div className="hidden lg:flex lg:col-span-5 bg-gradient-to-br from-[#0B1F3A] via-[#132C4E] to-[#1B4978] text-white p-9 flex-col justify-between relative overflow-hidden">
            {/* Blueprint grid overlay */}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 opacity-[0.07]"
              style={{
                backgroundImage:
                  'linear-gradient(to right, #FFFFFF 1px, transparent 1px), linear-gradient(to bottom, #FFFFFF 1px, transparent 1px)',
                backgroundSize: '24px 24px',
              }}
            />

            {/* Prominent watermark emblem inside the dark showcase panel */}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute -right-10 -bottom-10 opacity-20"
            >
              <AsintaEmblem size={250} />
            </div>

            {/* Top Brand Badge */}
            <div className="relative z-10 flex items-center justify-between">
              <div className="inline-flex items-center space-x-2 px-3 py-1.5 rounded-xl bg-white/95 shadow-sm">
                <span className="w-2 h-2 rounded-full bg-emerald-500" />
                <BaleLogo height={16} />
              </div>
              <span className="text-[10px] font-mono text-white/50">EST. 2023</span>
            </div>

            {/* Center Emblem, Wordmark & Brand Story */}
            <div className="relative z-10 space-y-5 my-8">
              <div className="inline-flex items-center gap-3.5 rounded-2xl bg-white px-4 py-3 shadow-xl">
                <AsintaEmblem size={38} />
                <div className="h-7 w-px bg-surface-border" />
                <AsintaWordmark height={22} />
              </div>

              {/* Clean architectural accent rule + discipline pills (replaces ASCII ticks) */}
              <div className="space-y-2.5">
                <div className="w-10 h-0.5 bg-sky-400 rounded-full" />
                <div className="flex items-center gap-1.5 flex-wrap">
                  {['Design', 'Build', 'Management'].map((tag) => (
                    <span
                      key={tag}
                      className="px-2 py-0.5 rounded-md bg-white/10 border border-white/10 text-[10px] font-semibold uppercase tracking-wider text-sky-200"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <p className="text-2xl font-extrabold tracking-tight text-white leading-snug">
                  Architecture curated to your style — built with quality and precision.
                </p>
                <p className="text-xs text-white/75 leading-relaxed pt-1">
                  Unified project billing, site expense ledger, daily workforce attendance, and automated payroll.
                </p>
              </div>
            </div>

            {/* Bottom Studio Metadata */}
            <div className="relative z-10 pt-4 border-t border-white/15 flex items-center justify-between text-[11px] text-white/70">
              <span>Asinta Corp. Studio</span>
              <span className="font-mono text-[10px] text-white/60">PH · PHP ₱</span>
            </div>
          </div>

          {/* Right Panel: Sign-In / 2FA Form */}
          <div className="lg:col-span-7 p-6 sm:p-10 flex flex-col justify-center bg-white">
            <div className="mb-6">
              <div className="hidden lg:block mb-2">
                <AsintaWordmark height={20} />
              </div>
              <h1 className="text-lg font-extrabold text-navy tracking-tight">
                Sign in to your account
              </h1>
              <p className="text-xs text-ink-secondary mt-0.5">
                Enter your studio or field supervisor credentials below
              </p>
            </div>

            {/* Session-ended notice */}
            {sessionNotice && (
              <div
                role="status"
                className="mb-5 p-3.5 rounded-xl bg-status-warning-bg border border-status-warning/25 text-status-warning text-xs flex items-start space-x-2.5"
              >
                <Clock className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{sessionNotice}</span>
              </div>
            )}

            {mfaChallenge ? (
              <form
                onSubmit={handleVerifyMfa}
                className="space-y-5 animate-page-enter"
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-navy uppercase tracking-wider">
                    Two-Factor Verification
                  </span>
                  <Badge variant="navy" size="sm">
                    Step 2 of 2
                  </Badge>
                </div>

                <p className="text-xs text-ink-secondary leading-relaxed">
                  Enter the 6-digit code from your authenticator app for{' '}
                  <span className="font-semibold text-navy">{email}</span>.
                </p>

                {mfaError && (
                  <div role="alert" className="p-3.5 rounded-xl bg-status-danger-bg border border-status-danger/20 text-status-danger text-xs flex items-start space-x-2.5">
                    <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                    <span>{mfaError}</span>
                  </div>
                )}

                <Input
                  label="6-Digit Authenticator Code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder="123 456"
                  maxLength={7}
                  value={mfaCode}
                  onChange={(e) => setMfaCode(e.target.value)}
                  leftIcon={<KeyRound className="w-4 h-4" />}
                  autoFocus
                  required
                />

                <div className="flex items-center gap-2 pt-1">
                  <Button
                    type="button"
                    variant="secondary"
                    size="md"
                    className="flex-1"
                    disabled={isVerifyingMfa}
                    onClick={() => {
                      supabase.auth.signOut();
                      setMfaChallenge(null);
                      setMfaCode('');
                      setMfaError(null);
                    }}
                  >
                    Back
                  </Button>
                  <Button
                    type="submit"
                    variant="primary"
                    size="md"
                    className="flex-1"
                    disabled={isVerifyingMfa}
                  >
                    {isVerifyingMfa ? (
                      <span className="inline-flex items-center gap-2">
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Verifying…
                      </span>
                    ) : (
                      'Verify & Open'
                    )}
                  </Button>
                </div>
              </form>
            ) : (
              <form
                onSubmit={handleSubmit}
                autoComplete="off"
                className="space-y-4"
              >
                {error && (
                  <div role="alert" className="p-3.5 rounded-xl bg-status-danger-bg border border-status-danger/20 text-status-danger text-xs flex items-start space-x-2.5">
                    <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                    <span>{error}</span>
                  </div>
                )}

                <Input
                  label="Work Email"
                  type="email"
                  name="bale_work_email"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder="name@asinta.ph"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  leftIcon={<Mail className="w-4 h-4" />}
                  required
                />

                <div className="relative">
                  <Input
                    label="Password"
                    type={showPassword ? 'text' : 'password'}
                    name="bale_work_password"
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    placeholder="Enter your password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    leftIcon={<Lock className="w-4 h-4" />}
                    className="pr-14"
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-0 top-[23px] inline-flex h-11 w-11 items-center justify-center rounded-lg text-ink-muted hover:text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-inset"
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>

                <div className="pt-2">
                  <Button
                    type="submit"
                    variant="primary"
                    size="lg"
                    className="w-full"
                    disabled={isLoading}
                  >
                    Sign In
                  </Button>
                </div>
              </form>
            )}
          </div>
        </div>
      </main>

      {/* Bottom Trademark Footer */}
      <div className="relative z-10 pt-5 flex items-center justify-center gap-2 text-xs text-ink-secondary">
        <AsintaEmblem size={15} />
        <AsintaWordmark height={12} />
        <span className="text-[9px] font-bold text-ink-muted">TM</span>
        <span className="text-surface-border">·</span>
        <span className="text-[11px] text-ink-muted">&copy; {new Date().getFullYear()} All Rights Reserved</span>
      </div>
    </div>
  );
}
