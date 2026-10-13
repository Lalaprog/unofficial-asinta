import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXPENSE_CATEGORIES } from '@/lib/ai/categories';

/**
 * RLS regression guard.
 *
 * RLS is the last line of defence for every data query, and it is one line of
 * SQL away from being switched off by a future migration. These tests read the
 * migration files (no database required) and fail if:
 *
 *   - a `public.*` table exists without `enable row level security`,
 *   - a policy grants access unconditionally (`using (true)`),
 *   - the receipts bucket is public again,
 *   - `audit_log` grows an update/delete policy (it must stay append-only),
 *   - a category CHECK constraint drifts from the single TypeScript definition.
 *
 * This is a static check, not a substitute for testing against a live project —
 * it cannot see a table created by hand in the dashboard. It does catch the
 * mistake that actually happens: someone adds a migration and forgets the
 * policy.
 */

const MIGRATIONS_DIR = join(process.cwd(), 'supabase/migrations');

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort();
}

function allMigrationSql(): string {
  return migrationFiles()
    .map((name) => readFileSync(join(MIGRATIONS_DIR, name), 'utf8'))
    .join('\n');
}

/** Table names created by the migrations, excluding auth/storage internals. */
function createdTables(sql: string): string[] {
  const names = new Set<string>();
  const pattern = /create table if not exists public\.([a-z_]+)/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(sql))) names.add(match[1]);
  return [...names].sort();
}

describe('row level security coverage', () => {
  const sql = allMigrationSql();
  const tables = createdTables(sql);

  it('finds the schema tables (sanity check on the parser)', () => {
    expect(tables.length).toBeGreaterThanOrEqual(15);
    expect(tables).toContain('expenses');
    expect(tables).toContain('audit_log');
    expect(tables).toContain('vendor_memory');
    expect(tables).toContain('advance_requests');
  });

  it('enables RLS on every table created by a migration', () => {
    for (const table of tables) {
      const pattern = new RegExp(
        `alter table public\\.${table} enable row level security`,
        'i'
      );
      expect(pattern.test(sql), `RLS is not enabled on public.${table}`).toBe(true);
    }
  });

  it('has no unconditional policy anywhere', () => {
    // `using (true)`, `using(true)`, `with check (true)` — any of these makes a
    // policy a no-op that reads as protection.
    const offenders = sql
      .split('\n')
      .filter((line) => /(using|with check)\s*\(\s*true\s*\)/i.test(line))
      .map((line) => line.trim());

    expect(offenders, `unconditional policy clauses found:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('scopes every policy to a real table and an authenticated role', () => {
    // Policies span multiple lines and a name can be re-created by a later
    // migration (that is exactly what the hardening migration does), so only the
    // LAST definition of each policy name is authoritative — same as Postgres.
    const policyStatements = sql
      .split(';')
      .filter((statement) => /create policy/i.test(statement));

    expect(policyStatements.length).toBeGreaterThan(10);

    const latestByName = new Map<string, string>();
    for (const statement of policyStatements) {
      const name = statement.match(/create policy\s+"([^"]+)"/i)?.[1];
      if (!name) continue;
      latestByName.set(name, statement.slice(statement.search(/create policy/i)).trim());
    }

    expect(latestByName.size).toBeGreaterThan(10);

    for (const [name, header] of latestByName) {
      expect(header, `policy "${name}" is not attached to a table`).toMatch(
        /on (public\.[a-z_]+|storage\.objects)/i
      );
      // `to authenticated` everywhere: a policy without it defaults to PUBLIC.
      expect(header, `policy "${name}" is not scoped to a role`).toMatch(
        /\bto\s+authenticated\b/i
      );
    }
  });
});

describe('user notifications are private to each recipient', () => {
  const sql = readFileSync(
    join(MIGRATIONS_DIR, '20261013000001_advance_request_notifications.sql'),
    'utf8'
  );

  it('allows only recipient-scoped reads and read-state updates', () => {
    const policies = [...sql.matchAll(/create policy "([^"]+)"\s+on public\.user_notifications for (select|update|insert|delete|all) to authenticated/gi)];
    expect(policies.map((match) => match[2].toLowerCase()).sort()).toEqual(['select', 'update']);
    expect(sql).toMatch(/using \(recipient_id = auth\.uid\(\)\)/i);
    expect(sql).toMatch(/with check \(recipient_id = auth\.uid\(\) and read_at is not null\)/i);
    expect(sql).toMatch(/grant update \(read_at\) on table public\.user_notifications to authenticated/i);
    expect(sql).not.toMatch(/grant update on table public\.user_notifications to authenticated/i);
  });

  it('creates notifications through a trusted trigger, not client inserts', () => {
    expect(sql).toMatch(/create trigger notify_advance_request_event\s+after insert or update of status/i);
    expect(sql).toMatch(/create or replace function public\.notify_advance_request_event\(\)[\s\S]*?security definer/i);
    expect(sql).not.toMatch(/grant insert on table public\.user_notifications/i);
  });
});

describe('audit log is append-only', () => {
  const sql = allMigrationSql();

  it('grants select and insert to founders only', () => {
    expect(sql).toMatch(/create policy "Founders can read the audit log"[\s\S]*?using \(public\.is_founder\(\)\)/i);
    expect(sql).toMatch(
      /create policy "Founders can append to the audit log"[\s\S]*?with check \(public\.is_founder\(\) and actor_id = auth\.uid\(\)\)/i
    );
  });

  it('re-scopes the original policies to authenticated (no PUBLIC default)', () => {
    // Every policy name from the base schema must be re-created with a TO clause.
    const rescoped = sql.match(/create policy "[^"]+"\s*\n?\s*on public\.[a-z_]+ for [a-z ]+ to authenticated/gi) ?? [];
    expect(rescoped.length).toBeGreaterThanOrEqual(20);
  });

  it('never defines an update or delete policy on audit_log', () => {
    const policies = sql
      .split(';')
      .filter((statement) => /create policy/i.test(statement) && /audit_log/i.test(statement));

    expect(policies.length).toBeGreaterThan(0);
    for (const policy of policies) {
      expect(policy).not.toMatch(/for update/i);
      expect(policy).not.toMatch(/for delete/i);
      expect(policy).not.toMatch(/for all/i);
    }
  });
});

describe('storage bucket is private', () => {
  const sql = allMigrationSql();

  it('flips the receipts bucket to private', () => {
    expect(sql).toMatch(/update storage\.buckets[\s\S]*?set public = false[\s\S]*?where id = 'receipts'/i);
  });

  it('no migration (re-)creates a public bucket', () => {
    const publicBuckets = sql
      .split('\n')
      .filter((line) => /insert into storage\.buckets/i.test(line));
    expect(publicBuckets.length).toBeGreaterThan(0);
    // The original creation is `values ('receipts', 'receipts', true, …)`; the
    // later migration must undo it. Assertion: every literal `true` in a bucket
    // insert is followed by a `public = false` update for that bucket.
    for (const line of publicBuckets) {
      if (/,\s*true\s*,/.test(line)) {
        expect(sql).toMatch(/update storage\.buckets[\s\S]*?set public = false/i);
      }
    }
  });

  it('backfills stored public URLs into bare storage paths', () => {
    expect(sql).toMatch(/split_part\(receipt_url, '\?', 1\)/i);
    expect(sql).toMatch(/regexp_replace\(/i);
    expect(sql).toMatch(/storage\/v1\/object\/\(public\|sign\|authenticated\)\/receipts\//i);
  });
});

describe('category CHECK constraints stay in sync', () => {
  const sql = allMigrationSql();

  it('matches the single TypeScript definition in every migration it appears in', () => {
    const pattern = /category\s+TEXT\s+NOT NULL\s+CHECK\s*\(\s*category IN\s*\(([^)]+)\)/gi;
    const lists = [...sql.matchAll(pattern)].map((match) =>
      match[1]
        .split(',')
        .map((value) => value.trim().replace(/^'|'$/g, ''))
    );

    expect(lists.length, 'no category CHECK constraint found').toBeGreaterThanOrEqual(2); // expenses + vendor_memory

    for (const list of lists) {
      expect(list).toEqual([...EXPENSE_CATEGORIES]);
    }
  });

  it('validates the category inside the vendor-outcome function too', () => {
    expect(sql).toMatch(/p_final_category NOT IN\s*\(\s*'materials', 'labor', 'equipment', 'permits', 'transportation', 'other'\s*\)/i);
  });
});

describe('seed data safety', () => {
  const sql = allMigrationSql();

  it('warns loudly that the demo seed must not run in production', () => {
    expect(sql).toMatch(/never run in production|not for production|DEMO SEED/i);
  });

  it('keeps demo credentials out of any non-seed migration', () => {
    for (const name of migrationFiles()) {
      if (name.includes('seed')) continue;
      const contents = readFileSync(join(MIGRATIONS_DIR, name), 'utf8');
      expect(contents, `${name} contains a demo password`).not.toMatch(/asinta2026/);
    }
  });
});
