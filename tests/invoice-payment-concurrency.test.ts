// Destructive fixture: opt in ONLY on an empty, disposable local PostgreSQL DB.
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { founder, invoice, request, secondRequest, invoiceFixture, paymentSQL } from './helpers/invoice-payment-fixture';
const url = process.env.INVOICE_PAYMENT_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
const migration = readFileSync('supabase/migrations/20261104000000_atomic_invoice_payments.sql','utf8');
let admin:Client, first:Client, second:Client;

suite('real PostgreSQL invoice payment concurrency', () => {
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (!['localhost','127.0.0.1','[::1]'].includes(parsed.hostname) || !parsed.pathname.slice(1).startsWith('asinta_test_')) throw new Error('Use an empty local disposable database named asinta_test_*.');
    admin = new Client({connectionString:url}); first = new Client({connectionString:url}); second = new Client({connectionString:url});
    await Promise.all([admin.connect(), first.connect(), second.connect()]);
    const existing = await admin.query("SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S')");
    if (existing.rows[0].n !== 0 || (await admin.query("SELECT 1 FROM pg_namespace WHERE nspname='auth'")).rowCount) throw new Error('Test database must be empty.');
    const fixture = invoiceFixture.replace('CREATE ROLE anon; CREATE ROLE authenticated;', () => `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
    END $$;`);
    await admin.query(fixture); await admin.query(migration);
    for (const client of [first,second]) await client.query(`SELECT set_config('request.jwt.claim.sub','${founder}',false); SET ROLE authenticated`);
  }, 30000);
  beforeEach(async () => {
    await admin.query("UPDATE public.invoices SET amount_paid=0,status='pending',automatic_reminders_enabled=false WHERE id=$1",[invoice]);
    await admin.query('TRUNCATE public.invoice_payment_operations, public.audit_log');
  });
  afterAll(async () => { await Promise.all([first?.end(),second?.end(),admin?.end()]); });

  async function race(keyTwo: string) {
    const args = [request,invoice,30,100,0,'pending'];
    await first.query('BEGIN'); await second.query('BEGIN');
    const firstResult = await first.query(paymentSQL,args);
    let settled = false;
    const pending = second.query(paymentSQL,[keyTwo,invoice,30,100,0,'pending']).finally(() => { settled=true; });
    await new Promise(resolve => setTimeout(resolve,150));
    expect(settled).toBe(false);
    await first.query('COMMIT');
    const secondResult = await pending; await second.query('COMMIT');
    expect(firstResult.rows[0].result.outcome).toBe('recorded');
    expect((await admin.query('SELECT amount_paid,status FROM public.invoices WHERE id=$1',[invoice])).rows[0]).toEqual({amount_paid:'30.00',status:'partially_paid'});
    expect((await admin.query('SELECT * FROM public.audit_log')).rowCount).toBe(1);
    expect((await admin.query('SELECT * FROM public.invoice_payment_operations')).rowCount).toBe(1);
    return secondResult.rows[0].result.outcome;
  }
  it('serializes different requests and requires stale user review', async () => { expect(await race(secondRequest)).toBe('stale'); }, 10000);
  it('serializes a simultaneous same-key retry and records once', async () => { expect(await race(request)).toBe('already_recorded'); }, 10000);
  it('serializes a reminder change without reverting payment status', async () => {
    await first.query('BEGIN'); await second.query('BEGIN');
    await first.query(paymentSQL,[request,invoice,100,100,0,'pending']);
    let settled = false;
    const pending = second.query('UPDATE public.invoices SET automatic_reminders_enabled=true WHERE id=$1',[invoice]).finally(() => { settled=true; });
    await new Promise(resolve => setTimeout(resolve,150)); expect(settled).toBe(false);
    await first.query('COMMIT'); await pending; await second.query('COMMIT');
    expect((await admin.query('SELECT amount_paid,status,automatic_reminders_enabled FROM public.invoices WHERE id=$1',[invoice])).rows[0]).toEqual({amount_paid:'100.00',status:'paid',automatic_reminders_enabled:true});
  },10000);
});
