'use client';

import React, { useState } from 'react';
import { AlertCircle, CheckCircle2, MailCheck, Send } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/Card';
import { useAuth } from '@/lib/auth/authContext';
import { isValidEmail } from '@/lib/email/format';

/**
 * Founder-only SMTP verification. Sends a clearly labeled BALE test email —
 * defaults to the signed-in Founder's own address; any other recipient
 * requires an explicit confirmation step.
 */
export const TestEmailCard: React.FC = () => {
  const { user } = useAuth();
  const [to, setTo] = useState('');
  const [needsConfirmation, setNeedsConfirmation] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const effectiveTo = to.trim() || user?.email || '';
  const isDifferentRecipient =
    Boolean(to.trim()) && to.trim().toLowerCase() !== (user?.email || '').toLowerCase();

  const handleSend = async (confirmDifferentRecipient: boolean) => {
    if (isSending) return;
    if (to.trim() && !isValidEmail(to.trim())) {
      setResult({ ok: false, message: 'Please enter a valid email address.' });
      return;
    }
    setIsSending(true);
    setResult(null);

    try {
      const res = await fetch('/api/email/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: to.trim() || undefined,
          confirmDifferentRecipient,
        }),
      });
      const data = await res.json().catch(() => null);

      if (res.status === 409 && data?.requiresConfirmation) {
        setNeedsConfirmation(true);
        return;
      }
      setNeedsConfirmation(false);

      if (!res.ok || !data?.accepted) {
        setResult({
          ok: false,
          message:
            data?.error ||
            'The SMTP server rejected the test message. Verify the SMTP settings on the server.',
        });
        return;
      }

      setResult({
        ok: true,
        message: `Accepted by mail server — the SMTP server accepted the test message for ${data.to}. Check the inbox (including spam) to confirm real delivery.`,
      });
    } catch {
      setResult({ ok: false, message: 'Test email outcome not confirmed. Check the recipient mailbox before retrying; it may have been sent.' });
    } finally {
      setIsSending(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center space-x-2.5">
          <MailCheck className="w-5 h-5 text-navy" />
          <CardTitle>Send Test Email</CardTitle>
        </div>
        <CardDescription>
          Verifies the server&rsquo;s SMTP configuration by sending a clearly labeled BALE test
          message. No credentials are ever shown or returned.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-xs">
        <div className="flex flex-col sm:flex-row gap-3 sm:items-end">
          <div className="flex-1">
            <Input
              label={`Test Recipient (defaults to your account: ${user?.email || '—'})`}
              type="email"
              placeholder={user?.email || 'you@asinta.ph'}
              value={to}
              onChange={(e) => {
                setTo(e.target.value);
                setNeedsConfirmation(false);
                setResult(null);
              }}
            />
          </div>
          <Button
            variant="primary"
            size="sm"
            onClick={() => handleSend(false)}
            isLoading={isSending}
            disabled={isSending}
            leftIcon={!isSending ? <Send className="w-3.5 h-3.5" /> : undefined}
          >
            Send Test Email
          </Button>
        </div>

        {needsConfirmation && (
          <div className="p-3 rounded-xl bg-status-warning-bg border border-status-warning/20 text-status-warning space-y-2">
            <p>
              You are sending the test to{' '}
              <span className="font-mono font-bold">{effectiveTo}</span>, which is different from
              your own account email. Confirm to proceed.
            </p>
            <div className="flex justify-end space-x-2">
              <Button variant="secondary" size="sm" onClick={() => setNeedsConfirmation(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={() => handleSend(true)}
                isLoading={isSending}
              >
                Confirm Different Recipient
              </Button>
            </div>
          </div>
        )}

        {result && (
          <div
            className={`p-3 rounded-xl border flex items-start space-x-2 ${
              result.ok
                ? 'bg-status-success-bg border-status-success/20 text-status-success'
                : 'bg-status-danger-bg border-status-danger/20 text-status-danger'
            }`}
          >
            {result.ok ? (
              <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
            ) : (
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            )}
            <span className="leading-relaxed">{result.message}</span>
          </div>
        )}

        {isDifferentRecipient && !needsConfirmation && (
          <p className="text-[11px] text-ink-muted">
            Note: sending to an address other than your own will ask for an extra confirmation.
          </p>
        )}
      </CardContent>
    </Card>
  );
};
