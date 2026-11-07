import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync('supabase/staged/20261107000005_reminder_delivery_coordination.sql', 'utf8');
const invoice = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
const a = '10000000-0000-4000-8000-000000000001';
const b = '10000000-0000-4000-8000-000000000002';
const c = '10000000-0000-4000-8000-000000000003';
async function setup() {
  const db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create table public.invoices(id uuid primary key);
    insert into public.invoices values ('${invoice}'), ('${other}');`);
  await db.exec(sql);
  return db;
}
async function reserve(db: PGlite, inv: string, channel: string, source: string, id: string) {
  return (await db.query<{result:string}>('select public.reserve_reminder_delivery($1,$2,$3,$4) result', [inv, channel, source, id])).rows[0].result;
}
async function finish(db: PGlite, inv: string, channel: string, id: string, result: string) {
  return (await db.query<{result:boolean}>('select public.finish_reminder_delivery($1,$2,$3,$4) result', [inv, channel, id, result])).rows[0].result;
}
describe('staged delivery coordination', () => {
  it('serializes manual and automatic attempts on the same invoice/channel and never reuses a token', async () => {
    const db = await setup();
    try {
      await db.exec('set role service_role');
      expect(await reserve(db,invoice,'email','manual',a)).toBe('reserved');
      expect(await reserve(db,invoice,'email','automatic',b)).toBe('busy');
      expect(await finish(db,invoice,'email',b,'accepted')).toBe(false);
      expect(await finish(db,invoice,'email',a,'accepted')).toBe(true);
      expect(await finish(db,invoice,'email',a,'accepted')).toBe(false);
      expect(await reserve(db,invoice,'email','manual',a)).toBe('duplicate');
      expect(await reserve(db,invoice,'email','automatic',b)).toBe('reserved');
      expect(await finish(db,invoice,'email',b,'rejected')).toBe(true);
      await db.exec('reset role');
      const attempts = await db.query<{state:string}>('select state from public.reminder_delivery_attempts order by attempt_id');
      expect(attempts.rows.map(row => row.state)).toEqual(['accepted','rejected']);
    } finally { await db.close(); }
  });
  it('keeps an unconfirmed result blocked without an automatic timeout or unsafe owner reset', async () => {
    const db = await setup();
    try {
      expect(await reserve(db,invoice,'sms','automatic',a)).toBe('reserved');
      expect(await finish(db,invoice,'sms',a,'unconfirmed')).toBe(true);
      expect(await finish(db,invoice,'sms',a,'cancelled')).toBe(false);
      expect(await reserve(db,invoice,'sms','manual',b)).toBe('busy');
      expect(await reserve(db,invoice,'email','manual',b)).toBe('reserved');
      expect(await reserve(db,other,'sms','automatic',c)).toBe('reserved');
      const row = (await db.query<{state:string}>('select state from public.reminder_delivery_attempts where attempt_id=$1',[a])).rows[0];
      expect(row.state).toBe('unconfirmed');
    } finally { await db.close(); }
  });
  it('restricts direct access and RPC execution, rejects invalid requests and does not change invoices', async () => {
    const db = await setup();
    try {
      expect(await reserve(db,invoice,'invalid','manual',a)).toBe('invalid');
      expect(await finish(db,invoice,'sms',a,'invalid')).toBe(false);
      await db.exec('set role authenticated');
      await expect(db.query('select * from public.reminder_delivery_attempts')).rejects.toThrow(/permission denied/i);
      await expect(reserve(db,invoice,'sms','manual',a)).rejects.toThrow(/permission denied/i);
      await db.exec('reset role; set role service_role');
      await expect(db.query('select * from public.reminder_delivery_locks')).rejects.toThrow(/permission denied/i);
      await db.exec('reset role');
      expect((await db.query('select * from public.invoices')).rows).toHaveLength(2);
    } finally { await db.close(); }
  });
});
