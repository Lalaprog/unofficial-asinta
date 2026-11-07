import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const initial = readFileSync('supabase/migrations/20261106000003_reminder_settings_foundation.sql', 'utf8');
const epochs = readFileSync('supabase/migrations/20261107000004_reminder_channel_epochs.sql', 'utf8');

describe('reminder channel activation timestamps', () => {
  it('stays locked off; after a simulated future unlock, records only real activation and prevents caller tampering', async () => {
    const db = new PGlite();
    try {
      await db.exec(`create role anon; create role authenticated; create role service_role;
        create schema auth; grant usage on schema auth to authenticated, service_role;
        create table public.users(id uuid primary key);
        create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
        create function public.is_founder() returns boolean language sql stable as $$ select current_setting('test.role',true)='founder' $$;
        create function public.session_assurance_satisfied() returns boolean language sql stable as $$ select current_setting('test.aal',true)='aal2' $$;`);
      await db.exec(initial); await db.exec(epochs);
      await db.exec("set role authenticated; set test.role='founder'; set test.aal='aal2'");
      await db.exec("update reminder_settings set email_enabled=true, email_effective_since='2000-01-01'");
      expect((await db.query('select master_enabled,email_effective_since,sms_effective_since from reminder_settings')).rows[0])
        .toEqual({master_enabled:false,email_effective_since:null,sms_effective_since:null});
      await expect(db.exec('update reminder_settings set master_enabled=true')).rejects.toThrow();
      // Test a hypothetical later rollout in isolation; production remains locked.
      await db.exec('reset role; alter table public.reminder_settings drop constraint reminder_settings_rollout_locked');
      await db.exec('set role authenticated');
      const first = (await db.query<{email_effective_since: string; sms_effective_since: string | null}>("update reminder_settings set master_enabled=true, email_effective_since='2000-01-01' returning email_effective_since,sms_effective_since")).rows[0];
      expect(first.email_effective_since).toBeTruthy(); expect(first.sms_effective_since).toBeNull();
      expect(new Date(first.email_effective_since).getFullYear()).toBeGreaterThan(2000);
      const same = (await db.query<{email_effective_since: string; sms_effective_since: string}>("update reminder_settings set sms_enabled=true,email_effective_since='2001-01-01' returning email_effective_since,sms_effective_since")).rows[0];
      expect(same.email_effective_since).toEqual(first.email_effective_since); expect(same.sms_effective_since).toBeTruthy();
      const emailOff = (await db.query<{email_effective_since: string | null; sms_effective_since: string}>('update reminder_settings set email_enabled=false returning email_effective_since,sms_effective_since')).rows[0];
      expect(emailOff.email_effective_since).toBeNull(); expect(emailOff.sms_effective_since).toEqual(same.sms_effective_since);
      const emailOn = (await db.query<{email_effective_since: string; sms_effective_since: string}>('update reminder_settings set email_enabled=true returning email_effective_since,sms_effective_since')).rows[0];
      expect(new Date(emailOn.email_effective_since).getTime()).toBeGreaterThanOrEqual(new Date(first.email_effective_since).getTime());
      expect(emailOn.sms_effective_since).toEqual(same.sms_effective_since);
      const off = (await db.query('update reminder_settings set master_enabled=false returning email_effective_since,sms_effective_since')).rows[0];
      expect(off).toEqual({email_effective_since:null,sms_effective_since:null});
      const again = (await db.query<{email_effective_since: string; sms_effective_since: string}>('update reminder_settings set master_enabled=true returning email_effective_since,sms_effective_since')).rows[0];
      expect(new Date(again.email_effective_since).getTime()).toBeGreaterThanOrEqual(new Date(first.email_effective_since).getTime());
      expect(new Date(again.sms_effective_since).getTime()).toBeGreaterThanOrEqual(new Date(same.sms_effective_since).getTime());
      await db.exec("set test.role='supervisor'");
      expect((await db.query("update reminder_settings set email_effective_since='2000-01-01' returning *")).rows).toHaveLength(0);
    } finally { await db.close(); }
  });
});
