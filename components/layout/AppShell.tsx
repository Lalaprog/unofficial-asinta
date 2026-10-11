'use client';

import React, { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Navbar } from './Navbar';
import { Sidebar } from './Sidebar';
import { MobileNav } from './MobileNav';
import { useAuth } from '@/lib/auth/authContext';
import { useDataStore } from '@/lib/data/store';
import { isSupabaseConfigured } from '@/lib/supabase/client';
import { SkeletonShell } from '@/components/ui/Skeleton';
import { PasswordSetupGate } from '@/components/auth/PasswordSetupGate';
import { ShieldAlert, Loader2, AlertTriangle, RefreshCw, Settings2 } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/Button';

interface AppShellProps {
  children: React.ReactNode;
  requireFounder?: boolean;
}

/** Full-screen state shown while the auth session / ledger is synchronizing. */
const SyncState: React.FC<{ title: string; subtitle: string }> = ({ title, subtitle }) => (
  <div className="min-h-screen bg-surface flex flex-col">
    <div className="flex-1 flex flex-col items-center justify-center p-6 space-y-4">
      <div className="w-14 h-14 rounded-2xl bg-white border border-surface-border shadow-sm flex items-center justify-center">
        <Loader2 className="w-7 h-7 text-navy animate-spin" />
      </div>
      <div className="text-center space-y-1">
        <div className="text-base font-bold text-navy">{title}</div>
        <div className="text-xs text-ink-secondary max-w-xs">{subtitle}</div>
      </div>
    </div>
  </div>
);

export const AppShell: React.FC<AppShellProps> = ({ children, requireFounder = false }) => {
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const { user, isFounder, isLoading: authLoading } = useAuth();
  const { isLoaded, loadError, refresh } = useDataStore();
  const router = useRouter();
  const pathname = usePathname();

  // Connected workflow stepper groups so related modules are 1 click apart
  const workflowGroup = React.useMemo(() => {
    if (!isFounder || !pathname) return null;
    const groups = [
      {
        label: 'Workforce & Payroll Flow',
        steps: [
          { label: '1. Site Attendance', href: '/attendance' },
          { label: '2. Bale Advances', href: '/advances' },
          { label: '3. Payroll Engine', href: '/payroll' },
        ],
      },
      {
        label: 'Client Receivables Flow',
        steps: [
          { label: '1. Clients', href: '/clients' },
          { label: '2. Invoices & Billing', href: '/invoices' },
          { label: '3. Reminder Queue', href: '/reminders' },
          { label: '4. SMS Dispatch', href: '/sms' },
        ],
      },
      {
        label: 'Site Operations Flow',
        steps: [
          { label: '1. Projects & Sites', href: '/projects' },
          { label: '2. Expenses & AI', href: '/expenses' },
          { label: '3. Tools & Inventory', href: '/tools' },
        ],
      },
      {
        label: 'Administration',
        steps: [
          { label: '1. Team Accounts', href: '/users' },
          { label: '2. Firm Settings', href: '/settings' },
        ],
      },
    ];
    return (
      groups.find((g) =>
        g.steps.some((s) => pathname === s.href || pathname.startsWith(`${s.href}/`))
      ) || null
    );
  }, [isFounder, pathname]);

  // A session can end while a protected page is open (idle timeout, revoked
  // session, expiry). Showing the Founder "Restricted Business Portal" in that
  // case blames the wrong person, so send them to sign-in instead — the login
  // page explains what happened.
  const sessionGone = !authLoading && !user;
  useEffect(() => {
    if (!sessionGone) return;
    const timer = window.setTimeout(() => router.replace('/'), 600);
    return () => window.clearTimeout(timer);
  }, [router, sessionGone]);

  // 0. Fail fast and say exactly what is wrong when the environment is not
  //    configured, instead of surfacing a vague network error later.
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

  // 1a. The session ended while this page was open.
  if (sessionGone) {
    return (
      <SyncState
        title="Your session ended"
        subtitle="Returning to the sign-in page. Nothing already saved to the ledger is affected."
      />
    );
  }

  // 1b. Wait until the Supabase session has been resolved.
  if (authLoading) {
    return (
      <SyncState
        title="Verifying your session…"
        subtitle="Validating your Supabase authentication credentials and BALE role."
      />
    );
  }

  // 2. Signed-in user: wait for the ledger to synchronize with Supabase.
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

    // A skeleton keeps the page's shape while the ledger loads, instead of a
    // spinner that collapses into content and shifts everything on arrival.
    return <SkeletonShell />;
  }

  // 3. If page strictly requires Founder role and user is Supervisor, show
  //    security access denied screen.
  if (requireFounder && !isFounder) {
    return (
      <div className="min-h-screen bg-surface flex flex-col">
        <Navbar onToggleMobileMenu={() => setIsMobileMenuOpen(true)} />
        <div className="flex-1 flex items-center justify-center p-6">
          <div className="max-w-md w-full bg-white p-8 rounded-3xl border border-surface-border shadow-xl text-center space-y-4">
            <div className="w-14 h-14 bg-status-danger-bg text-status-danger rounded-2xl flex items-center justify-center mx-auto border border-status-danger/20">
              <ShieldAlert className="w-7 h-7" />
            </div>
            <h2 className="text-xl font-bold text-navy">Restricted Business Portal</h2>
            <p className="text-xs text-ink-secondary leading-relaxed">
              Access is restricted to Asinta Architects Founders (Ar. Junel & Ar. Rei Buyagon).
              Your current account is logged in with <strong>Supervisor</strong> permissions.
            </p>
            <div className="pt-2">
              <Link href="/attendance">
                <Button variant="primary" className="w-full">
                  Return to Attendance Terminal
                </Button>
              </Link>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-surface flex flex-col antialiased">
      <Navbar onToggleMobileMenu={() => setIsMobileMenuOpen(true)} />
      <MobileNav
        isOpen={isMobileMenuOpen}
        onClose={() => setIsMobileMenuOpen(false)}
        onOpen={() => setIsMobileMenuOpen(true)}
      />

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

      <div className="flex-1 flex max-w-7xl w-full mx-auto">
        <Sidebar />
        <main className="flex-1 p-4 sm:p-6 lg:p-8 pb-24 lg:pb-8 min-w-0 overflow-x-hidden">
          {workflowGroup && (
            <div className="mb-4 flex items-center justify-between gap-2 overflow-x-auto pb-1 no-scrollbar">
              <div className="inline-flex items-center gap-1 p-1 rounded-xl bg-white border border-surface-border shadow-sm">
                <span className="hidden sm:inline-block px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-wider text-ink-muted">
                  {workflowGroup.label}
                </span>
                {workflowGroup.steps.map((step) => {
                  const active =
                    pathname === step.href || pathname.startsWith(`${step.href}/`);
                  return (
                    <Link
                      key={step.href}
                      href={step.href}
                      className={`px-3 py-1 rounded-lg text-[11px] font-bold whitespace-nowrap transition-all ${
                        active
                          ? 'bg-navy text-white shadow-sm'
                          : 'text-ink-secondary hover:text-navy hover:bg-surface-inset'
                      }`}
                    >
                      {step.label}
                    </Link>
                  );
                })}
              </div>
            </div>
          )}

          <div className="animate-in fade-in duration-150">
            <PasswordSetupGate>{children}</PasswordSetupGate>
          </div>
        </main>
      </div>
    </div>
  );
};
