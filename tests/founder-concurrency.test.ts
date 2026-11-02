// Opt-in, destructive fixture on an EMPTY, disposable local PostgreSQL database.
// See docs/TEAM_ACCOUNT_OPERATIONS.md for setup and scope.
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { founderFixture, founderOne, founderTwo, supervisor } from './helpers/founder-fixture';

const url = process.env.FOUNDER_GUARD_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
const migration = readFileSync('supabase/migrations/20261102000001_founder_guard.sql', 'utf8');
let admin: Client;
let first: Client;
let second: Client;

suite('real PostgreSQL Founder concurrency', () => {
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) || !parsed.pathname.slice(1).startsWith('asinta_test_')) {
      throw new Error('Use an empty local disposable database named asinta_test_*.');
    }
    admin = new Client({ connectionString: url });
    first = new Client({ connectionString: url });
    second = new Client({ connectionString: url });
    await Promise.all([admin.connect(), first.connect(), second.connect()]);
    const existing = await admin.query("SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S')");
    if (existing.rows[0].n !== 0) throw new Error('Test database public schema must be empty.');
    if ((await admin.query("SELECT 1 FROM pg_namespace WHERE nspname='app_private'")).rowCount) {
      throw new Error('Test database must not contain an app_private schema.');
    }
    // Roles are cluster-wide; create only if missing in the disposable cluster.
    const fixture = founderFixture.replace('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;', () => `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF;
    END $$;`);
    await admin.query(fixture);
    await admin.query(migration);
  }, 30000);
  beforeEach(async () => {
    await admin.query("UPDATE public.users SET role = CASE WHEN id = $1 OR id = $2 THEN 'founder' ELSE 'supervisor' END", [founderOne, founderTwo]);
  });
  afterAll(async () => {
    await Promise.all([first?.end(), second?.end(), admin?.end()]);
  });

  it('serializes a direct demotion against a concurrent deletion', async () => {
    await first.query('BEGIN');
    await second.query('BEGIN');
    await first.query("UPDATE public.users SET role = 'supervisor' WHERE id = $1", [founderOne]);
    let settled = false;
    const pending = second.query('DELETE FROM public.users WHERE id = $1', [founderTwo])
      .then(() => ({ error: null as Error | null }), error => ({ error: error as Error }))
      .finally(() => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(settled).toBe(false);
    await first.query('COMMIT');
    expect((await pending).error?.message).toMatch(/last Founder/);
    await second.query('ROLLBACK');
    const result = await admin.query("SELECT count(*)::int AS n FROM public.users WHERE role='founder'");
    expect(result.rows[0].n).toBe(1);
  }, 15000);

  it('rechecks a concurrently demoted actor before any cleanup', async () => {
    await admin.query('INSERT INTO public.workers (id) VALUES ($1)', [founderOne]);
    await admin.query('INSERT INTO public.attendance (id, recorded_by) VALUES ($1, $2)', ['20000000-0000-0000-0000-000000000001', founderOne]);
    await first.query('BEGIN');
    await second.query('BEGIN');
    await first.query("UPDATE public.users SET role = 'supervisor' WHERE id = $1", [founderTwo]);
    let settled = false;
    const pending = second.query('SELECT public.delete_team_profile_guarded($1,$2)', [founderTwo, founderOne])
      .then(() => ({ error: null as Error | null }), error => ({ error: error as Error }))
      .finally(() => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(settled).toBe(false);
    await first.query('COMMIT');
    expect((await pending).error?.message).toMatch(/Founder access/);
    await second.query('ROLLBACK');
    const result = await admin.query('SELECT recorded_by FROM public.attendance WHERE id=$1', ['20000000-0000-0000-0000-000000000001']);
    expect(result.rows[0].recorded_by).toBe(founderOne);
    expect((await admin.query('SELECT active FROM public.workers WHERE id=$1', [founderOne])).rows[0].active).toBe(true);
    expect((await admin.query('SELECT id FROM public.users WHERE id=$1', [founderOne])).rowCount).toBe(1);
  }, 15000);

  it('rejects a stale REPEATABLE READ transaction instead of using its old snapshot', async () => {
    await second.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await second.query('SELECT * FROM public.users');
    await first.query('BEGIN');
    await first.query("UPDATE public.users SET role='supervisor' WHERE id=$1", [founderOne]);
    await first.query('COMMIT');
    const result = await second.query('DELETE FROM public.users WHERE id=$1', [founderTwo]).then(() => null, error => error);
    expect(result?.code).toBe('40001');
    await second.query('ROLLBACK');
    expect((await admin.query("SELECT count(*)::int AS n FROM public.users WHERE role='founder'")).rows[0].n).toBe(1);
  }, 15000);

  it('serializes competing Founder deletions without cleaning up the survivor', async () => {
    await admin.query('INSERT INTO public.workers (id) VALUES ($1) ON CONFLICT DO NOTHING', [founderTwo]);
    await admin.query('INSERT INTO public.attendance (id, recorded_by) VALUES ($1, $2)', ['20000000-0000-0000-0000-000000000002', founderTwo]);
    await first.query('BEGIN');
    await second.query('BEGIN');
    await first.query('SELECT public.delete_team_profile_guarded($1,$2)', [founderOne, founderTwo]);
    let settled = false;
    const pending = second.query('SELECT public.delete_team_profile_guarded($1,$2)', [founderTwo, founderOne])
      .then(() => ({ error: null as Error | null }), error => ({ error: error as Error }))
      .finally(() => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(settled).toBe(false);
    await first.query('COMMIT');
    expect((await pending).error?.message).toMatch(/Founder access/);
    await second.query('ROLLBACK');
    expect((await admin.query('SELECT id FROM public.users WHERE id=$1', [founderOne])).rowCount).toBe(1);
    expect((await admin.query('SELECT active FROM public.workers WHERE id=$1', [founderOne])).rows[0].active).toBe(true);
    expect((await admin.query('SELECT recorded_by FROM public.attendance WHERE id=$1', ['20000000-0000-0000-0000-000000000001'])).rows[0].recorded_by).toBe(founderOne);
    expect((await admin.query('SELECT recorded_by FROM public.attendance WHERE id=$1', ['20000000-0000-0000-0000-000000000002'])).rows[0].recorded_by).toBeNull();
  }, 15000);

});
