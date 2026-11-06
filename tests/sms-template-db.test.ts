import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const migration=readFileSync('supabase/migrations/20261106000001_sms_template.sql','utf8');
describe('global SMS template database protections',()=>{
  it('limits access to Founder with assurance and prevents duplicate singleton, invalid lengths and lost revisions',async()=>{
    const db=new PGlite();
    try {
      await db.exec(`create role anon; create role authenticated; create role service_role; create table public.users(id uuid primary key);
        alter default privileges in schema public grant all on tables to authenticated, anon;
        create function public.is_founder() returns boolean language sql stable as $$ select current_setting('test.role',true)='founder' $$;
        create function public.session_assurance_satisfied() returns boolean language sql stable as $$ select current_setting('test.aal',true)='aal2' $$;`);
      await db.exec(migration); await db.exec("set role authenticated; set test.role='founder'; set test.aal='aal2'");
      await db.exec("insert into sms_template_settings(message_template) values('Safe wording')");
      await expect(db.exec("insert into sms_template_settings(message_template) values('Another')")).rejects.toThrow();
      await expect(db.query('update sms_template_settings set message_template=$1',['x'.repeat(1001)])).rejects.toThrow();
      expect((await db.query("update sms_template_settings set revision=2 where revision=1 returning revision")).rows).toHaveLength(1);
      expect((await db.query("update sms_template_settings set revision=2 where revision=1 returning revision")).rows).toHaveLength(0);
      await expect(db.exec('delete from sms_template_settings')).rejects.toThrow();
      await db.exec("set test.role='supervisor'");expect((await db.query('select * from sms_template_settings')).rows).toHaveLength(0);
      await db.exec("set test.role='founder'; set test.aal='aal1'");expect((await db.query('select * from sms_template_settings')).rows).toHaveLength(0);
      expect((await db.query("update sms_template_settings set message_template='bad' returning *")).rows).toHaveLength(0);
      await db.exec('set role anon');await expect(db.query('select * from sms_template_settings')).rejects.toThrow();
    } finally {await db.close();}
  });
});
