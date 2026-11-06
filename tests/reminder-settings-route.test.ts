import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createFakeDb, type FakeDb } from './helpers/fakeDb';
const mocks = vi.hoisted(() => ({ db: {} as unknown, founder: true }));
vi.mock('@/lib/supabase/server', () => ({ createServerSupabaseClient: () => mocks.db }));
vi.mock('@/lib/auth/serverRole', () => ({ requireFounder: async () => mocks.founder ? {ok:true,userId:'founder'} : {ok:false,status:403,error:'Forbidden'} }));
import { GET, PUT } from '@/app/api/reminders/settings/route';
const req = (body: unknown) => new NextRequest('http://localhost/api/reminders/settings', { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
let db: FakeDb;
beforeEach(() => {
  db = createFakeDb({reminder_settings:[{singleton:true,master_enabled:false,email_enabled:false,sms_enabled:false,revision:1}]});
  const from = db.from;
  db.from = (table) => {
    const query = from(table);
    if (table === 'reminder_settings') {
      const update = query.update;
      query.update = (patch: Record<string, unknown>) => update({...patch, revision: db.tables.reminder_settings[0].revision + 1});
    }
    return query;
  };
  mocks.db = db; mocks.founder = true;
});
describe('reminder settings API', () => {
  it('requires a Founder and never offers activation while the rollout is incomplete', async () => {
    mocks.founder = false;
    expect((await GET()).status).toBe(403);
    expect((await PUT(req({master_enabled:false,email_enabled:true,sms_enabled:false,revision:1}))).status).toBe(403);
    mocks.founder = true;
    expect((await GET()).headers.get('cache-control')).toContain('no-store');
    expect((await (await GET()).json()).rolloutReady).toBe(false);
    expect((await PUT(req({master_enabled:true,email_enabled:true,sms_enabled:false,revision:1}))).status).toBe(422);
    expect(db.tables.reminder_settings[0].master_enabled).toBe(false);
  });
  it('saves independent preferences and rejects stale revisions', async () => {
    expect((await PUT(req({master_enabled:false,email_enabled:true,sms_enabled:false,revision:1}))).status).toBe(200);
    expect(db.tables.reminder_settings[0]).toMatchObject({master_enabled:false,email_enabled:true,sms_enabled:false,revision:2});
    expect((await PUT(req({master_enabled:false,email_enabled:false,sms_enabled:true,revision:1}))).status).toBe(409);
    expect(db.tables.reminder_settings[0].email_enabled).toBe(true);
  });
  it('fails closed on missing or unreadable settings', async () => {
    db.tables.reminder_settings.length = 0;
    expect((await GET()).status).toBe(503);
    mocks.db = { from: () => { throw Error('offline'); } };
    expect((await GET()).status).toBe(503);
    expect((await PUT(req({master_enabled:false,email_enabled:true,sms_enabled:false,revision:1}))).status).toBe(503);
  });
});
