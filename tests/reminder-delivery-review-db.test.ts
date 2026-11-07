import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import {describe,expect,it} from 'vitest';
const coordination=readFileSync('supabase/migrations/20261107000005_reminder_delivery_coordination.sql','utf8');
const review=readFileSync('supabase/staged/20261107000009_staged_reminder_review.sql','utf8');
const invoice='00000000-0000-4000-8000-000000000001',founder='00000000-0000-4000-8000-000000000002',supervisor='00000000-0000-4000-8000-000000000003',attempt='00000000-0000-4000-8000-000000000004',next='00000000-0000-4000-8000-000000000005';
describe('staged manual delivery review',()=>{
  it('requires explicit evidence, confirmation and Founder role; writes review and unlocks together',async()=>{
    const db=new PGlite();try {
      await db.exec(`create role anon;create role authenticated;create role service_role;create schema app_private;
        create function app_private.lock_founder_guard() returns void language sql as $$ select $$;
        create table public.users(id uuid primary key, role text);insert into users values ('${founder}','founder'),('${supervisor}','supervisor');
        create table public.invoices(id uuid primary key);insert into invoices values ('${invoice}');`);
      await db.exec(coordination);await db.exec(review);
      const reserve=async(id:string)=>(await db.query<{r:string}>("select public.reserve_reminder_delivery($1,'email','manual',$2) r",[invoice,id])).rows[0].r;
      const resolve=async(actor:string,decision:string,note:string,confirmation:boolean)=>(await db.query<{r:boolean}>("select public.review_reminder_delivery($1,$2,'email',$3,$4,$5,$6) r",[actor,invoice,attempt,decision,note,confirmation])).rows[0].r;
      await db.exec('set role authenticated');await expect(resolve(founder,'accepted','Provider confirmed message accepted.',true)).rejects.toThrow(/permission denied/i);
      await db.exec('reset role;set role service_role');expect(await reserve(attempt)).toBe('reserved');
      expect(await resolve(supervisor,'accepted','Provider confirmed message accepted.',true)).toBe(false);
      expect(await resolve(founder,'accepted','short',true)).toBe(false);
      expect(await resolve(founder,'accepted','Provider confirmed message accepted.',false)).toBe(false);
      expect(await reserve(next)).toBe('busy');
      expect(await resolve(founder,'accepted','Provider confirmed message accepted.',true)).toBe(true);
      expect(await resolve(founder,'accepted','Provider confirmed message accepted.',true)).toBe(false);
      expect(await reserve(next)).toBe('reserved');
      await db.exec('reset role');
      expect((await db.query('select previous_state,outcome,evidence from public.reminder_delivery_reviews')).rows).toEqual([{previous_state:'reserved',outcome:'accepted',evidence:'Provider confirmed message accepted.'}]);
    } finally {await db.close();}
  });
});
