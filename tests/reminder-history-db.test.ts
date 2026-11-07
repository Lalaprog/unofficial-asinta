import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
const coordination=readFileSync('supabase/staged/20261107000005_reminder_delivery_coordination.sql','utf8');
const correlation=readFileSync('supabase/staged/reminder_log_correlation.sql','utf8');
const reviews=readFileSync('supabase/staged/20261107000009_staged_reminder_review.sql','utf8');
const history=readFileSync('supabase/staged/20261107000010_staged_reminder_history.sql','utf8');
const invoice='00000000-0000-4000-8000-000000000001', attempt='00000000-0000-4000-8000-000000000002';
describe('staged per-channel reminder history',()=>{
  it('aggregates all rows and treats legacy ambiguity as blocking without cross-channel interference',async()=>{
    const db=new PGlite();try {
      await db.exec(`create role anon;create role authenticated;create role service_role;
        create schema app_private; create function app_private.lock_founder_guard() returns void language sql as $$ select $$;
        create table public.users(id uuid primary key,role text);insert into users values ('00000000-0000-4000-8000-000000000003','founder');
        create table public.invoices(id uuid primary key);insert into invoices values ('${invoice}');
        create table public.email_logs(id uuid primary key default gen_random_uuid(),invoice_id uuid,status text,sent_at timestamptz);
        create table public.sms_logs(id uuid primary key default gen_random_uuid(),invoice_id uuid,status text,sent_at timestamptz,updated_at timestamptz,simulated boolean);
        create table public.reminder_dispatches(id uuid primary key default gen_random_uuid(),invoice_id uuid,channel text,status text,sent_at timestamptz);`);
      await db.exec(coordination);await db.exec(correlation);await db.exec(reviews);await db.exec(history);
      const read=async(channel:string,own:string|null=null)=>(await db.query<{r:{lastContactAt:string|null;unresolvedAttempt:boolean}}>('select public.read_reminder_contact_history($1,$2,$3) r',[invoice,channel,own])).rows[0].r;
      await db.exec('set role authenticated');await expect(read('email')).rejects.toThrow(/permission denied/i);await db.exec('reset role');
      expect(await read('email')).toEqual({lastContactAt:null,unresolvedAttempt:false});
      await db.exec(`insert into email_logs(invoice_id,status,sent_at) values ('${invoice}','accepted','2026-10-01T00:00Z');
        insert into sms_logs(invoice_id,status,sent_at,updated_at,simulated) values ('${invoice}','failed','2026-10-02T00:00Z',null,true);
        insert into reminder_dispatches(invoice_id,channel,status,sent_at) values ('${invoice}','email','skipped',null);`);
      expect((await read('email')).unresolvedAttempt).toBe(false);expect((await read('email')).lastContactAt).toContain('2026-10-01');
      expect(await read('sms')).toEqual({lastContactAt:null,unresolvedAttempt:false});
      await db.exec(`insert into sms_logs(invoice_id,status,sent_at,updated_at,simulated) values ('${invoice}','failed','2026-10-03T00:00Z',null,false);`);
      expect((await read('sms')).unresolvedAttempt).toBe(true);expect((await read('email')).unresolvedAttempt).toBe(false);
      await db.query("select public.reserve_reminder_delivery($1,'email','automatic',$2)",[invoice,attempt]);
      expect((await read('email')).unresolvedAttempt).toBe(true);expect((await read('email',attempt)).unresolvedAttempt).toBe(false);
      await db.query("insert into email_logs(invoice_id,status,sent_at,reminder_attempt_id) values ($1,'pending',null,$2)",[invoice,attempt]);
      expect((await read('email',attempt)).unresolvedAttempt).toBe(false);expect((await read('email')).unresolvedAttempt).toBe(true);
      await db.query("select public.finish_reminder_delivery($1,'email',$2,'unconfirmed')",[invoice,attempt]);
      expect((await read('email')).unresolvedAttempt).toBe(true);
      expect((await read('email',attempt)).unresolvedAttempt).toBe(true); // A prior unconfirmed attempt is never excluded.
      expect((await db.query<{r:boolean}>("select public.review_reminder_delivery($1,$2,'email',$3,'accepted','Provider confirmed acceptance.',true) r",['00000000-0000-4000-8000-000000000003',invoice,attempt])).rows[0].r).toBe(true);
      expect((await read('email')).unresolvedAttempt).toBe(false); // The reviewed linked pending log no longer blocks.
      await db.exec(`insert into email_logs(invoice_id,status,sent_at) values ('${invoice}','accepted',null)`);
      expect((await read('email',attempt)).unresolvedAttempt).toBe(true);
    } finally {await db.close();}
  });
});
