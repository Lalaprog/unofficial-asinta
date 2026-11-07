import {PGlite} from '@electric-sql/pglite';import {readFileSync} from 'node:fs';import {describe,expect,it} from 'vitest';
describe('bounded reminder scan cursor',()=>{
 it('wraps fairly, skips ineligible invoices and is available only to the service role',async()=>{const db=new PGlite();try{
  await db.exec(`create role anon;create role authenticated;create role service_role;create table invoices(id uuid primary key,automatic_reminders_enabled boolean,status text);
    insert into invoices values ('00000000-0000-4000-8000-000000000001',true,'pending'),('00000000-0000-4000-8000-000000000002',false,'pending'),('00000000-0000-4000-8000-000000000003',true,'paid'),('00000000-0000-4000-8000-000000000004',true,'overdue');`);
  await db.exec(readFileSync('supabase/staged/20261107000013_staged_reminder_scan.sql','utf8'));
  const next=async()=>(await db.query<{v:string|null}>('select public.next_reminder_scan_invoice() v')).rows[0].v;
  await db.exec('set role authenticated');await expect(next()).rejects.toThrow(/permission denied/i);await db.exec('reset role;set role service_role');
  expect(await next()).toBe('00000000-0000-4000-8000-000000000001');expect(await next()).toBe('00000000-0000-4000-8000-000000000004');expect(await next()).toBe('00000000-0000-4000-8000-000000000001');
  await db.exec('reset role;update invoices set automatic_reminders_enabled=false');expect(await next()).toBeNull();expect(await next()).toBeNull();
 }finally{await db.close();}});
});
