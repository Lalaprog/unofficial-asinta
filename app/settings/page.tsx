'use client';

import React, { useEffect, useState } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { useDataStore } from '@/lib/data/store';
import { useAuth } from '@/lib/auth/authContext';
import { Building2, Bot, Database, RefreshCw, HardHat } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/Card';
import { TemplateEditorCard } from '@/components/email/TemplateEditorCard';
import { TestEmailCard } from '@/components/email/TestEmailCard';
import { MfaCard } from '@/components/auth/MfaCard';

interface IntegrationStatus {
  groqModel?: string;
  groqVisionModel?: string;
  groqTranscriptionModel?: string;
  mfaEnforcedForFounders?: boolean;
  sessionPolicy?: {
    idleMinutes: number;
    absoluteHours: number;
    warningSeconds: number;
    appliesToRoles: string[];
  };
  groqConfigured: boolean;
  philsmsConfigured: boolean;
  philsmsSenderId?: string;
  supabaseConfigured: boolean;
  smtpConfigured: boolean;
  automaticRemindersEnabled: boolean;
}

export default function SettingsPage() {
  const { user, isFounder, isSupervisor } = useAuth();
  const { refresh, isLoading, isLoaded, workers, getProjectsForSupervisor } = useDataStore();

  const assignedProjects = isSupervisor && user ? getProjectsForSupervisor(user.id) : [];
  const linkedWorker = user
    ? workers.find(
        (w) =>
          w.active &&
          (w.id === user.id || w.name.trim().toLowerCase() === user.name.trim().toLowerCase())
      )
    : undefined;

  const [isResyncing, setIsResyncing] = useState(false);
  const [integrationStatus, setIntegrationStatus] = useState<IntegrationStatus | null>(null);
  const [testPhone, setTestPhone] = useState('');
  const [isTestingSms, setIsTestingSms] = useState(false);
  const [smsTestResult, setSmsTestResult] = useState<{ accepted?: boolean; error?: string; note?: string; providerMessageId?: string | null } | null>(null);

  useEffect(() => {
    let active = true;

    fetch('/api/integrations/status', { cache: 'no-store' })
      .then((response) => {
        if (!response.ok) throw new Error('Unable to load integration status');
        return response.json() as Promise<IntegrationStatus>;
      })
      .then((status) => {
        if (active) setIntegrationStatus(status);
      })
      .catch(() => {
        if (active) {
          setIntegrationStatus({
            groqConfigured: false,
            philsmsConfigured: false,
            supabaseConfigured: false,
            smtpConfigured: false,
            automaticRemindersEnabled: false,
          });
        }
      });

    return () => {
      active = false;
    };
  }, []);

  const handleSmsTest = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isTestingSms) return;
    setIsTestingSms(true);
    setSmsTestResult(null);
    try {
      const response = await fetch('/api/integrations/philsms-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: testPhone }),
      });
      const result = await response.json();
      setSmsTestResult(result);
    } catch {
      setSmsTestResult({ error: 'Could not contact the BALE server. No result was confirmed.' });
    } finally {
      setIsTestingSms(false);
    }
  };

  const handleResyncData = async () => {
    setIsResyncing(true);
    await refresh();
    setIsResyncing(false);
  };

  return (
    <AppShell>
      <div className="space-y-6 max-w-4xl">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2 border-b border-surface-border/60">
          <div>
            <div className="flex items-center space-x-2">
              <span className="text-xs font-bold text-navy uppercase tracking-widest">
                {isFounder ? 'System Configurations' : 'Field Terminal Account'}
              </span>
              <span className="text-xs text-ink-muted">·</span>
              <span className="text-xs text-ink-secondary">BALE v1.0 Engine</span>
            </div>
            <h1 className="text-2xl sm:text-3xl font-extrabold text-navy tracking-tight mt-1">
              {isFounder ? 'Firm Settings & Integrations' : 'Supervisor Profile & Settings'}
            </h1>
          </div>
        </div>

        {/* Supervisor Account Profile Card */}
        {isSupervisor && user && (
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center space-x-2.5">
                  <HardHat className="w-5 h-5 text-status-warning" />
                  <CardTitle>Supervisor Field Profile</CardTitle>
                </div>
                <Badge variant="warning" size="sm">
                  Site Supervisor
                </Badge>
              </div>
              <CardDescription>
                Your active BALE field terminal account, assigned project sites, and payroll roster link
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 text-xs">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="font-bold text-navy uppercase text-[11px] block mb-1">Full Name</label>
                  <div className="p-2.5 rounded-xl bg-surface-inset border border-surface-border font-semibold text-navy">
                    {user.name}
                  </div>
                </div>
                <div>
                  <label className="font-bold text-navy uppercase text-[11px] block mb-1">Account Email</label>
                  <div className="p-2.5 rounded-xl bg-surface-inset border border-surface-border font-semibold text-navy">
                    {user.email}
                  </div>
                </div>
              </div>

              <div>
                <label className="font-bold text-navy uppercase text-[11px] block mb-1.5">
                  Assigned Project Sites ({assignedProjects.length})
                </label>
                {assignedProjects.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {assignedProjects.map((p) => (
                      <div
                        key={p.id}
                        className="px-3 py-1.5 rounded-xl bg-surface-inset border border-surface-border font-semibold text-navy"
                      >
                        {p.name} <span className="text-ink-muted font-normal">({p.location.split(',')[0]})</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="p-3 rounded-xl bg-surface-inset border border-surface-border text-ink-secondary">
                    No specific project site assigned yet — ask a Founder to assign your site in Team &amp; Permissions.
                  </div>
                )}
              </div>

              <div className="p-3.5 rounded-2xl bg-surface-inset/60 border border-surface-border flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div>
                  <div className="font-bold text-navy">Daily Attendance &amp; Payroll Inclusion</div>
                  <div className="text-ink-secondary">
                    {linkedWorker
                      ? `Enrolled on the workforce roster as ${linkedWorker.position} (₱${linkedWorker.pay_rate}/${linkedWorker.pay_rate_type === 'hourly' ? 'hr' : 'day'}).`
                      : 'Not yet enrolled as a worker on the daily roster. You can include yourself directly from the Attendance Terminal.'}
                  </div>
                </div>
                <Badge variant={linkedWorker ? 'success' : 'neutral'} size="sm">
                  {linkedWorker ? 'Enrolled in Payroll' : 'Account Only'}
                </Badge>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Firm Profile */}
        <Card>
          <CardHeader>
            <div className="flex items-center space-x-2.5">
              <Building2 className="w-5 h-5 text-navy" />
              <CardTitle>Asinta Architects Studio Profile</CardTitle>
            </div>
            <CardDescription>Firm principals and official studio registration</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
              <div>
                <label className="font-bold text-navy uppercase text-[11px] block mb-1">Firm Name</label>
                <div className="p-2.5 rounded-xl bg-surface-inset border border-surface-border font-semibold text-navy">
                  Asinta Architects (Design & Build)
                </div>
              </div>

              <div>
                <label className="font-bold text-navy uppercase text-[11px] block mb-1">Studio Location</label>
                <div className="p-2.5 rounded-xl bg-surface-inset border border-surface-border font-semibold text-navy">
                  Ayala Greenfield / Sto. Tomas, Batangas, Philippines
                </div>
              </div>

              <div>
                <label className="font-bold text-navy uppercase text-[11px] block mb-1">Founders & Principals</label>
                <div className="p-2.5 rounded-xl bg-surface-inset border border-surface-border font-semibold text-navy">
                  Ar. Junel Buyagon & Ar. Rei Viviene Buyagon
                </div>
              </div>

              <div>
                <label className="font-bold text-navy uppercase text-[11px] block mb-1">Primary Currency</label>
                <div className="p-2.5 rounded-xl bg-surface-inset border border-surface-border font-semibold text-navy">
                  Philippine Peso (PHP ₱)
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Founder MFA — real Supabase TOTP enrolment. The previous control was a
            toggle that changed React state and nothing else, so the UI claimed a
            protection that did not exist. */}
        {isFounder && <MfaCard />}

        {/* AI & SMS Integrations */}
        {isFounder && (
          <Card>
            <CardHeader>
              <div className="flex items-center space-x-2.5">
                <Bot className="w-5 h-5 text-navy" />
                <CardTitle>External Service Integrations</CardTitle>
              </div>
              <CardDescription>Groq AI semantic ledger assistance and PhilSMS gateway</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 text-xs">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="p-4 rounded-2xl bg-surface-inset/50 border border-surface-border space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-navy">Groq AI Engine</span>
                    <Badge
                      variant={integrationStatus?.groqConfigured ? 'success' : 'warning'}
                      size="sm"
                    >
                      {!integrationStatus
                        ? 'Checking'
                        : integrationStatus.groqConfigured
                          ? 'Configured'
                          : 'Not Configured'}
                    </Badge>
                  </div>
                  <div className="text-ink-secondary space-y-0.5">
                    <div>
                      Text model:{' '}
                      <span className="font-mono text-navy font-semibold">
                        {integrationStatus?.groqModel || '—'}
                      </span>
                    </div>
                    <div>
                      Receipt (vision):{' '}
                      <span className="font-mono text-navy font-semibold">
                        {integrationStatus?.groqVisionModel || '—'}
                      </span>
                    </div>
                    <div>
                      Voice (speech-to-text):{' '}
                      <span className="font-mono text-navy font-semibold">
                        {integrationStatus?.groqTranscriptionModel || '—'}
                      </span>
                    </div>
                  </div>
                  <div className="text-[11px] text-ink-muted">
                    Suggests an expense category, drafts expenses from one messy line, reads receipt
                    photos, and transcribes voice notes. Every suggestion is confirmed by a Founder
                    before it reaches the ledger, and model IDs are overridable by environment
                    variable because Groq retires models regularly.
                  </div>
                  <div className="text-[11px] text-ink-muted">
                    Founder two-factor enforcement:{' '}
                    <span className="font-semibold text-navy">
                      {integrationStatus?.mfaEnforcedForFounders ? 'enabled' : 'not enabled (enrolment available)'}
                    </span>
                  </div>
                  <div className="text-[11px] text-ink-muted">
                    Without a key, expense entry still works — the built-in rule categorizer is used
                    and labelled as such.
                  </div>
                </div>

                <div className="p-4 rounded-2xl bg-surface-inset/50 border border-surface-border space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-navy">PhilSMS Gateway</span>
                    <Badge
                      variant={integrationStatus?.philsmsConfigured ? 'success' : 'warning'}
                      size="sm"
                    >
                      {!integrationStatus
                        ? 'Checking'
                        : integrationStatus.philsmsConfigured
                          ? 'Configured'
                          : 'Simulation Mode'}
                    </Badge>
                  </div>
                  <div className="text-ink-secondary">
                    Sender ID: <span className="font-mono text-navy font-semibold">{integrationStatus?.philsmsSenderId || 'PhilSMS'}</span>
                  </div>
                  <div className="text-[11px] text-ink-muted">
                    Configured means the key exists; it does not mean a message was accepted or delivered.
                  </div>
                  <form onSubmit={handleSmsTest} className="space-y-2 pt-2 border-t border-surface-border">
                    <label htmlFor="philsms-test-phone" className="block font-bold text-navy">Send a real test SMS to your phone</label>
                    <div className="flex flex-col sm:flex-row gap-2">
                      <input
                        id="philsms-test-phone"
                        type="tel"
                        autoComplete="tel"
                        required
                        value={testPhone}
                        onChange={(event) => setTestPhone(event.target.value)}
                        placeholder="09XXXXXXXXX or +639XXXXXXXXX"
                        className="min-w-0 flex-1 rounded-xl border border-surface-border bg-white px-3 py-2 text-xs"
                      />
                      <Button type="submit" size="sm" isLoading={isTestingSms} disabled={!integrationStatus?.philsmsConfigured || isTestingSms || !testPhone.trim()}>
                        Send Test SMS
                      </Button>
                    </div>
                    <p className="text-[11px] text-ink-muted">This sends a billable message. Use a number you control. Gateway acceptance is not the same as delivery.</p>
                    {smsTestResult && (
                      <div role="status" className={`rounded-lg border p-3 text-[11px] ${smsTestResult.accepted ? 'border-status-success/20 bg-status-success-bg text-status-success' : 'border-status-danger/20 bg-status-danger-bg text-status-danger'}`}>
                        <strong>{smsTestResult.accepted ? 'PhilSMS API accepted the test' : 'Test not confirmed'}</strong>
                        {smsTestResult.error && <div className="mt-1">{smsTestResult.error}</div>}
                        {smsTestResult.providerMessageId && <div className="mt-1">Provider message ID: <span className="font-mono">{smsTestResult.providerMessageId}</span></div>}
                        {smsTestResult.note && <div className="mt-1">{smsTestResult.note}</div>}
                      </div>
                    )}
                  </form>
                </div>

                <div className="p-4 rounded-2xl bg-surface-inset/50 border border-surface-border space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-navy">SMTP Email (Nodemailer)</span>
                    <Badge
                      variant={integrationStatus?.smtpConfigured ? 'success' : 'warning'}
                      size="sm"
                    >
                      {!integrationStatus
                        ? 'Checking'
                        : integrationStatus.smtpConfigured
                          ? 'Configured'
                          : 'Not configured'}
                    </Badge>
                  </div>
                  <div className="text-ink-secondary">
                    Request for Payment emails and SMTP test messages.
                  </div>
                  <div className="text-[11px] text-ink-muted">
                    Credentials are server-side environment variables and are never displayed
                    here. See <span className="font-mono">docs/COMMUNICATIONS_SETUP.md</span>.
                  </div>
                </div>

                <div className="p-4 rounded-2xl bg-surface-inset/50 border border-surface-border space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-navy">Automatic SMS Reminders</span>
                    <Badge
                      variant={integrationStatus?.automaticRemindersEnabled ? 'success' : 'neutral'}
                      size="sm"
                    >
                      {!integrationStatus
                        ? 'Checking'
                        : integrationStatus.automaticRemindersEnabled
                          ? 'Enabled globally'
                          : 'Disabled (default)'}
                    </Badge>
                  </div>
                  <div className="text-ink-secondary">
                    Scheduled reminders run only when enabled globally AND per invoice.
                  </div>
                  <div className="text-[11px] text-ink-muted">
                    Controlled by <span className="font-mono">AUTOMATIC_REMINDERS_ENABLED</span> on
                    the server; sends Mon–Sat 8AM–6PM Asia/Manila only.
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Email Templates (Founder only) */}
        {isFounder && <TemplateEditorCard />}

        {/* SMTP Test Email (Founder only) */}
        {isFounder && <TestEmailCard />}

        {/* Database & Sync Controls */}
        <Card>
          <CardHeader>
            <div className="flex items-center space-x-2.5">
              <Database className="w-5 h-5 text-navy" />
              <CardTitle>Supabase Database & Sync</CardTitle>
            </div>
            <CardDescription>Live PostgreSQL ledger — all records are stored and mutated server-side</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 text-xs">
            <div className="p-4 rounded-2xl bg-slate-50 border border-slate-200 space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-bold text-navy">Supabase Project</span>
                <Badge
                  variant={integrationStatus?.supabaseConfigured ? 'success' : 'warning'}
                  size="sm"
                >
                  {!integrationStatus
                    ? 'Checking'
                    : integrationStatus.supabaseConfigured
                      ? 'Configured'
                      : 'Local Dev Default'}
                </Badge>
              </div>
              <div className="text-ink-secondary">
                Endpoint:{' '}
                <span className="font-mono text-navy font-semibold">
                  {process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://localhost:54321'}
                </span>
              </div>
              <div className="text-[11px] text-ink-muted">
                Data is fetched and mutated directly through Supabase PostgreSQL with Row Level
                Security enforced on every query. There is no local mock data — to seed the demo
                ledger, run the SQL scripts in <span className="font-mono">supabase/migrations/</span>.
              </div>
              <div className="text-[11px] text-ink-secondary">
                Ledger status:{' '}
                <span className="font-semibold text-navy">
                  {isLoading ? 'Synchronizing…' : isLoaded ? 'Synchronized' : 'Not loaded'}
                </span>
              </div>
            </div>

            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 p-4 rounded-2xl bg-slate-50 border border-slate-200">
              <div className="space-y-0.5">
                <div className="font-bold text-navy">Resync Ledger from Supabase</div>
                <div className="text-ink-secondary">
                  Re-fetches projects, invoices, expenses, attendance, payroll, and bale records
                  from the live database.
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={handleResyncData}
                isLoading={isResyncing}
                leftIcon={<RefreshCw className="w-3.5 h-3.5" />}
              >
                Resync Now
              </Button>
            </div>

            <div className="p-4 rounded-2xl bg-slate-50 border border-slate-200 space-y-1.5">
              <div className="font-bold text-navy">Session Timeouts &amp; Sign-in Rate Limits</div>
              <div className="text-ink-secondary">
                Active client policy:{' '}
                <span className="font-mono font-semibold text-navy">
                  {integrationStatus?.sessionPolicy?.idleMinutes ?? 20} min idle
                </span>
                {' · '}
                <span className="font-mono font-semibold text-navy">
                  {integrationStatus?.sessionPolicy?.absoluteHours ?? 8} h absolute
                </span>
                {' · '}
                <span className="font-mono font-semibold text-navy">
                  {integrationStatus?.sessionPolicy?.warningSeconds ?? 120} s warning
                </span>{' '}
                (applies to all roles: Founder and Supervisor).
              </div>
              <div className="text-[11px] text-ink-muted">
                Must match Supabase Dashboard → Authentication → Sessions (inactivity 20 min,
                time-box 8 h). Because <span className="font-mono">NEXT_PUBLIC_SESSION_*</span>{' '}
                values are baked in at build time, changing them in Vercel requires a rebuild, not a
                redeploy. Sign-in is rate-limited per IP (10 per 5 min, never per-account lockout).
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
