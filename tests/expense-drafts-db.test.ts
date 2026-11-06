import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration=readFileSync('supabase/migrations/20261106000000_expense_drafts.sql','utf8');
const a='11111111-1111-4111-8111-111111111111', b='22222222-2222-4222-8222-222222222222';
const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
describe('expense draft database safeguards',()=>{
  it('isolates owners and requires Founder and MFA, bounds payloads, and supports conflict checks',async()=>{
    const db=new PGlite();
    try {
      await db.exec(`create role anon; create role authenticated; create role service_role; create schema auth;
        create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid',true),'')::uuid $$;
        create function public.is_founder() returns boolean language sql stable as $$ select current_setting('test.role',true) = 'founder' $$;
        create function public.session_assurance_satisfied() returns boolean language sql stable as $$ select current_setting('test.aal',true) = 'aal2' $$;
        create table public.users(id uuid primary key); insert into public.users values ('${a}'),('${b}');
        grant usage on schema auth to authenticated;`);
      await db.exec(migration);
      await db.exec(`set role authenticated; set test.uid = '${a}'; set test.role='founder'; set test.aal='aal2';`);
      await db.query('insert into expense_drafts(owner_id,draft_id,payload) values($1,$2,$3::jsonb)',[a,id,'{"version":1}']);
      await expect(db.query('insert into expense_drafts(owner_id,draft_id,payload) values($1,$2,$3::jsonb)',[a,'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','{}'])).rejects.toThrow();
      await expect(db.query('insert into expense_drafts(owner_id,draft_id,payload) values($1,$2,$3::jsonb)',[b,'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','{}'])).rejects.toThrow();
      await expect(db.query('update expense_drafts set payload=$1::jsonb where owner_id=$2',[JSON.stringify({x:'a'.repeat(100001)}),a])).rejects.toThrow();
      const first=await db.query('update expense_drafts set revision=2 where owner_id=$1 and draft_id=$2 and revision=1 returning revision',[a,id]);
      expect(first.rows).toHaveLength(1);
      expect((await db.query('update expense_drafts set revision=2 where owner_id=$1 and draft_id=$2 and revision=1 returning revision',[a,id])).rows).toHaveLength(0);
      await db.exec(`set test.uid='${b}'`); expect((await db.query('select * from expense_drafts')).rows).toHaveLength(0);
      await db.exec(`set test.uid='${a}'; set test.role='supervisor'`); expect((await db.query('select * from expense_drafts')).rows).toHaveLength(0);
      await db.exec(`set test.role='founder'; set test.aal='aal1'`); expect((await db.query('select * from expense_drafts')).rows).toHaveLength(0);
      expect((await db.query('update expense_drafts set payload=$1::jsonb where owner_id=$2 returning owner_id',['{}',a])).rows).toHaveLength(0);
      await db.exec('reset role'); expect((await db.query('select revision from expense_drafts')).rows[0]).toMatchObject({revision:2});
    } finally {await db.close();}
  });
});
