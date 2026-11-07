import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync('supabase/staged/20261107000006_reminder_invoice_epochs.sql','utf8');
const old = '00000000-0000-4000-8000-000000000001';
const fresh = '00000000-0000-4000-8000-000000000002';
type Epochs = { reminder_invoice_effective_since: string | null; reminder_schedule_effective_since: string };
describe('staged invoice reminder epochs',()=>{
  it('seeds conservatively and prevents callers backdating eligibility or schedule',async()=>{
    const db=new PGlite();
    try {
      await db.exec(`create role anon; create role authenticated; create role service_role;
        create table public.invoices(id uuid primary key, due_date date not null, status text not null, amount numeric not null, amount_paid numeric not null, automatic_reminders_enabled boolean not null, reminders_paused_until timestamptz);
        insert into invoices values ('${old}','2026-01-01','pending',100,0,true,null);`);
      await db.exec(migration);
      const row=async(id:string)=>(await db.query<Epochs>('select reminder_invoice_effective_since,reminder_schedule_effective_since from invoices where id=$1',[id])).rows[0];
      const seeded=await row(old); expect(new Date(seeded.reminder_invoice_effective_since!).getUTCFullYear()).toBeGreaterThan(2020);
      expect(new Date(seeded.reminder_schedule_effective_since).getUTCFullYear()).toBeGreaterThan(2020);
      await db.exec(`insert into invoices values ('${fresh}','2026-12-01','pending',100,0,true,null,'2000-01-01','2000-01-01');`);
      const first=await row(fresh);expect(new Date(first.reminder_invoice_effective_since!).getUTCFullYear()).toBeGreaterThan(2000);
      await db.exec(`update invoices set reminder_invoice_effective_since='2000-01-01',reminder_schedule_effective_since='2000-01-01',status='overdue' where id='${fresh}'`);
      expect(await row(fresh)).toEqual(first);
      await db.exec(`update invoices set automatic_reminders_enabled=false where id='${fresh}'`);
      expect((await row(fresh)).reminder_invoice_effective_since).toBeNull();
      await db.exec(`update invoices set automatic_reminders_enabled=true where id='${fresh}'`);
      const again=await row(fresh);expect(again.reminder_invoice_effective_since).toBeTruthy();expect(again.reminder_schedule_effective_since).toEqual(first.reminder_schedule_effective_since);
      await db.exec(`update invoices set status='paid',amount_paid=100 where id='${fresh}'`);
      expect((await row(fresh)).reminder_invoice_effective_since).toBeNull();
      await db.exec(`update invoices set status='partially_paid',amount_paid=50,due_date='2027-01-01' where id='${fresh}'`);
      const changed=await row(fresh); expect(changed.reminder_invoice_effective_since).toBeTruthy(); expect(new Date(changed.reminder_schedule_effective_since).getTime()).toBeGreaterThanOrEqual(new Date(first.reminder_schedule_effective_since).getTime());
      await db.exec(`update invoices set reminders_paused_until='2099-01-01' where id='${fresh}'`);
      const paused=await row(fresh); await db.exec(`update invoices set reminders_paused_until=null where id='${fresh}'`);
      expect(new Date((await row(fresh)).reminder_invoice_effective_since!).getTime()).toBeGreaterThanOrEqual(new Date(paused.reminder_invoice_effective_since!).getTime());
    } finally {await db.close();}
  });
});
