'use client';

import React, { Suspense, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Navbar } from './Navbar';
import { MobileNav } from './MobileNav';
import { Footer } from './Footer';
import { useAuth } from '@/lib/auth/authContext';
import { useDataStore } from '@/lib/data/store';
import { createClient, isSupabaseConfigured } from '@/lib/supabase/client';
import { PasswordSetupGate } from '@/components/auth/PasswordSetupGate';
import { AsintaLoader } from '@/components/ui/AsintaLoader';
import { SkeletonShell } from '@/components/ui/Skeleton';
import { ShieldAlert, AlertTriangle, RefreshCw, Settings2 } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/Button';

interface AppShellProps {
  children: React.ReactNode;
  requireFounder?: boolean;
}

export const AppShell: React.FC<AppShellProps> = ({ children, requireFounder = false }) => {
  const { user, isFounder, isLoading: authLoading } = useAuth();
  const { isLoaded, loadError, refresh } = useDataStore();
  const router = useRouter();

  // Once the session and ledger are loaded, silently pre-warm the role's routes
  // so subsequent page navigation is instantaneous.
  useEffect(() => {
    if (!user || !isLoaded) return;
    const routes = isFounder
      ? [
          '/dashboard',
          '/projects',
          '/attendance',
          '/payroll',
          '/advances',
          '/invoices',
          '/expenses',
          '/clients',
          '/tools',
          '/users',
          '/reminders',
          '/sms',
          '/settings',
        ]
      : ['/attendance', '/projects', '/settings'];

    const timer = window.setTimeout(() => {
      routes.forEach((route) => {
        try {
          router.prefetch(route);
        } catch {
          // Ignore prefetch errors
        }
      });
    }, 300);

    return () => window.clearTimeout(timer);
  }, [user, isLoaded, isFounder, router]);

  // Guard against transient network/hydration blips before redirecting to `/`
  const sessionGone = !authLoading && !user;
  useEffect(() => {
    if (!sessionGone) return;
    let cancelled = false;

    const timer = window.setTimeout(async () => {
      try {
        const supabase = createClient();
        const {
          data: { session },
        } = await supabase.auth.getSession();
        if (!cancelled && !session?.user) {
          router.replace('/');
        }
      } catch {
        if (!cancelled) {
          router.replace('/');
        }
      }
    }, 1500);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [router, sessionGone]);

  // 0. Missing Supabase env vars
  if (!isSupabaseConfigured()) {
    return (
      <div className="min-h-screen bg-surface flex flex-col">
        <div className="flex-1 flex items-center justify-center p-6">
          <div className="max-w-md w-full bg-white p-8 rounded-3xl border border-surface-border shadow-xl text-center space-y-4">
            <div className="w-14 h-14 bg-status-warning-bg text-status-warning rounded-2xl flex items-center justify-center mx-auto border border-status-warning/20">
              <Settings2 className="w-7 h-7" />
            </div>
            <h2 className="text-xl font-bold text-navy">Supabase environment variables are missing</h2>
            <p className="text-xs text-ink-secondary leading-relaxed text-left">
              BALE connects directly to Supabase and has no offline mode. Set
              <span className="font-mono text-navy"> NEXT_PUBLIC_SUPABASE_URL </span>
              and
              <span className="font-mono text-navy"> NEXT_PUBLIC_SUPABASE_ANON_KEY </span>
              in your environment (see <span className="font-mono text-navy">.env.example</span>),
              then rebuild or redeploy.
            </p>
          </div>
        </div>
      </div>
    );
  }

  // 1a. Session ended or signing out
  if (sessionGone) {
    return (
      <AsintaLoader
        variant="fullscreen"
        title="Returning to sign-in…"
        subtitle="Your BALE ledger records remain safely saved"
      />
    );
  }

  // 1b. Resolving authentication session
  if (authLoading) {
    return (
      <div className="relative">
        <SkeletonShell />
        <AsintaLoader
          variant="fullscreen"
          title="Verifying credentials & preparing your workspace…"
          subtitle="Authenticating your Asinta workspace access"
        />
      </div>
    );
  }

  // 2. Pre-fetching all studio & site data into cache before opening workspace
  if (user && !isLoaded) {
    if (loadError) {
      return (
        <div className="min-h-screen bg-surface flex flex-col">
          <div className="flex-1 flex items-center justify-center p-6">
            <div className="max-w-md w-full bg-white p-8 rounded-3xl border border-surface-border shadow-xl text-center space-y-4">
              <div className="w-14 h-14 bg-status-warning-bg text-status-warning rounded-2xl flex items-center justify-center mx-auto border border-status-warning/20">
                <AlertTriangle className="w-7 h-7" />
              </div>
              <h2 className="text-xl font-bold text-navy">Supabase Connection Problem</h2>
              <p className="text-xs text-ink-secondary leading-relaxed text-left">{loadError}</p>
              <Button
                variant="primary"
                className="w-full"
                onClick={() => refresh()}
                leftIcon={<RefreshCw className="w-4 h-4" />}
              >
                Retry Connection
              </Button>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="relative">
        <SkeletonShell />
        <AsintaLoader
          variant="fullscreen"
          title="Synchronizing Asinta studio ledger…"
          subtitle="Fetching projects, workforce, and financial records"
        />
      </div>
    );
  }

  // 3. Founder-only route protection fallback
  if (requireFounder && !isFounder) {
    return (
      <div className="min-h-screen bg-surface flex flex-col">
        <Suspense fallback={null}>
          <Navbar />
        </Suspense>
        <div className="flex-1 flex items-center justify-center p-6">
          <div className="max-w-md w-full bg-white p-8 rounded-3xl border border-surface-border shadow-xl text-center space-y-4">
            <div className="w-14 h-14 bg-status-danger-bg text-status-danger rounded-2xl flex items-center justify-center mx-auto border border-status-danger/20">
              <ShieldAlert className="w-7 h-7" />
            </div>
            <h2 className="text-xl font-bold text-navy">Restricted Business Portal</h2>
            <p className="text-xs text-ink-secondary leading-relaxed">
              This module is reserved for Asinta Corp. Founders.
            </p>
            <div className="pt-2">
              <Link href="/attendance" prefetch={false}>
                <Button variant="primary" className="w-full">
                  Return to Field Roll Call
                </Button>
              </Link>
            </div>
          </div>
        </div>
        <Footer />
      </div>
    );
  }

  return (
    <div className="min-h-[100lvh] bg-surface flex flex-col antialiased">
      <Suspense fallback={null}>
        <Navbar />
      </Suspense>
      <Suspense fallback={null}>
        <MobileNav />
      </Suspense>

      {loadError && (
        <div className="max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 pt-4">
          <div className="p-3 rounded-2xl bg-status-warning-bg border border-status-warning/20 text-status-warning text-xs flex items-center justify-between gap-3">
            <span className="flex items-center gap-2 font-semibold">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              Some Supabase queries failed: {loadError}
            </span>
            <Button variant="outline" size="sm" onClick={() => refresh()}>
              Retry
            </Button>
          </div>
        </div>
      )}

      <main className="flex-1 w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 lg:pb-14 min-w-0 overflow-x-hidden">
        <div className="animate-page-enter">
          <PasswordSetupGate>{children}</PasswordSetupGate>
        </div>
      </main>

      <Footer />
    </div>
  );
};
