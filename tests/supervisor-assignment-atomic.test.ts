import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { founderFixture, founderOne, supervisor } from './helpers/founder-fixture';
const repair = readFileSync('supabase/migrations/20261107000000_team_update_repair.sql', 'utf8');
const assignment = readFileSync('supabase/migrations/20261107000001_atomic_supervisor_assignments.sql', 'utf8');
const a='10000000-0000-0000-0000-000000000010', b='10000000-0000-0000-0000-000000000011', missing='10000000-0000-0000-0000-000000000012';
describe('atomic supervisor project assignments', () => {
  it('supports several sites and rolls back an invalid replacement without losing the existing site', async () => {
    const db = new PGlite();
    try {
      await db.exec(founderFixture);
      await db.exec(`create table public.projects (id uuid primary key); alter table public.project_supervisors add column project_id uuid references public.projects(id); alter table public.project_supervisors add unique(project_id,supervisor_id); alter table public.project_supervisors alter column id set default gen_random_uuid();`);
      await db.query('insert into public.projects values ($1),($2)',[a,b]);
      await db.query('update public.project_supervisors set project_id=$1',[a]);
      await db.exec(repair); await db.exec(assignment);
      await db.exec('set role authenticated');
      await expect(db.query('select public.replace_supervisor_projects_guarded($1,$2,$3::uuid[])',[founderOne,supervisor,[a,b]])).rejects.toThrow(/permission denied/);
      await db.exec('reset role; set role service_role');
      await expect(db.query('select public.replace_supervisor_projects_guarded($1,$2,$3::uuid[])',[supervisor,supervisor,[a,b]])).rejects.toThrow(/Founder access/);
      await expect(db.query('select public.replace_supervisor_projects_guarded($1,$2,$3::uuid[])',[founderOne,supervisor,[b,missing]])).rejects.toThrow(/unavailable/);
      await db.exec('reset role');
      expect((await db.query('select project_id from public.project_supervisors')).rows).toEqual([{project_id:a}]);
      await db.exec('set role service_role');
      const result=await db.query<{result:{project_count:number}}>('select public.replace_supervisor_projects_guarded($1,$2,$3::uuid[]) as result',[founderOne,supervisor,[a,b]]);
      expect(result.rows[0].result.project_count).toBe(2);
      await db.exec('reset role');
      expect((await db.query('select project_id from public.project_supervisors order by project_id')).rows).toEqual([{project_id:a},{project_id:b}]);
    } finally { await db.close(); }
  });
});
