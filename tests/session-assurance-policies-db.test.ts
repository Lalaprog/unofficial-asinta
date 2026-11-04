import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// These are deliberately synthetic tables and identities. The policy file is
// the exact draft migration, but this does not prove hosted Supabase behavior.
const assurance = readFileSync('supabase/migrations/20261105000000_session_assurance_prerequisite.sql','utf8');
const migration = readFileSync('supabase/migrations/20261105000001_mfa_table_storage_policies.sql','utf8');
const tables = ['advance_requests','advances','attendance','audit_log','clients','email_logs','email_templates','expenses','invoices','payroll','project_supervisors','projects','reminder_dispatches','sms_logs','tools','user_notifications','vendor_memory','workers'];
const founder = '00000000-0000-0000-0000-000000000001';
const supervisor = '00000000-0000-0000-0000-000000000002';
const other = '00000000-0000-0000-0000-000000000003';

async function createFixture() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create schema storage;
    grant usage on schema public, auth, storage to authenticated, anon, service_role;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
    create table auth.mfa_factors(user_id uuid, status text);
    insert into auth.mfa_factors values ('${founder}','verified'),('${supervisor}','verified');
    create table public.users(id uuid primary key, name text);
    insert into public.users values ('${founder}','Founder'),('${supervisor}','Supervisor'),('${other}','Other');
    alter table public.users enable row level security;
    grant select, insert, update, delete on public.users to authenticated;
    create policy old_role_rules on public.users for all to authenticated using (true) with check (true);
    ${tables.map(name => `create table public.${name}(id int primary key, value text);
      insert into public.${name} values (1,'original');
      alter table public.${name} enable row level security;
      grant select, insert, update, delete on public.${name} to authenticated;
      create policy old_role_rules on public.${name} for all to authenticated using (true) with check (true);`).join('\n')}
    -- The real audit log grants SELECT and INSERT, never UPDATE or DELETE.
    drop policy old_role_rules on public.audit_log;
    create policy audit_select on public.audit_log for select to authenticated using (true);
    create policy audit_insert on public.audit_log for insert to authenticated with check (true);
    create table storage.objects(id int primary key, value text);
    insert into storage.objects values (1,'receipt');
    alter table storage.objects enable row level security;
    grant select, insert, update, delete on storage.objects to authenticated;
    create policy old_storage_rules on storage.objects for all to authenticated using (true) with check (true);
  `);
  await db.exec(assurance);
  return db;
}
async function identity(db:PGlite, id:string, aal:string) {
  await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",[id,JSON.stringify({aal})]);
}

describe('draft table and storage assurance policies', () => {
  it('fails before policy installation if a prerequisite or RLS table is missing', async () => {
    const db = await createFixture();
    try {
      await db.exec('alter table public.expenses disable row level security');
      await expect(db.exec(migration)).rejects.toThrow(/Expected RLS-enabled public table missing: expenses/);
      expect((await db.query<{count:number}>("select count(*)::int as count from pg_policies where policyname='mfa_session_required'")).rows[0].count).toBe(0);
    } finally { await db.close(); }
  }, 30000);

  it('refuses to install without the additive assurance prerequisite', async () => {
    const db = await createFixture();
    try {
      await db.exec('drop function public.session_assurance_satisfied()');
      await expect(db.exec(migration)).rejects.toThrow(/Missing session assurance prerequisite/);
    } finally { await db.close(); }
  }, 30000);

  it('refuses an unexpected exposed relation, including column-only grants', async () => {
    const db = await createFixture();
    try {
      await db.exec('create table public.new_sensitive_data(id int); grant select(id) on public.new_sensitive_data to authenticated');
      await expect(db.exec(migration)).rejects.toThrow(/Unexpected authenticated-accessible public relation/);
    } finally { await db.close(); }
  }, 30000);

  it('blocks aal1 enrolled users on every listed table and storage while preserving bootstrap and authorized sessions', async () => {
    const db = await createFixture();
    try {
      await db.exec(migration);
      await db.exec(migration); // repeat-safe
      await db.exec('set role authenticated');
      for (const who of [founder,supervisor]) {
        await identity(db,who,'aal1');
        for (const table of [...tables.map(t => `public.${t}`), 'storage.objects']) {
          expect((await db.query(`select * from ${table}`)).rows, table).toHaveLength(0);
          expect((await db.query(`update ${table} set value='changed' where id=1 returning id`)).rows, table).toHaveLength(0);
          expect((await db.query(`delete from ${table} where id=1 returning id`)).rows, table).toHaveLength(0);
          await expect(db.query(`insert into ${table} values (2,'not allowed')`),table).rejects.toThrow(/row-level security/);
        }
        expect((await db.query<{id:string}>('select id from public.users order by id')).rows.map(x => x.id)).toEqual([who]);
        expect((await db.query(`update public.users set name='Changed' where id='${who}' returning id`)).rows).toHaveLength(0);
        expect((await db.query(`delete from public.users where id='${who}' returning id`)).rows).toHaveLength(0);
        await expect(db.query(`insert into public.users values ('00000000-0000-0000-0000-000000000004','Not allowed')`)).rejects.toThrow(/row-level security/);
        await identity(db,who,'aal2');
        for (const table of [...tables.map(t => `public.${t}`), 'storage.objects']) {
          expect((await db.query(`select * from ${table}`)).rows, table).toHaveLength(1);
        }
        expect((await db.query('select * from public.users')).rows).toHaveLength(3);
        expect((await db.query("update public.audit_log set value='changed' returning id")).rows).toHaveLength(0);
        expect((await db.query('delete from public.audit_log returning id')).rows).toHaveLength(0);
      }
      // No verified factor is enrolled for this synthetic account.
      await identity(db,other,'aal1');
      for (const table of [...tables.map(t => `public.${t}`), 'storage.objects']) {
        expect((await db.query(`select * from ${table}`)).rows, table).toHaveLength(1);
      }
      expect((await db.query("insert into public.expenses values (2,'allowed') returning id")).rows).toHaveLength(1);
      expect((await db.query("update public.expenses set value='allowed' where id=2 returning id")).rows).toHaveLength(1);
      expect((await db.query('delete from public.expenses where id=2 returning id')).rows).toHaveLength(1);
      await identity(db,other,'invalid');
      expect((await db.query('select * from public.users')).rows).toHaveLength(0);
      expect((await db.query('select * from public.expenses')).rows).toHaveLength(0);
      // RLS is not the protection for privileged service-role code.
      await db.exec('reset role; grant select on public.expenses to service_role; set role service_role');
      expect((await db.query('select * from public.expenses')).rows).toHaveLength(1);
    } finally { await db.close(); }
  }, 30000);
});
