import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
const coordination=readFileSync('supabase/staged/20261107000005_reminder_delivery_coordination.sql','utf8');
const claims=readFileSync('supabase/staged/20261107000008_staged_reminder_slot_claims.sql','utf8');
const invoice='00000000-0000-4000-8000-000000000001',a='10000000-0000-4000-8000-000000000001',b='10000000-0000-4000-8000-000000000002',c='10000000-0000-4000-8000-000000000003';
describe('staged atomic reminder slot claims',()=>{
  it('claims each channel/date only once, requires current automatic ownership, and never reclaims a lost-response attempt',async()=>{
    const db=new PGlite();try {
      await db.exec(`create role anon;create role authenticated;create role service_role;create table public.invoices(id uuid primary key);insert into invoices values ('${invoice}');`);
      await db.exec(coordination);await db.exec(claims);
      const reserve=async(channel:string,source:string,id:string)=>(await db.query<{r:string}>('select public.reserve_reminder_delivery($1,$2,$3,$4) r',[invoice,channel,source,id])).rows[0].r;
      const claim=async(channel:string,id:string)=>(await db.query<{r:string}>("select public.claim_automatic_reminder_slot($1,$2,$3,'2026-11-02','due_today') r",[invoice,channel,id])).rows[0].r;
      const finish=async(channel:string,id:string,state:string)=>(await db.query<{r:boolean}>('select public.finish_reminder_delivery($1,$2,$3,$4) r',[invoice,channel,id,state])).rows[0].r;
      await db.exec('set role authenticated');await expect(claim('email',a)).rejects.toThrow(/permission denied/i);await db.exec('reset role;set role service_role');
      expect(await reserve('email','manual',a)).toBe('reserved');expect(await claim('email',a)).toBe('not_owner');expect(await finish('email',a,'cancelled')).toBe(true);
      expect(await reserve('email','automatic',b)).toBe('reserved');expect(await claim('email',b)).toBe('claimed');expect(await claim('email',b)).toBe('duplicate');
      expect(await finish('email',b,'accepted')).toBe(true);expect(await reserve('email','automatic',c)).toBe('reserved');expect(await claim('email',c)).toBe('duplicate');expect(await finish('email',c,'cancelled')).toBe(true);
      expect(await reserve('sms','automatic',c)).toBe('duplicate'); // Attempt IDs cannot be reused across channels.
      expect(await reserve('sms','automatic','10000000-0000-4000-8000-000000000004')).toBe('reserved');
      expect(await claim('sms','10000000-0000-4000-8000-000000000004')).toBe('claimed');
    } finally {await db.close();}
  });
});
