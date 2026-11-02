import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildReminderSMS,
  detectReminderType,
  estimateSMSSegments,
  formatDateForSMS,
} from '@/lib/sms/templates';
import { normalizePhilippineMobile, toPhilSMSRecipient } from '@/lib/sms/phone';
import { sendPhilSMS } from '@/lib/sms/philsms';

const BASE = {
  contactPerson: 'Dr. Eduardo Laurel',
  companyName: 'Laurel Medical Group',
  invoiceNumber: 'ASINTA-2026-014',
  projectName: 'Laurel Clinic Extension',
  outstandingBalance: 1000000,
  dueDate: '2026-01-20',
};

describe('reminder SMS wording', () => {
  it('uses the "emailed on" wording only when a successful email exists', () => {
    const withEmail = buildReminderSMS({ ...BASE, paymentRequestSentDate: '2026-01-06T02:00:00Z' });
    expect(withEmail).toContain('Please refer to the Request for Payment emailed on Jan 6, 2026.');
    expect(withEmail).not.toContain('Please review the payment details for this invoice.');
  });

  it('falls back honestly when no successful email record exists', () => {
    const withoutEmail = buildReminderSMS({ ...BASE, paymentRequestSentDate: null });
    expect(withoutEmail).toContain('Please review the payment details for this invoice.');
    expect(withoutEmail).not.toContain('emailed on');
  });

  it('includes client, project, invoice, balance, and due date', () => {
    const message = buildReminderSMS(BASE);
    expect(message).toContain('Dear Dr. Eduardo Laurel');
    expect(message).toContain('ASINTA-2026-014');
    expect(message).toContain('Laurel Clinic Extension');
    expect(message).toContain('PHP 1,000,000.00');
    expect(message).toContain('due on Jan 20, 2026');
    expect(message).toContain('system-generated message');
  });

  it('prefers contact person, then company, then Valued Client', () => {
    expect(buildReminderSMS({ ...BASE, contactPerson: null })).toContain('Dear Laurel Medical Group');
    expect(buildReminderSMS({ ...BASE, contactPerson: null, companyName: null })).toContain(
      'Dear Valued Client'
    );
  });

  it('uses plain text with GSM-friendly currency and no Markdown', () => {
    const message = buildReminderSMS(BASE);
    expect(message).not.toContain('₱');
    expect(message).not.toMatch(/[*_#`[\]]/);
    expect(estimateSMSSegments(message).encoding).toBe('GSM-7');
  });
});

describe('reminder type detection', () => {
  it('detects upcoming, due_today, and overdue from Manila dates', () => {
    expect(detectReminderType('2026-01-20', '2026-01-17')).toBe('upcoming');
    expect(detectReminderType('2026-01-20', '2026-01-20')).toBe('due_today');
    expect(detectReminderType('2026-01-20', '2026-01-23')).toBe('overdue');
  });
});

describe('SMS segment estimation', () => {
  it('estimates GSM-7 segments (160 single / 153 concatenated)', () => {
    expect(estimateSMSSegments('a'.repeat(160))).toEqual({
      characterCount: 160,
      encoding: 'GSM-7',
      segments: 1,
    });
    expect(estimateSMSSegments('a'.repeat(161)).segments).toBe(2);
    expect(estimateSMSSegments('a'.repeat(306)).segments).toBe(2);
    expect(estimateSMSSegments('a'.repeat(307)).segments).toBe(3);
    expect(estimateSMSSegments('').segments).toBe(0);
  });

  it('switches to UCS-2 (70/67) when non-GSM characters are present', () => {
    const estimate = estimateSMSSegments(`₱ balance ${'x'.repeat(80)}`);
    expect(estimate.encoding).toBe('UCS-2');
    expect(estimate.segments).toBe(2);
  });

  it('counts GSM extension characters as two units', () => {
    expect(estimateSMSSegments('[]{}').characterCount).toBe(8);
  });
});

describe('Philippine phone normalization', () => {
  it('normalizes common formats to +639XXXXXXXXX', () => {
    expect(normalizePhilippineMobile('09178421190')).toBe('+639178421190');
    expect(normalizePhilippineMobile('+63 917 842 1190')).toBe('+639178421190');
    expect(normalizePhilippineMobile('639178421190')).toBe('+639178421190');
    expect(normalizePhilippineMobile('0917-842-1190')).toBe('+639178421190');
    expect(normalizePhilippineMobile('9178421190')).toBe('+639178421190');
  });

  it('rejects invalid numbers', () => {
    expect(normalizePhilippineMobile('12345')).toBeNull();
    expect(normalizePhilippineMobile('+6281234567890')).toBeNull();
    expect(normalizePhilippineMobile('0817 842 1190')).toBeNull();
    expect(normalizePhilippineMobile('')).toBeNull();
    expect(normalizePhilippineMobile(null)).toBeNull();
    expect(normalizePhilippineMobile('phone-number')).toBeNull();
  });

  it('produces the digits-only PhilSMS recipient', () => {
    expect(toPhilSMSRecipient('+639178421190')).toBe('639178421190');
  });
});

describe('honest gateway statuses', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('reports simulation mode when PHILSMS_API_KEY is missing (nothing is sent)', async () => {
    vi.stubEnv('PHILSMS_API_KEY', '');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await sendPhilSMS({ recipient: 'X', phone: '+639178421190', message: 'test' });
    expect(result.success).toBe(false);
    expect(result.simulated).toBe(true);
    expect(result.error).toContain('no SMS was sent');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reports a failure (never fake delivery) when the gateway rejects the send', async () => {
    vi.stubEnv('PHILSMS_API_KEY', 'test-key');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 401, json: async () => ({ message: 'Unauthorized' }) }))
    );

    const result = await sendPhilSMS({ recipient: 'X', phone: '+639178421190', message: 'test' });
    expect(result.success).toBe(false);
    expect(result.simulated).toBeUndefined();
    expect(result.error).toContain('HTTP 401');
  });

  it('requires PhilSMS to explicitly confirm API acceptance, not just HTTP 200', async () => {
    vi.stubEnv('PHILSMS_API_KEY', 'test-key');
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ status: 'error', message: 'Insufficient balance' }),
    })));

    const result = await sendPhilSMS({ recipient: 'X', phone: '+639178421190', message: 'test' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Insufficient balance');
  });

  it('returns provider acceptance and message ID only for explicit success', async () => {
    vi.stubEnv('PHILSMS_API_KEY', 'test-key');
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ status: 'success', data: { uid: 'provider-123' } }),
    })));

    const result = await sendPhilSMS({ recipient: 'X', phone: '+639178421190', message: 'test' });
    expect(result.success).toBe(true);
    expect(result.messageId).toBe('provider-123');
    expect(result.providerStatus).toBe('success');
  });

  it('formats SMS dates in Manila time', () => {
    expect(formatDateForSMS('2026-01-20')).toBe('Jan 20, 2026');
    // 16:30 UTC = 00:30 next day in Manila
    expect(formatDateForSMS('2026-01-19T16:30:00Z')).toBe('Jan 20, 2026');
  });
});

describe('uncertain gateway outcomes', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
  it('does not claim a timeout or server error means no SMS was accepted', async () => {
    vi.stubEnv('PHILSMS_API_KEY', 'test');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));
    expect((await sendPhilSMS({ recipient: 'X', phone: '+639178421190', message: 'test' })).uncertain).toBe(true);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })));
    expect((await sendPhilSMS({ recipient: 'X', phone: '+639178421190', message: 'test' })).uncertain).toBe(true);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })));
    expect((await sendPhilSMS({ recipient: 'X', phone: '+639178421190', message: 'test' })).uncertain).toBe(true);
  });
});
