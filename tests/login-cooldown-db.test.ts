import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync('supabase/migrations/20261104000002_login_cooldown.sql', 'utf8');
const key = 'a'.repeat(64);
const tokens = Array.from({length: 8}, (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`);

describe('shared login cooldown migration', () => {
  it('limits five failures, keeps success and errors distinct, and restricts access', async () => {
    const db = new PGlite();
    try {
      await db.exec('create role anon; create role authenticated; create role service_role;');
      await db.exec(sql);
      const reserve = async (token: string) => (await db.query<{result: {allowed:boolean; retry_after:number}}>('select public.reserve_login_attempt($1,$2::uuid) as result', [key,token])).rows[0].result;
      const finish = async (token: string, outcome: string) => (await db.query<{result: {confirmed:boolean; retry_after:number}}>('select public.finish_login_attempt($1,$2::uuid,$3) as result', [key,token,outcome])).rows[0].result;
      for (let i=0;i<5;i++) {
        expect((await reserve(tokens[i])).allowed).toBe(true);
        const done = await finish(tokens[i], 'failure');
        expect(done.confirmed).toBe(true);
        expect(done.retry_after > 0).toBe(i===4);
      }
      const blocked = await reserve(tokens[5]);
      expect(blocked.allowed).toBe(false);
      expect(blocked.retry_after).toBeGreaterThan(290);
      await db.query("update public.login_cooldown_buckets set locked_until=clock_timestamp()-interval '1 second' where bucket_key=$1", [key]);
      expect((await reserve(tokens[5])).allowed).toBe(true);
      expect((await finish(tokens[5], 'unknown')).retry_after).toBe(0);
      expect((await reserve(tokens[6])).allowed).toBe(true);
      expect((await finish(tokens[6], 'success')).confirmed).toBe(true);
      expect((await finish(tokens[6], 'failure')).confirmed).toBe(false);
      await db.exec('set role authenticated');
      await expect(db.query('select * from public.login_cooldown_buckets')).rejects.toThrow(/permission denied/);
      await expect(db.query('select public.reserve_login_attempt($1,$2::uuid)', [key,tokens[7]])).rejects.toThrow(/permission denied/);
    } finally { await db.close(); }
  }, 30000);
  it('reserves capacity for concurrent attempts and does not treat an outage as a failed password', async () => {
    const db = new PGlite();
    try {
      await db.exec('create role anon; create role authenticated; create role service_role;');
      await db.exec(sql);
      for (let i=0;i<5;i++) {
        const {rows} = await db.query<{result:{allowed:boolean}}>('select public.reserve_login_attempt($1,$2::uuid) as result',[key,tokens[i]]);
        expect(rows[0].result.allowed).toBe(true);
      }
      const blocked = await db.query<{result:{allowed:boolean;retry_after:number}}>('select public.reserve_login_attempt($1,$2::uuid) as result',[key,tokens[5]]);
      expect(blocked.rows[0].result).toEqual({allowed:false,retry_after:2});
      await db.query("select public.finish_login_attempt($1,$2::uuid,'unknown')",[key,tokens[0]]);
      const next = await db.query<{result:{allowed:boolean}}>('select public.reserve_login_attempt($1,$2::uuid) as result',[key,tokens[5]]);
      expect(next.rows[0].result.allowed).toBe(true);
    } finally { await db.close(); }
  }, 30000);
});
