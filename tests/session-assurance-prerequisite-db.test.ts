import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync('supabase/migrations/20261105000000_session_assurance_prerequisite.sql', 'utf8');
const founder = '00000000-0000-0000-0000-000000000001';
const supervisor = '00000000-0000-0000-0000-000000000002';
const unknown = '00000000-0000-0000-0000-000000000003';

describe('additive session assurance prerequisite', () => {
  it('reads only the authenticated identity, without exposing factor rows or modifying existing grants', async () => {
    const db = new PGlite();
    try {
      await db.exec(`
        create role anon; create role authenticated; create role service_role;
        create schema auth;
        create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
        create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
        grant usage on schema auth, public to authenticated, anon;
        create table auth.mfa_factors(id int, user_id uuid, status text, secret text);
        revoke all on auth.mfa_factors from public, authenticated, anon;
        insert into auth.mfa_factors values (1,'${founder}','verified','private'),(2,'${supervisor}','unverified','private');
        create table public.existing(id int);
        grant select on public.existing to authenticated;
      `);
      await db.exec(migration);
      // Reapplication is harmless and keeps existing grants unchanged.
      await db.exec(migration);
      expect((await db.query<{allowed: boolean}>("select has_table_privilege('authenticated','public.existing','select') as allowed")).rows[0].allowed).toBe(true);
      expect((await db.query<{allowed: boolean}>("select has_table_privilege('authenticated','auth.mfa_factors','select') as allowed")).rows[0].allowed).toBe(false);
      await db.exec('set role authenticated');
      async function decision(user: string, aal: string | null) {
        await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)", [user, JSON.stringify(aal ? {aal} : {})]);
        return (await db.query<{result: boolean}>('select public.session_assurance_satisfied() as result')).rows[0].result;
      }
      expect(await decision(founder, 'aal1')).toBe(false);
      expect(await decision(founder, 'aal2')).toBe(true);
      expect(await decision(supervisor, 'aal1')).toBe(true);
      expect(await decision(unknown, 'aal1')).toBe(true);
      expect(await decision(unknown, null)).toBe(false);
      expect(await decision(unknown, 'unexpected')).toBe(false);
      expect(await decision('', 'aal2')).toBe(false);
      await expect(db.query('select * from auth.mfa_factors')).rejects.toThrow(/permission denied/);
      await db.exec("reset role; update auth.mfa_factors set status='verified' where id=2; set role authenticated");
      expect(await decision(supervisor, 'aal1')).toBe(false);
      expect(await decision(supervisor, 'aal2')).toBe(true);
      await db.exec('reset role; set role anon');
      await expect(db.query('select public.session_assurance_satisfied()')).rejects.toThrow(/permission denied/);
    } finally {
      await db.close();
    }
  }, 30000);
});
