import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { baseFixture } from './helpers/pr103-fixture';

const sql = readFileSync('supabase/drafts/supervisor_rpc_rollout.sql', 'utf8');
const tables = readFileSync('supabase/drafts/supervisor_table_foundation.sql', 'utf8');
const source = (name: string) => readFileSync(`supabase/migrations/${name}`, 'utf8');

describe('Supervisor functions rollout candidate', () => {
  it('contains the unchanged function portions of both reviewed migrations', () => {
    for (const [file, table] of [['20261113000005_supervisor_leave.sql', 'supervisor_leave_requests'], ['20261113000006_supervisor_daily_attendance.sql', 'supervisor_daily_attendance']]) {
      const marker = `REVOKE ALL ON public.${table} FROM PUBLIC,anon,authenticated;`;
      expect(sql).toContain(source(file).split(marker)[1].trim());
    }
  });

  it('installs functions and guard together without changing existing records; repeats fail closed', async () => {
    const db = new PGlite();
    try {
      await db.exec(baseFixture);
      await db.exec(`BEGIN; ${tables} COMMIT;`);
      const before = (await db.query('SELECT (SELECT count(*)::int FROM public.users) users, (SELECT count(*)::int FROM public.payroll) payroll, (SELECT count(*)::int FROM public.attendance) attendance')).rows[0];
      await db.exec(`BEGIN; ${sql} COMMIT;`);
      expect((await db.query('SELECT (SELECT count(*)::int FROM public.users) users, (SELECT count(*)::int FROM public.payroll) payroll, (SELECT count(*)::int FROM public.attendance) attendance')).rows[0]).toEqual(before);
      const guard = await db.query<{enabled:string}>("SELECT tgenabled AS enabled FROM pg_trigger WHERE tgrelid='public.supervisor_leave_requests'::regclass AND tgname='guard_leave_against_approved_supervisor_day'");
      expect(guard.rows[0].enabled).toBe('O');
      await expect(db.exec(`BEGIN; ${sql} COMMIT;`)).rejects.toThrow(/Supervisor function already exists/);
      await db.exec('ROLLBACK');
    } finally { await db.close(); }
  }, 30000);

  it('fails before installing anything when either table has drifted', async () => {
    const db = new PGlite();
    try {
      await db.exec(baseFixture);
      await db.exec(`BEGIN; ${tables} COMMIT;`);
      await db.exec('ALTER TABLE public.supervisor_daily_attendance ADD COLUMN unexpected text');
      await expect(db.exec(`BEGIN; ${sql} COMMIT;`)).rejects.toThrow(/Locked Supervisor table missing or different/);
      await db.exec('ROLLBACK');
      expect((await db.query<{missing:boolean}>("SELECT to_regprocedure('public.submit_supervisor_leave(uuid,date,date,text,text)') IS NULL missing")).rows[0].missing).toBe(true);
    } finally { await db.close(); }
  }, 30000);
});
