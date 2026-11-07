import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { founderFixture, founderOne, supervisor } from './helpers/founder-fixture';

const guard = readFileSync('supabase/migrations/20261107000000_team_update_repair.sql', 'utf8');
const removal = readFileSync('supabase/migrations/20261107000003_guarded_team_removal.sql', 'utf8');

describe('team removal preserves referenced history', () => {
  it('rejects restricted roles and linked rows, and removes only an unreferenced profile', async () => {
    const db = new PGlite();
    try {
      await db.exec(founderFixture);
      await db.exec(`
        ALTER TABLE public.project_supervisors DROP CONSTRAINT project_supervisors_supervisor_id_fkey;
        ALTER TABLE public.project_supervisors ADD CONSTRAINT project_supervisors_supervisor_id_fkey FOREIGN KEY (supervisor_id) REFERENCES public.users(id) ON DELETE CASCADE;
        ALTER TABLE public.audit_log ADD CONSTRAINT audit_log_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.users(id) ON DELETE SET NULL;
        CREATE TABLE public.user_notifications (recipient_id uuid REFERENCES public.users(id) ON DELETE CASCADE);
        CREATE TABLE public.expense_drafts (owner_id uuid REFERENCES public.users(id) ON DELETE CASCADE);
        CREATE TABLE public.advance_requests (submitted_by uuid REFERENCES public.users(id), approved_by uuid REFERENCES public.users(id) ON DELETE SET NULL);
        CREATE TABLE public.future_reference (user_id uuid REFERENCES public.users(id) ON DELETE CASCADE);
      `);
      await db.exec(guard); await db.exec(removal);
      await db.exec('SET ROLE authenticated');
      await expect(db.query('SELECT public.delete_team_profile_guarded($1,$2)', [founderOne, supervisor])).rejects.toThrow(/permission denied/);
      await db.exec('RESET ROLE; SET ROLE service_role');
      await expect(db.query('SELECT public.delete_team_profile_guarded($1,$2)', [supervisor, founderOne])).rejects.toThrow(/Founder access/);
      await expect(db.query('SELECT public.delete_team_profile_guarded($1,$2)', [founderOne, founderOne])).rejects.toThrow(/own account/);
      await expect(db.query('SELECT public.delete_team_profile_guarded($1,$2)', [founderOne, supervisor])).rejects.toThrow(/TEAM_ACCOUNT_HAS_LINKED_RECORDS/);
      await db.exec('RESET ROLE');
      expect((await db.query('SELECT recorded_by FROM public.attendance')).rows[0]).toEqual({ recorded_by: supervisor });
      expect((await db.query('SELECT active FROM public.workers WHERE id=$1', [supervisor])).rows[0]).toEqual({ active: true });
      expect((await db.query('SELECT * FROM public.audit_log')).rows).toHaveLength(0);
      await db.query('DELETE FROM public.attendance WHERE recorded_by=$1', [supervisor]);
      await db.query('DELETE FROM public.expenses WHERE created_by=$1', [supervisor]);
      // A future CASCADE foreign key must still block removal, not erase data.
      await db.query('INSERT INTO public.future_reference VALUES ($1)', [supervisor]);
      await db.exec('SET ROLE service_role');
      await expect(db.query('SELECT public.delete_team_profile_guarded($1,$2)', [founderOne, supervisor])).rejects.toThrow(/TEAM_ACCOUNT_HAS_LINKED_RECORDS/);
      await db.exec('RESET ROLE');
      expect((await db.query('SELECT * FROM public.future_reference')).rows).toHaveLength(1);
      await db.query('DELETE FROM public.future_reference WHERE user_id=$1', [supervisor]);
      await db.exec('CREATE TABLE public.assignment_history (assignment_id uuid REFERENCES public.project_supervisors(id) ON DELETE CASCADE)');
      await db.exec('SET ROLE service_role');
      await expect(db.query('SELECT public.delete_team_profile_guarded($1,$2)', [founderOne, supervisor])).rejects.toThrow(/TEAM_REMOVAL_SCHEMA_REVIEW_REQUIRED/);
      await db.exec('RESET ROLE; DROP TABLE public.assignment_history');
      await db.query('INSERT INTO public.user_notifications VALUES ($1)', [supervisor]);
      await db.exec('SET ROLE service_role');
      expect((await db.query<{ row: { id: string } }>('SELECT public.delete_team_profile_guarded($1,$2) as row', [founderOne, supervisor])).rows[0].row.id).toBe(supervisor);
      await db.exec('RESET ROLE');
      expect((await db.query('SELECT * FROM public.project_supervisors')).rows).toHaveLength(0);
      expect((await db.query('SELECT * FROM public.user_notifications')).rows).toHaveLength(0);
      expect((await db.query('SELECT active FROM public.workers WHERE id=$1', [supervisor])).rows[0]).toEqual({ active: true });
      expect((await db.query('SELECT action, actor_id FROM public.audit_log')).rows[0]).toMatchObject({ action: 'delete', actor_id: founderOne });
    } finally { await db.close(); }
  });
});
