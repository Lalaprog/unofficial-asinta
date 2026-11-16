import { PGlite } from '@electric-sql/pglite';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

describe('historical SQL bundle generator', () => {
  it('fails closed and does not overwrite existing bundles even with arguments or environment overrides', () => {
    const dir = mkdtempSync(join(tmpdir(), 'asinta-bundle-guard-'));
    try {
      mkdirSync(join(dir, 'scripts'));
      mkdirSync(join(dir, 'supabase', 'apply'), { recursive: true });
      const script = join(dir, 'scripts', 'build-apply-sql.mjs');
      copyFileSync(join(process.cwd(), 'scripts', 'build-apply-sql.mjs'), script);
      const fresh = join(dir, 'supabase', 'apply', 'fresh-install.sql');
      const upgrade = join(dir, 'supabase', 'apply', 'upgrade-hardening.sql');
      writeFileSync(fresh, 'fresh sentinel');
      writeFileSync(upgrade, 'upgrade sentinel');
      const result = spawnSync(process.execPath, [script, '--force', '--yes'], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, FORCE: '1', CI: 'true' },
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/generation is disabled/i);
      expect(readFileSync(fresh, 'utf8')).toBe('fresh sentinel');
      expect(readFileSync(upgrade, 'utf8')).toBe('upgrade sentinel');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('checked-in historical SQL bundles', () => {
  for (const name of ['fresh-install.sql', 'upgrade-hardening.sql']) {
    it(`${name} aborts its transaction before applying a migration`, async () => {
      const sql = readFileSync(join(process.cwd(), 'supabase', 'apply', name), 'utf8');
      const guard = "DO $$ BEGIN RAISE EXCEPTION 'Historical SQL bundle disabled: see supabase/apply/README.md'; END; $$;";
      expect(sql.indexOf('begin;')).toBeGreaterThanOrEqual(0);
      expect(sql.indexOf(guard)).toBeGreaterThan(sql.indexOf('begin;'));
      expect(sql.indexOf(guard)).toBeLessThan(sql.indexOf('-- @@ source:'));
      const preGuard = sql.slice(sql.indexOf('begin;') + 'begin;'.length, sql.indexOf(guard));
      expect(preGuard.replace(/--[^\n]*/g, '').trim()).toBe('');
      const db = new PGlite();
      try {
        // Exercise the exact guard and show that subsequent SQL cannot commit.
        await db.exec('BEGIN;');
        await expect(db.exec(guard)).rejects.toThrow(/Historical SQL bundle disabled/);
        await expect(db.exec('CREATE TABLE public.unexpected_write(id int);')).rejects.toThrow();
        await db.exec('ROLLBACK;');
        const result = await db.query<{found: string | null}>("SELECT to_regclass('public.unexpected_write')::text AS found");
        expect(result.rows[0].found).toBeNull();
        // The complete checked-in script must also stop at the guard.
        await expect(db.exec(sql)).rejects.toThrow(/Historical SQL bundle disabled/);
        await db.exec('ROLLBACK;');
        const tables = await db.query<{n: number}>("SELECT count(*) AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'");
        expect(tables.rows[0].n).toBe(0);
      } finally {
        await db.close();
      }
    }, 30000);
  }
});
