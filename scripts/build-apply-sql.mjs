#!/usr/bin/env node
/**
 * Builds the paste-into-the-SQL-editor bundles from `supabase/migrations`.
 *
 * WHY THIS EXISTS
 * ---------------
 * Applying migrations to a hosted Supabase project normally means
 * `supabase db push` with the database password. That is not always available
 * (or wanted) — a founder with dashboard access can instead paste one file into
 * the SQL editor and run it. Doing that by hand from multiple migration files is
 * where copy-paste mistakes come from and where "which order?" gets lost.
 *
 * The bundles are GENERATED, never hand-edited: the header records the source
 * files and their SHA-256, so a bundle that has drifted from the migrations is
 * detectable. Regenerate with `npm run build:apply-sql` after touching any
 * migration.
 *
 * The demo seed is never included in either bundle. It creates real auth
 * accounts with the published password `asinta2026` (see docs/SECURITY.md §9).
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = join(root, 'supabase', 'migrations');
const outDir = join(root, 'supabase', 'apply');

const SEED = '20260913000002_bale_seed.sql';

const BUNDLES = [
  {
    file: 'fresh-install.sql',
    title: 'BALE — full install (empty project)',
    description:
      'Every schema migration, in order, EXCLUDING the demo seed.\n' +
      'Use this on a project with no BALE tables yet. It is NOT idempotent:\n' +
      'policies in the base schema use plain CREATE POLICY, so a second run\n' +
      'will fail. Check with verify-live.sql before running.',
    include: (name) => name.endsWith('.sql') && name !== SEED,
  },
  {
    file: 'upgrade-hardening.sql',
    title: 'BALE — security, AI & advance-workflow updates (already-migrated project)',
    description:
      'The 2026-10-06 security/AI hardening plus the 2026-10-13 Bale request\n' +
      'workflow and follow-up: private receipts + audit log, vendor memory,\n' +
      'Founder-reviewed advances, durable per-user notifications, and atomic\n' +
      'same-site batch approval, transactional payroll, and Founder protection. Requires the\n' +
      'base BALE schema and communications\n' +
      'migration to already be present.',
    include: (name) =>
      name === '20261006000000_security_hardening.sql' ||
      name === '20261006000001_ai_draft_support.sql' ||
      name === '20261013000000_advance_requests.sql' ||
      name === '20261013000001_advance_request_notifications.sql' ||
      name === '20261102000000_atomic_payroll_payments.sql' ||
      name === '20261102000001_founder_guard.sql' ||
      name === '20261103000000_pending_attendance_queue.sql' ||
      name === '20261103000001_attendance_history.sql',
  },
];

const available = readdirSync(migrationsDir)
  .filter((name) => name.endsWith('.sql'))
  .sort();

mkdirSync(outDir, { recursive: true });

for (const bundle of BUNDLES) {
  const names = available.filter(bundle.include);

  if (names.length === 0) {
    console.error(`✖ ${bundle.file}: no migrations matched — check the include rules`);
    process.exitCode = 1;
    continue;
  }

  const sections = names.map((name) => {
    const sql = readFileSync(join(migrationsDir, name), 'utf8').trimEnd();
    const digest = createHash('sha256').update(sql).digest('hex');
    return { name, sql, digest };
  });

  const header = [
    '-- ===========================================================================',
    `-- ${bundle.title}`,
    '-- ===========================================================================',
    '--',
    ...bundle.description.split('\n').map((line) => `-- ${line}`.trimEnd()),
    '--',
    '-- GENERATED FILE — do not edit. Regenerate with `npm run build:apply-sql`.',
    `-- Generated: ${new Date().toISOString()}`,
    '--',
    '-- Source files (in execution order) and their SHA-256:',
    ...sections.map((s) => `--   ${s.name}  ${s.digest.slice(0, 16)}…`),
    '--',
    '-- After running: execute supabase/apply/verify-live.sql and confirm every',
    '-- row reports PASS. Procedure: docs/MIGRATION_RUNBOOK.md.',
    '--',
    '-- Wrapped in a single transaction: any failure rolls the whole thing back',
    '-- rather than leaving the project half-migrated.',
    '-- ===========================================================================',
    '',
    'begin;',
    '',
  ].join('\n');

  const body = sections
    .map((s) => `\n-- @@ source: ${s.name}\n\n${s.sql}\n`)
    .join('\n');

  const footer = ['', 'commit;', ''].join('\n');

  const out = join(outDir, bundle.file);
  writeFileSync(out, header + body + footer, 'utf8');
  console.log(`✔ ${bundle.file}  (${names.length} migrations)`);
  for (const name of names) console.log(`    · ${name}`);
}

if (process.exitCode !== 1) {
  console.log('\nWritten to supabase/apply/. Run verify-live.sql afterwards.');
}
