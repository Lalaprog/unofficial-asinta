import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Executable PostgreSQL tests with a minimal Supabase-like auth/schema. This
// does not substitute for multi-connection concurrency or hosted RLS testing.
const founder = '00000000-0000-0000-0000-000000000001';
const supervisor = '00000000-0000-0000-0000-000000000002';
const worker = '00000000-0000-0000-0000-000000000003';
const payroll = '00000000-0000-0000-0000-000000000004';
const first = '00000000-0000-0000-0000-000000000005';
const second = '00000000-0000-0000-0000-000000000006';
const migration = readFileSync('supabase/migrations/20261102000000_atomic_payroll_payments.sql', 'utf8');
let db: PGlite;

async function query<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
  return db.query<T>(sql, params);
}

beforeEach(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    CREATE TABLE public.users(id uuid primary key, email text, role text);
    CREATE FUNCTION public.is_founder() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
      SELECT EXISTS(SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'founder')
    $$;
    CREATE TABLE public.workers(id uuid primary key);
    CREATE TABLE public.advances(id uuid primary key, worker_id uuid not null references public.workers(id), project_id uuid,
      amount numeric(10,2) not null, amount_deducted numeric(10,2) not null default 0,
      reason text not null, date date not null, status text not null, created_at timestamptz default now());
    CREATE TABLE public.payroll(id uuid primary key, worker_id uuid not null references public.workers(id), period_start date not null,
      period_end date not null, gross_pay numeric(10,2) not null, bale_deduction numeric(10,2) not null,
      other_deductions numeric(10,2) not null, net_pay numeric(10,2) not null,
      status text not null, days_worked numeric(5,2), hours_worked numeric(6,2), notes text, created_at timestamptz default now());
    CREATE TABLE public.audit_log(id uuid default gen_random_uuid(), actor_id uuid, actor_email text, action text,
      table_name text, record_id uuid, before_row jsonb, after_row jsonb, created_at timestamptz default now());
    GRANT USAGE ON SCHEMA public, auth TO authenticated, anon;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.payroll, public.advances TO authenticated;
    INSERT INTO public.users VALUES ('${founder}', 'founder@example.test', 'founder'), ('${supervisor}', 'supervisor@example.test', 'supervisor');
    INSERT INTO public.workers VALUES ('${worker}');
    INSERT INTO public.payroll (id, worker_id, period_start, period_end, gross_pay, bale_deduction, other_deductions, net_pay, status)
      VALUES ('${payroll}', '${worker}', '2026-10-01', '2026-10-07', 500, 120.25, 0, 379.75, 'draft');
    INSERT INTO public.advances(id,worker_id,amount,amount_deducted,reason,date,status) VALUES
      ('${first}','${worker}',80.10,0,'first','2026-09-01','active'),
      ('${second}','${worker}',100.20,0,'second','2026-09-02','active');
  `);
  await db.exec(migration);
  await db.exec(`SELECT set_config('request.jwt.claim.sub', '${founder}', false); SET ROLE authenticated;`);
}, 30000);

afterEach(async () => { await db.close(); });

describe('atomic payroll and Bale mutations (PostgreSQL)', () => {
  it('approves, pays oldest advances exactly, audits in the same transaction, and makes payment retries harmless', async () => {
    await query('SELECT public.set_payroll_status_atomic($1, $2)', [payroll, 'approved']);
    const response = await query<{ result: { outcome: string } }>('SELECT public.set_payroll_status_atomic($1, $2) AS result', [payroll, 'paid']);
    expect(response.rows[0].result.outcome).toBe('updated');
    const balances = await query<{ amount_deducted: string; status: string }>('SELECT amount_deducted, status FROM public.advances ORDER BY date');
    expect(balances.rows).toEqual([{ amount_deducted: '80.10', status: 'fully_deducted' }, { amount_deducted: '40.15', status: 'partially_deducted' }]);
    const retry = await query<{ result: { outcome: string } }>('SELECT public.set_payroll_status_atomic($1, $2) AS result', [payroll, 'paid']);
    expect(retry.rows[0].result.outcome).toBe('already_paid');
    await db.exec('RESET ROLE');
    const audit = await query<{ table_name: string; actor_id: string; before_row: { status: string }; after_row: { status: string } }>('SELECT table_name, actor_id, before_row, after_row FROM public.audit_log ORDER BY created_at, table_name');
    expect(audit.rows).toHaveLength(4);
    expect(audit.rows.every((row) => row.actor_id === founder)).toBe(true);
    expect(audit.rows.filter((row) => row.table_name === 'payroll').map((row) => [row.before_row.status, row.after_row.status])).toEqual([['draft', 'approved'], ['approved', 'paid']]);
  });

  it('rejects insufficient current balance without changing payroll, advances or audit', async () => {
    await query('SELECT public.set_payroll_status_atomic($1, $2)', [payroll, 'approved']);
    await query('SELECT public.record_advance_deduction_atomic($1, $2)', [first, 70]);
    await expect(query('SELECT public.set_payroll_status_atomic($1, $2)', [payroll, 'paid'])).rejects.toThrow(/less than the voucher deduction/);
    expect((await query<{ status: string }>('SELECT status FROM public.payroll WHERE id = $1', [payroll])).rows[0].status).toBe('approved');
    expect((await query<{ amount_deducted: string }>('SELECT amount_deducted FROM public.advances WHERE id = $1', [second])).rows[0].amount_deducted).toBe('0.00');
    await db.exec('RESET ROLE');
    expect((await query('SELECT * FROM public.audit_log')).rows).toHaveLength(2);
  });

  it('rolls back all deductions if an audit insert fails after a balance update', async () => {
    await query('SELECT public.set_payroll_status_atomic($1, $2)', [payroll, 'approved']);
    await db.exec(`RESET ROLE; ALTER TABLE public.audit_log ADD CONSTRAINT reject_advances CHECK (table_name <> 'advances'); SET ROLE authenticated;`);
    await expect(query('SELECT public.set_payroll_status_atomic($1, $2)', [payroll, 'paid'])).rejects.toThrow();
    expect((await query<{ status: string }>('SELECT status FROM public.payroll WHERE id = $1', [payroll])).rows[0].status).toBe('approved');
    expect((await query<{ amount_deducted: string }>('SELECT amount_deducted FROM public.advances WHERE id = $1', [first])).rows[0].amount_deducted).toBe('0.00');
    await db.exec('RESET ROLE');
    expect((await query('SELECT * FROM public.audit_log')).rows).toHaveLength(1);
  });

  it('denies old direct writes and finalized recalculation, while allowing draft edits', async () => {
    await expect(query('UPDATE public.advances SET amount_deducted = 10 WHERE id = $1', [first])).rejects.toThrow(/permission denied/);
    await expect(query("UPDATE public.payroll SET status = 'paid' WHERE id = $1", [payroll])).rejects.toThrow(/permission denied/);
    await query('UPDATE public.payroll SET gross_pay = 501 WHERE id = $1', [payroll]);
    await query('SELECT public.set_payroll_status_atomic($1, $2)', [payroll, 'approved']);
    await expect(query('UPDATE public.payroll SET gross_pay = 502 WHERE id = $1', [payroll])).rejects.toThrow(/cannot be recalculated/);
    await expect(query("INSERT INTO public.payroll (id,worker_id,period_start,period_end,gross_pay,bale_deduction,other_deductions,net_pay,status) VALUES (gen_random_uuid(),$1,'2026-01-01','2026-01-07',1,0,0,1,'paid')", [worker])).rejects.toThrow(/must start as drafts/);
  });

  it('rejects non-founders, invalid transitions and invalid manual deductions', async () => {
    await expect(query('SELECT public.set_payroll_status_atomic($1, $2)', [payroll, 'paid'])).rejects.toThrow(/Only approved/);
    await expect(query('SELECT public.record_advance_deduction_atomic($1, $2)', [first, 80.11])).rejects.toThrow(/exceeds/);
    await expect(query('SELECT public.record_advance_deduction_atomic($1, $2)', [first, 0.001])).rejects.toThrow(/two decimal/);
    await expect(query('SELECT public.set_advance_status_atomic($1, $2)', [first, 'fully_deducted'])).rejects.toThrow(/does not match/);
    await db.exec(`SELECT set_config('request.jwt.claim.sub', '${supervisor}', false)`);
    await expect(query('SELECT public.set_payroll_status_atomic($1, $2)', [payroll, 'approved'])).rejects.toThrow(/Founder access/);
    await expect(query('SELECT public.record_advance_deduction_atomic($1, $2)', [first, 10])).rejects.toThrow(/Founder access/);
    await expect(query('SELECT public.set_advance_status_atomic($1, $2)', [first, 'cancelled'])).rejects.toThrow(/Founder access/);
  });
});
