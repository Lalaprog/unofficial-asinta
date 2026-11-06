import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { founderFixture, founderOne, founderTwo, supervisor } from './helpers/founder-fixture';

const sql = readFileSync('supabase/migrations/20261107000000_team_update_repair.sql', 'utf8');
describe('targeted team profile repair', () => {
  it('installs the guarded update and preserves unrelated account data and permissions', async () => {
    const db = new PGlite();
    try {
      await db.exec(founderFixture);
      await db.exec(sql);
      expect((await db.query('select * from public.project_supervisors')).rows).toHaveLength(1);
      await db.exec('set role authenticated');
      await expect(db.query("select public.update_team_profile_guarded($1,$2,'Edited','supervisor')", [founderOne, supervisor])).rejects.toThrow(/permission denied/);
      await db.exec('reset role; set role service_role');
      await expect(db.query("select public.update_team_profile_guarded($1,$2,'Edited','supervisor')", [supervisor, supervisor])).rejects.toThrow(/Founder access/);
      const update = await db.query<{ row: { id: string; name: string } }>("select public.update_team_profile_guarded($1,$2,'Updated Supervisor','supervisor') as row", [founderOne, supervisor]);
      expect(update.rows[0].row).toMatchObject({ id: supervisor, name: 'Updated Supervisor' });
      await db.query("update public.users set role='supervisor' where id=$1", [founderTwo]);
      await expect(db.query("update public.users set role='supervisor' where id=$1", [founderOne])).rejects.toThrow(/last Founder/);
      await expect(db.query('delete from public.users where id=$1', [founderOne])).rejects.toThrow(/last Founder/);
      await db.exec('reset role');
      expect((await db.query('select * from public.project_supervisors')).rows).toHaveLength(1);
      expect((await db.query("select to_regprocedure('public.delete_team_profile_guarded(uuid,uuid)') as rpc")).rows[0]).toEqual({rpc:null});
      // Idempotent when an installation already has the guards.
      await db.exec(sql);
    } finally { await db.close(); }
  });
});
