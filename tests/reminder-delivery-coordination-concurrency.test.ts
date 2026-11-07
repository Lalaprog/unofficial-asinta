// Opt-in: run ONLY against an empty local disposable database named asinta_test_*.
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
const url = process.env.REMINDER_COORDINATION_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
const invoice = '00000000-0000-4000-8000-000000000001';
const a = '10000000-0000-4000-8000-000000000001';
const b = '10000000-0000-4000-8000-000000000002';
let admin: Client, first: Client, second: Client;
suite('delivery coordination in PostgreSQL', () => {
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (!['localhost','127.0.0.1','[::1]'].includes(parsed.hostname) || !parsed.pathname.slice(1).startsWith('asinta_test_')) throw Error('Use an empty local disposable database.');
    admin = new Client({connectionString:url}); first = new Client({connectionString:url}); second = new Client({connectionString:url});
    await Promise.all([admin.connect(),first.connect(),second.connect()]);
    if ((await admin.query("SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S') LIMIT 1")).rowCount) throw Error('Database is not empty');
    await admin.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF;
    END $$; CREATE TABLE public.invoices(id uuid primary key); INSERT INTO public.invoices VALUES ('${invoice}');`);
    await admin.query(readFileSync('supabase/migrations/20261107000005_reminder_delivery_coordination.sql','utf8'));
  }, 30000);
  afterAll(async () => { await Promise.all([admin?.end(), first?.end(), second?.end()]); });
  it('waits for an overlapping manual claim and blocks the scheduled claim after commit', async () => {
    await first.query('BEGIN'); await second.query('BEGIN');
    expect((await first.query('SELECT public.reserve_reminder_delivery($1,$2,$3,$4) AS result',[invoice,'email','manual',a])).rows[0].result).toBe('reserved');
    let finished = false;
    const pending = second.query('SELECT public.reserve_reminder_delivery($1,$2,$3,$4) AS result',[invoice,'email','automatic',b]).finally(()=>{finished=true;});
    await new Promise(resolve => setTimeout(resolve,200)); expect(finished).toBe(false);
    await first.query('COMMIT');
    expect((await pending).rows[0].result).toBe('busy'); await second.query('COMMIT');
    expect((await admin.query('SELECT count(*)::integer AS count FROM public.reminder_delivery_attempts')).rows[0].count).toBe(1);
  }, 15000);
  it('does not allow the reservation to expire or a different owner to clear it', async () => {
    expect((await admin.query('SELECT public.finish_reminder_delivery($1,$2,$3,$4) AS result',[invoice,'email',b,'cancelled'])).rows[0].result).toBe(false);
    expect((await admin.query('SELECT public.finish_reminder_delivery($1,$2,$3,$4) AS result',[invoice,'email',a,'unconfirmed'])).rows[0].result).toBe(true);
    expect((await admin.query('SELECT public.reserve_reminder_delivery($1,$2,$3,$4) AS result',[invoice,'email','manual',b])).rows[0].result).toBe('busy');
    expect((await admin.query('SELECT public.finish_reminder_delivery($1,$2,$3,$4) AS result',[invoice,'email',a,'accepted'])).rows[0].result).toBe(false);
  });
  it('preserves the existing ability to delete an invoice and cascades its coordination rows', async () => {
    await admin.query('DELETE FROM public.invoices WHERE id=$1',[invoice]);
    expect((await admin.query('SELECT count(*)::integer AS count FROM public.reminder_delivery_attempts')).rows[0].count).toBe(0);
    expect((await admin.query('SELECT count(*)::integer AS count FROM public.reminder_delivery_locks')).rows[0].count).toBe(0);
  });
});
