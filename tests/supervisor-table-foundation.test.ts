import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { baseFixture } from './helpers/pr103-fixture';

const draft = readFileSync('supabase/drafts/supervisor_table_foundation.sql', 'utf8');
const leave = readFileSync('supabase/migrations/20261113000005_supervisor_leave.sql', 'utf8');
const day = readFileSync('supabase/migrations/20261113000006_supervisor_daily_attendance.sql', 'utf8');
const normalize = (s: string) => s.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();
const tableSection = (s: string, table: string) => {
  const start = s.indexOf(`CREATE TABLE public.${table}`);
  const end = s.indexOf(`REVOKE ALL ON public.${table} FROM PUBLIC,anon,authenticated;`, start);
  if (start < 0 || end < 0) throw new Error(`Missing source section ${table}`);
  return normalize(s.slice(start, end + `REVOKE ALL ON public.${table} FROM PUBLIC,anon,authenticated;`.length));
};

describe('locked Supervisor table foundation', () => {
  it('matches the corresponding schema portions of the full migrations exactly', () => {
    expect(tableSection(draft, 'supervisor_leave_requests')).toBe(tableSection(leave, 'supervisor_leave_requests'));
    expect(tableSection(draft, 'supervisor_daily_attendance')).toBe(tableSection(day, 'supervisor_daily_attendance'));
  });

  it('creates only empty, client-inaccessible tables while preserving existing records', async () => {
    const db = new PGlite();
    try {
      await db.exec(baseFixture);
      const before = (await db.query('SELECT (SELECT count(*)::int FROM public.users) users, (SELECT count(*)::int FROM public.payroll) payroll, (SELECT count(*)::int FROM public.attendance) attendance')).rows[0];
      await db.exec(`BEGIN; ${draft} COMMIT;`);
      expect((await db.query('SELECT (SELECT count(*)::int FROM public.users) users, (SELECT count(*)::int FROM public.payroll) payroll, (SELECT count(*)::int FROM public.attendance) attendance')).rows[0]).toEqual(before);
      for (const table of ['supervisor_leave_requests', 'supervisor_daily_attendance']) {
        const r = await db.query<{n: number; rls: boolean; anon: boolean; authenticated: boolean}>(`SELECT (SELECT count(*)::int FROM public.${table}) n, (SELECT relrowsecurity FROM pg_class WHERE oid='public.${table}'::regclass) rls, has_table_privilege('anon','public.${table}','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') anon, has_table_privilege('authenticated','public.${table}','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') authenticated`);
        expect(r.rows[0]).toEqual({ n: 0, rls: true, anon: false, authenticated: false });
      }
      expect((await db.query<{missing: boolean}>("SELECT to_regprocedure('public.submit_supervisor_day(uuid,date,text)') IS NULL missing")).rows[0].missing).toBe(true);
      await expect(db.exec(`BEGIN; ${draft} COMMIT;`)).rejects.toThrow(/name collision/);
      await db.exec('ROLLBACK');
    } finally {
      await db.close();
    }
  }, 30000);

  it('rolls back both tables when inherited client privileges defeat the revokes', async () => {
    const db = new PGlite();
    try {
      await db.exec(baseFixture);
      await db.exec('GRANT service_role TO anon');
      await expect(db.exec(`BEGIN; ${draft} COMMIT;`)).rejects.toThrow(/Unexpected inherited client table privileges/);
      await db.exec('ROLLBACK');
      const result = await db.query<{leave_absent: boolean; day_absent: boolean}>("SELECT to_regclass('public.supervisor_leave_requests') IS NULL leave_absent, to_regclass('public.supervisor_daily_attendance') IS NULL day_absent");
      expect(result.rows[0]).toEqual({ leave_absent: true, day_absent: true });
    } finally {
      await db.close();
    }
  }, 30000);
});
