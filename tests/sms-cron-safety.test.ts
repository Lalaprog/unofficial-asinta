import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createFakeDb, type FakeDb } from './helpers/fakeDb';

const mock = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({
  isServiceRoleConfigured: () => true,
  createServiceRoleClient: () => mock.getDb(),
}));
import { GET } from '@/app/api/cron/reminders/route';

let db: FakeDb;
const request = () => new NextRequest('http://localhost/api/cron/reminders', { headers: { authorization: 'Bearer secret' } });

beforeEach(() => {
  // Monday 10 AM in Manila, invoice due today.
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-02T02:00:00Z'));
  vi.stubEnv('CRON_SECRET', 'secret');
  vi.stubEnv('AUTOMATIC_REMINDERS_ENABLED', 'true');
  vi.stubEnv('PHILSMS_API_KEY', 'test');
  db = createFakeDb({
    invoices: [{ id: 'i1', invoice_number: 'I-1', client_id: 'c1', project_id: 'p1', amount: 100, amount_paid: 0,
      due_date: '2026-11-02', status: 'pending', automatic_reminders_enabled: true, reminders_paused_until: null }],
    clients: [{ id: 'c1', name: 'Client', contact_person: 'Contact', phone: '09178421190' }],
    projects: [{ id: 'p1', name: 'Project' }], email_logs: [], sms_logs: [], reminder_dispatches: [],
  });
  mock.getDb.mockReturnValue(db);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('scheduled SMS duplicate safety', () => {
  it('does not retry an unconfirmed provider timeout on the same key', async () => {
    const send = vi.fn().mockRejectedValue(new Error('timeout'));
    vi.stubGlobal('fetch', send);
    const first = await (await GET(request())).json();
    expect(first.results[0].outcome).toBe('unconfirmed');
    expect(db.tables.reminder_dispatches[0].status).toBe('pending');
    expect(db.tables.sms_logs[0]).toMatchObject({ status: 'pending', provider_status: 'unconfirmed' });
    const second = await (await GET(request())).json();
    expect(second.results[0].outcome).toBe('duplicate_skipped');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('never retries a legacy failed row or overlaps for the same key', async () => {
    db.tables.reminder_dispatches.push({ id: 'legacy', idempotency_key: 'i1:sms:due_today:2026-11-02', status: 'failed', error_message: 'timeout' });
    const send = vi.fn();
    vi.stubGlobal('fetch', send);
    const result = await (await GET(request())).json();
    expect(result.results[0].outcome).toBe('duplicate_skipped');
    expect(send).not.toHaveBeenCalled();
  });

  it('concurrent scheduled runs share the unique idempotency key', async () => {
    const send = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ status: 'success' }) }));
    vi.stubGlobal('fetch', send);
    const results = await Promise.all([GET(request()), GET(request())]);
    const bodies = await Promise.all(results.map((res) => res.json()));
    expect(bodies.flatMap((body) => body.results.map((row: { outcome: string }) => row.outcome)).sort()).toEqual(['duplicate_skipped', 'sent']);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
