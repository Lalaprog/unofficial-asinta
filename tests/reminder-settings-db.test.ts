import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync('supabase/migrations/20261106000003_reminder_settings_foundation.sql', 'utf8');

describe('reminder settings foundation', () => {
  it('defaults off, cannot be activated yet, and enforces Founder and assurance access', async () => {
    const db = new PGlite();
    try {
      await db.exec(`create role anon; create role authenticated; create role service_role;
        create schema auth; grant usage on schema auth to authenticated, service_role; create table public.users(id uuid primary key);
        create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
        alter default privileges in schema public grant all on tables to authenticated, anon;
        create function public.is_founder() returns boolean language sql stable as $$ select current_setting('test.role',true)='founder' $$;
        create function public.session_assurance_satisfied() returns boolean language sql stable as $$ select current_setting('test.aal',true)='aal2' $$;`);
      await db.exec(migration);
      await db.exec("set role authenticated; set test.role='founder'; set test.aal='aal2'");
      expect((await db.query('select master_enabled,email_enabled,sms_enabled,revision from reminder_settings')).rows)
        .toEqual([{master_enabled:false,email_enabled:false,sms_enabled:false,revision:1}]);
      await expect(db.exec('update reminder_settings set master_enabled=true')).rejects.toThrow();
      expect((await db.query('update reminder_settings set email_enabled=true, revision=999 where revision=1 returning revision')).rows).toEqual([{revision:2}]);
      expect((await db.query('update reminder_settings set sms_enabled=true where revision=1 returning revision')).rows).toHaveLength(0);
      await expect(db.exec('delete from reminder_settings')).rejects.toThrow();
      await expect(db.exec('insert into reminder_settings default values')).rejects.toThrow();
      await db.exec("set test.role='supervisor'");
      expect((await db.query('select * from reminder_settings')).rows).toHaveLength(0);
      expect((await db.query('update reminder_settings set sms_enabled=true returning *')).rows).toHaveLength(0);
      await db.exec("set test.role='founder'; set test.aal='aal1'");
      expect((await db.query('select * from reminder_settings')).rows).toHaveLength(0);
      expect((await db.query('update reminder_settings set sms_enabled=true returning *')).rows).toHaveLength(0);
      await db.exec('set role anon');
      await expect(db.query('select * from reminder_settings')).rejects.toThrow();
    } finally { await db.close(); }
  });
});
