import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { founderFixture, founderOne, founderTwo, supervisor } from './helpers/founder-fixture';

const migration = readFileSync('supabase/migrations/20261102000001_founder_guard.sql', 'utf8');
let db: PGlite;
beforeEach(async () => { db = new PGlite(); await db.exec(founderFixture); await db.exec(migration); }, 30000);
afterEach(async () => { await db.close(); });

describe('Founder profile database guard', () => {
  it('blocks bulk demotion, bulk deletion and truncate without removing a Founder', async () => {
    await expect(db.exec("UPDATE public.users SET role = 'supervisor' WHERE role = 'founder'")).rejects.toThrow(/last Founder/);
    await expect(db.exec("DELETE FROM public.users WHERE role = 'founder'")).rejects.toThrow(/last Founder/);
    await expect(db.exec('TRUNCATE public.users CASCADE')).rejects.toThrow(/cannot be truncated/);
    expect((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM public.users WHERE role = 'founder'")).rows[0].n).toBe(2);
  });

  it('allows one demotion but prevents removal of the last Founder through direct service-role writes', async () => {
    await db.exec('SET ROLE service_role');
    await db.query("UPDATE public.users SET role = 'supervisor' WHERE id = $1", [founderOne]);
    await expect(db.query('DELETE FROM public.users WHERE id = $1', [founderTwo])).rejects.toThrow(/last Founder/);
  });

  it('restricts RPCs to service_role and verifies actor and self protections', async () => {
    await db.exec('SET ROLE authenticated');
    await expect(db.query('SELECT public.delete_team_profile_guarded($1,$2)', [founderOne, supervisor])).rejects.toThrow(/permission denied/);
    await db.exec('RESET ROLE; SET ROLE service_role');
    await expect(db.query('SELECT public.delete_team_profile_guarded($1,$2)', [supervisor, founderOne])).rejects.toThrow(/Founder access/);
    await expect(db.query('SELECT public.delete_team_profile_guarded($1,$2)', [founderOne, founderOne])).rejects.toThrow(/own Founder/);
    await expect(db.query("SELECT public.update_team_profile_guarded($1,$2,'Founder One','supervisor')", [founderOne, founderOne])).rejects.toThrow(/own Founder/);
  });

  it('cleans attribution, roster and assignments with a deletion audit in one transaction', async () => {
    await db.exec('SET ROLE service_role');
    const result = await db.query<{ row: { id: string } }>('SELECT public.delete_team_profile_guarded($1,$2) AS row', [founderOne, supervisor]);
    expect(result.rows[0].row.id).toBe(supervisor);
    await db.exec('RESET ROLE');
    expect((await db.query('SELECT * FROM public.users WHERE id = $1', [supervisor])).rows).toHaveLength(0);
    expect((await db.query<{ recorded_by: string | null }>('SELECT recorded_by FROM public.attendance')).rows[0].recorded_by).toBeNull();
    expect((await db.query<{ active: boolean }>('SELECT active FROM public.workers WHERE id = $1', [supervisor])).rows[0].active).toBe(false);
    expect((await db.query('SELECT * FROM public.project_supervisors')).rows).toHaveLength(0);
    expect((await db.query<{ action: string; actor_id: string }>('SELECT action, actor_id FROM public.audit_log')).rows[0]).toMatchObject({ action: 'delete', actor_id: founderOne });
  });

  it('allows normal Supervisor edits on a fresh database with no Founder', async () => {
    // Simulate an unseeded installation; the guard does not require a Founder
    // until one has actually been created.
    await db.exec('DROP TRIGGER check_founder_after_update ON public.users');
    await db.exec("UPDATE public.users SET role = 'supervisor'");
    await db.exec(migration);
    await db.query("UPDATE public.users SET name = 'Edited' WHERE id = $1", [supervisor]);
    await db.query("UPDATE public.users SET role = 'founder' WHERE id = $1", [founderOne]);
    await expect(db.query("UPDATE public.users SET role = 'supervisor' WHERE id = $1", [founderOne])).rejects.toThrow(/last Founder/);
  });

  it('rolls back cleanup and profile removal if the audit insert fails', async () => {
    await db.exec("ALTER TABLE public.audit_log ADD CONSTRAINT refuse_delete CHECK (action <> 'delete'); SET ROLE service_role");
    await expect(db.query('SELECT public.delete_team_profile_guarded($1,$2)', [founderOne, supervisor])).rejects.toThrow();
    await db.exec('RESET ROLE');
    expect((await db.query('SELECT * FROM public.users WHERE id = $1', [supervisor])).rows).toHaveLength(1);
    expect((await db.query<{ recorded_by: string }>('SELECT recorded_by FROM public.attendance')).rows[0].recorded_by).toBe(supervisor);
    expect((await db.query<{ active: boolean }>('SELECT active FROM public.workers WHERE id = $1', [supervisor])).rows[0].active).toBe(true);
    expect((await db.query('SELECT * FROM public.project_supervisors')).rows).toHaveLength(1);
  });
});
