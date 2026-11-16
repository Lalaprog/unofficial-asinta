import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync('supabase/preflight/account_access_integrity.sql', 'utf8');

describe('read-only account access preflight', () => {
  it('reports broken profile and site links without returning identities or changing records', async () => {
    const db = new PGlite();
    try {
      await db.exec(`
        CREATE SCHEMA auth;
        CREATE TABLE auth.users (id int PRIMARY KEY);
        CREATE TABLE public.users (id int PRIMARY KEY, role text NOT NULL);
        CREATE TABLE public.projects (id int PRIMARY KEY);
        CREATE TABLE public.project_supervisors (project_id int, supervisor_id int);
        INSERT INTO auth.users VALUES (1), (2), (3);
        INSERT INTO public.users VALUES (1, 'founder'), (2, 'supervisor'), (4, 'supervisor');
        INSERT INTO public.projects VALUES (10);
        INSERT INTO public.project_supervisors VALUES (10, 2), (11, 2), (10, 1), (10, 5);
      `);
      const result = await db.query<{account_integrity_summary: Record<string, unknown>}>(sql);
      expect(result.rows[0].account_integrity_summary).toEqual({
        auth_users: 3,
        app_profiles: 3,
        auth_without_profile: 1,
        profiles_without_auth: 1,
        profile_roles: { founder: 1, supervisor: 2 },
        supervisor_project_links: 4,
        supervisor_links_with_missing_project: 1,
        supervisor_links_with_missing_profile: 1,
        supervisor_links_with_non_supervisor_profile: 1,
      });
      expect((await db.query('SELECT count(*) AS n FROM public.project_supervisors')).rows[0]).toEqual({ n: 4 });
      expect((await db.query('SELECT count(*) AS n FROM auth.users')).rows[0]).toEqual({ n: 3 });
    } finally {
      await db.close();
    }
  }, 30000);

  it('handles an empty environment without reporting broken links', async () => {
    const db = new PGlite();
    try {
      await db.exec(`CREATE SCHEMA auth; CREATE TABLE auth.users (id int); CREATE TABLE public.users (id int, role text); CREATE TABLE public.projects (id int); CREATE TABLE public.project_supervisors (project_id int, supervisor_id int);`);
      const result = await db.query<{account_integrity_summary: Record<string, unknown>}>(sql);
      expect(result.rows[0].account_integrity_summary).toEqual({
        auth_users: 0, app_profiles: 0, auth_without_profile: 0, profiles_without_auth: 0,
        profile_roles: {}, supervisor_project_links: 0, supervisor_links_with_missing_project: 0,
        supervisor_links_with_missing_profile: 0, supervisor_links_with_non_supervisor_profile: 0,
      });
    } finally {
      await db.close();
    }
  }, 30000);
});
