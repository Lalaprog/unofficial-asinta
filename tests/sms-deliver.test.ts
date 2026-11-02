import { describe, expect, it, vi } from 'vitest';
import { createFakeDb } from './helpers/fakeDb';
import { deliverAndLogSMS } from '@/lib/sms/deliver';

const base = {
  recipient: 'Dr. Eduardo Laurel',
  phone: '+639178421190',
  message: 'Reminder: ASINTA-2026-014 is due.',
  invoiceId: 'invoice-1',
};

describe('deliverAndLogSMS', () => {
  it('records the attempt before sending and stores the accepted outcome', async () => {
    const db = createFakeDb();
    const send = vi.fn(async () => ({
      success: true,
      providerStatus: 'success',
      messageId: 'uid-123',
    }));

    const outcome = await deliverAndLogSMS({ db, ...base, send });

    expect(send).toHaveBeenCalledTimes(1);
    expect(outcome.success).toBe(true);
    expect(outcome.statusLabel).toBe('Sent');
    expect(outcome.error).toBeNull();

    const log = db.tables.sms_logs[0];
    expect(log.status).toBe('sent');
    expect(log.provider_message_id).toBe('uid-123');
    expect(log.invoice_id).toBe('invoice-1');
    expect(log.simulated).toBe(false);
  });

  it('never reports a simulated send as success', async () => {
    const db = createFakeDb();
    const outcome = await deliverAndLogSMS({
      db,
      ...base,
      send: async () => ({
        success: false,
        simulated: true,
        error: 'PhilSMS is not configured; no SMS was sent.',
      }),
    });

    expect(outcome.success).toBe(false);
    expect(outcome.simulated).toBe(true);
    expect(outcome.statusLabel).toMatch(/not sent/i);

    const log = db.tables.sms_logs[0];
    expect(log.status).toBe('failed');
    expect(log.simulated).toBe(true);
    expect(log.provider_status).toBe('simulation');
  });

  it('stores the gateway error for a genuine failure', async () => {
    const db = createFakeDb();
    const outcome = await deliverAndLogSMS({
      db,
      ...base,
      send: async () => ({ success: false, providerStatus: 'error', error: 'Invalid sender id' }),
    });

    expect(outcome.success).toBe(false);
    expect(outcome.error).toBe('Invalid sender id');
    expect(db.tables.sms_logs[0].error_message).toBe('Invalid sender id');
  });

  it('sends nothing when the attempt cannot be recorded', async () => {
    const send = vi.fn(async () => ({ success: true }));
    const failingDb = {
      from: () => ({
        insert: () => ({
          select: () => ({
            single: async () => ({ data: null, error: { message: 'insert failed' } }),
          }),
        }),
      }),
    };

    const outcome = await deliverAndLogSMS({ db: failingDb as never, ...base, send });

    expect(send).not.toHaveBeenCalled();
    expect(outcome.logWriteFailed).toBe(true);
    expect(outcome.success).toBe(false);
  });
});

describe('uncertain delivery', () => {
  it('leaves an unconfirmed attempt pending with a visible reason', async () => {
    const db = createFakeDb();
    const outcome = await deliverAndLogSMS({ db, ...base, send: async () => ({ success: false, uncertain: true, error: 'timeout' }) });
    expect(outcome.uncertain).toBe(true);
    expect(outcome.success).toBe(false);
    expect(db.tables.sms_logs[0]).toMatchObject({ status: 'pending', provider_status: 'unconfirmed', error_message: 'timeout' });
  });

  it('reports a failed final log write even when the provider accepted', async () => {
    const db = {
      from: () => ({
        insert: () => ({ select: () => ({ single: async () => ({ data: { id: 'pending-1', status: 'pending' }, error: null }) }) }),
        update: () => ({ eq: () => ({ select: () => ({ single: async () => ({ data: null, error: { message: 'write failed' } }) }) }) }),
      }),
    };
    const outcome = await deliverAndLogSMS({ db, ...base, send: async () => ({ success: true, messageId: 'accepted' }) });
    expect(outcome.success).toBe(true);
    expect(outcome.logUpdateFailed).toBe(true);
    expect(outcome.log?.status).toBe('pending');
  });
});
