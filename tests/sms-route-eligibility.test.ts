import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createFakeDb, type FakeDb } from './helpers/fakeDb';

const mock = vi.hoisted(() => ({ getDb: vi.fn(), deliver: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServerSupabaseClient: () => mock.getDb() }));
vi.mock('@/lib/auth/serverRole', () => ({ requireFounder: async () => ({ ok: true, userId: 'founder' }) }));
vi.mock('@/lib/api/rateLimitGuard', () => ({ enforceRateLimit: () => null }));
vi.mock('@/lib/sms/deliver', () => ({ deliverAndLogSMS: mock.deliver }));
import { POST } from '@/app/api/sms/send/route';

let db: FakeDb;
const request = () => new NextRequest('http://localhost/api/sms/send', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ invoiceId: 'invoice', message: 'Reminder' }),
});

beforeEach(() => {
  db = createFakeDb({ invoices: [{ id: 'invoice', client_id: 'client', status: 'pending', amount: 100, amount_paid: 0 }],
    clients: [{ id: 'client', name: 'Client', contact_person: 'Contact', phone: '09178421190' }] });
  mock.getDb.mockReturnValue(db);
  mock.deliver.mockReset().mockResolvedValue({ success: true, simulated: false, uncertain: false, log: null });
});

describe('manual invoice SMS eligibility', () => {
  it.each([
    ['paid', 100], ['cancelled', 0], ['draft', 0], ['pending', 100], ['pending', 120],
  ])('does not send for %s with paid amount %s', async (status, paid) => {
    db.tables.invoices[0].status = status;
    db.tables.invoices[0].amount_paid = paid;
    expect((await POST(request())).status).toBe(422);
    expect(mock.deliver).not.toHaveBeenCalled();
  });

  it.each([
    {status:'unknown',amount:100,paid:0}, {status:'pending',amount:100,paid:null},
    {status:'pending',amount:'',paid:0}, {status:'pending',amount:'100',paid:'bad'},
    {status:'pending',amount:100,paid:-1}, {status:'pending',amount:-1,paid:0},
  ])('fails closed on malformed invoice details %#', async ({status,amount,paid}) => {
    Object.assign(db.tables.invoices[0],{status,amount,amount_paid:paid});
    expect((await POST(request())).status).toBe(422); expect(mock.deliver).not.toHaveBeenCalled();
  });

  it('allows a current unpaid invoice and resolves its registered recipient', async () => {
    expect((await POST(request())).status).toBe(200);
    expect(mock.deliver).toHaveBeenCalledWith(expect.objectContaining({ invoiceId: 'invoice', phone: '+639178421190' }));
  });
});
