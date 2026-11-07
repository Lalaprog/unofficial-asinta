// Opt-in: ONLY an empty local disposable database named asinta_test_*.
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { founderFixture, founderOne, supervisor } from './helpers/founder-fixture';

const url = process.env.TEAM_REMOVAL_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
let admin: Client, first: Client, second: Client;
suite('guarded team removal concurrency', () => {
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) || !parsed.pathname.slice(1).startsWith('asinta_test_')) throw new Error('Use an empty local disposable database.');
    admin = new Client({ connectionString: url }); first = new Client({ connectionString: url }); second = new Client({ connectionString: url });
    await Promise.all([admin.connect(), first.connect(), second.connect()]);
    if ((await admin.query("SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S') LIMIT 1")).rowCount || (await admin.query("SELECT 1 FROM pg_namespace WHERE nspname='app_private'")).rowCount) throw new Error('Database is not empty');
    const fixture = founderFixture.replace('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;', () => `DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF;
    END $$;`);
    await admin.query(fixture);
    await admin.query(`ALTER TABLE public.project_supervisors DROP CONSTRAINT project_supervisors_supervisor_id_fkey;
      ALTER TABLE public.project_supervisors ADD CONSTRAINT project_supervisors_supervisor_id_fkey FOREIGN KEY (supervisor_id) REFERENCES public.users(id) ON DELETE CASCADE;
      ALTER TABLE public.audit_log ADD CONSTRAINT audit_log_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.users(id) ON DELETE SET NULL;
      DELETE FROM public.attendance; DELETE FROM public.expenses;
      CREATE TABLE public.user_notifications (recipient_id uuid REFERENCES public.users(id) ON DELETE CASCADE);
      CREATE TABLE public.new_history (user_id uuid REFERENCES public.users(id) ON DELETE SET NULL);`);
    await admin.query(readFileSync('supabase/migrations/20261107000000_team_update_repair.sql', 'utf8'));
    await admin.query(readFileSync('supabase/migrations/20261107000003_guarded_team_removal.sql', 'utf8'));
  }, 30000);
  afterAll(async () => { await Promise.all([admin?.end(), first?.end(), second?.end()]); });
  it('sees a new history reference that commits while profile locking waits', async () => {
    await first.query('BEGIN'); await second.query('BEGIN');
    await first.query('INSERT INTO public.new_history VALUES ($1)', [supervisor]);
    let finished = false;
    const pending = second.query('SELECT public.delete_team_profile_guarded($1,$2)', [founderOne, supervisor])
      .then(() => null, error => error as Error).finally(() => { finished = true; });
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(finished).toBe(false);
    await first.query('COMMIT');
    expect((await pending)?.message).toMatch(/TEAM_ACCOUNT_HAS_LINKED_RECORDS/);
    await second.query('ROLLBACK');
    expect((await admin.query('SELECT user_id FROM public.new_history')).rows[0].user_id).toBe(supervisor);
    expect((await admin.query('SELECT id FROM public.users WHERE id=$1', [supervisor])).rowCount).toBe(1);
  }, 15000);
  it('rejects stale repeatable-read snapshots', async () => {
    await first.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await expect(first.query('SELECT public.delete_team_profile_guarded($1,$2)', [founderOne, supervisor])).rejects.toThrow(/TEAM_REMOVAL_REQUIRES_READ_COMMITTED/);
    await first.query('ROLLBACK');
  });
});
