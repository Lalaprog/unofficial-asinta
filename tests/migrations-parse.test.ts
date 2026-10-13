import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'libpg-query';

/**
 * Migration parse guard.
 *
 * `tests/rls-migration.test.ts` reads the migrations as TEXT — regexes,
 * `split(';')`, last-definition-wins. That is precisely how the defect below
 * survived a green suite and reached the live project. The regex
 * `/\bto\s+authenticated\b/` matched, but inside a chunk that only *looked*
 * like one statement: the preceding `create policy` had no terminating
 * semicolon, so it had swallowed the next `drop policy` into itself.
 *
 * These tests hand every file to libpg-query instead — the real PostgreSQL
 * grammar compiled to WASM. If `psql` would reject the file, this rejects the
 * file, before anyone pastes it into a SQL editor that runs the whole script
 * as one implicit transaction and therefore rolls back *all* of it on the
 * first syntax error.
 *
 * Two classes of defect it catches, both of which were live:
 *
 *   1. `syntax error at or near "drop"` — 23 `create policy` statements in
 *      `20261006000000_security_hardening.sql` §3 had no trailing semicolon.
 *      Everything after the first one was absorbed into it, so the migration
 *      applied nothing. The follow-up error, `relation "public.audit_log"
 *      does not exist`, was a symptom of that, not a second bug.
 *
 *   2. A policy with no `TO` clause. PostgreSQL resolves the missing grantee
 *      to PUBLIC, which includes `anon`. In the AST that shows up as a
 *      `RoleSpec` of `ROLESPEC_PUBLIC`; an explicit grantee is
 *      `ROLESPEC_CSTRING` carrying the role's name.
 */

const MIGRATIONS_DIR = join(process.cwd(), 'supabase/migrations');
const APPLY_DIR = join(process.cwd(), 'supabase/apply');

/** The grantee every policy in this codebase must name. */
const REQUIRED_ROLE = 'authenticated';

// ---------------------------------------------------------------------------
// Minimal AST types. libpg-query ships generated unions for the whole grammar;
// pinning the three fields we actually read keeps this file readable and stops
// a regenerated union type from breaking the build.
// ---------------------------------------------------------------------------

interface RoleSpecNode {
  roletype?: string;
  rolename?: string;
}

interface CreatePolicyNode {
  policy_name?: string;
  table?: { schemaname?: string; relname?: string };
  cmd_name?: string;
  permissive?: boolean;
  roles?: Array<{ RoleSpec?: RoleSpecNode }>;
}

interface DropStmtNode {
  removeType?: string;
  missing_ok?: boolean;
  objects?: Array<{ List?: { items?: Array<{ String?: { sval?: string } }> } }>;
}

interface ParsedStatement {
  stmt?: {
    CreatePolicyStmt?: CreatePolicyNode;
    DropStmt?: DropStmtNode;
  };
}

interface ParseResult {
  stmts?: ParsedStatement[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort();
}

function readMigration(name: string): string {
  return readFileSync(join(MIGRATIONS_DIR, name), 'utf8');
}

async function parseFile(sql: string, label: string): Promise<ParsedStatement[]> {
  let result: ParseResult;
  try {
    result = (await parse(sql)) as unknown as ParseResult;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${label} is not valid PostgreSQL and would be rejected by the SQL editor verbatim.\n` +
        `  parser: ${message}\n` +
        `  The editor runs a script as one implicit transaction, so ONE syntax error rolls\n` +
        `  back the whole file — that is how 20261006000000 applied nothing and the next\n` +
        `  migration then reported relation "public.audit_log" does not exist.\n` +
        `  See docs/MIGRATION_RUNBOOK.md §0.`
    );
  }
  return result.stmts ?? [];
}

function policiesIn(statements: ParsedStatement[]): CreatePolicyNode[] {
  return statements
    .map((statement) => statement.stmt?.CreatePolicyStmt)
    .filter((policy): policy is CreatePolicyNode => Boolean(policy));
}

function describePolicy(policy: CreatePolicyNode): string {
  const table = policy.table ? `${policy.table.schemaname}.${policy.table.relname}` : '?';
  return `"${policy.policy_name}" on ${table} (${policy.cmd_name})`;
}

/** True when the policy explicitly grants to `authenticated`. */
function isScopedToAuthenticated(policy: CreatePolicyNode): boolean {
  return (policy.roles ?? []).some(
    (role) =>
      role.RoleSpec?.roletype === 'ROLESPEC_CSTRING' &&
      role.RoleSpec?.rolename === REQUIRED_ROLE
  );
}

function unscopedPolicies(policies: CreatePolicyNode[]): CreatePolicyNode[] {
  return policies.filter((policy) => !isScopedToAuthenticated(policy));
}

/**
 * The table a `drop policy` targets. `drop policy "p" on public.users` parses
 * to objects[0].List.items = [schema, table, policy].
 */
function dropTarget(drop: DropStmtNode): string | undefined {
  return drop.objects?.[0]?.List?.items?.[1]?.String?.sval;
}

/**
 * The source-file digests a bundle records in its header, as written by
 * scripts/build-apply-sql.mjs: `--   <name>  <first 16 hex chars>…`
 */
function bundleSources(bundle: string): Array<{ name: string; digest: string }> {
  return [...bundle.matchAll(/^--\s+(\S+\.sql)\s+([0-9a-f]{16})…$/gm)].map((match) => ({
    name: match[1],
    digest: match[2],
  }));
}

/** Must match how scripts/build-apply-sql.mjs hashes each source file. */
function sourceDigest(name: string): string {
  const sql = readMigration(name).trimEnd();
  return createHash('sha256').update(sql).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------

describe('every migration parses as real PostgreSQL', () => {
  const files = migrationFiles();

  it('finds the migration files (sanity check on the fixture)', () => {
    expect(files.length).toBeGreaterThanOrEqual(6);
    expect(files).toContain('20261006000000_security_hardening.sql');
  });

  // One test per file, so a failure names the file in its title rather than
  // hiding it inside an assertion message.
  for (const name of files) {
    it(`parses ${name}`, async () => {
      const statements = await parseFile(readMigration(name), name);
      expect(statements.length).toBeGreaterThan(0);
    });
  }
});

describe('statement boundaries are real', () => {
  it('never merges two policy statements into one', () => {
    // The exact regression: a `create policy` whose `using (…)` / `with check (…)`
    // line has no semicolon absorbs the following `drop policy` into itself.
    // Regex-level, because the point is to prove the SOURCE has one statement
    // per semicolon — not merely that the grammar found some reading of it.
    const offenders: string[] = [];

    for (const name of migrationFiles()) {
      const sql = readMigration(name);
      sql
        .split(';')
        .map((chunk) => chunk.trim())
        .filter((chunk) => chunk.length > 0)
        .forEach((chunk, index) => {
          const count = chunk.match(/\b(?:create|drop)\s+policy\b/gi)?.length ?? 0;
          if (count > 1) {
            offenders.push(
              `${name}: chunk ${index + 1} holds ${count} policy statements —\n` +
                `    ${chunk.split('\n')[0].trim()}`
            );
          }
        });
    }

    expect(offenders, `merged policy statements found:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('re-scopes all 23 pre-existing policies in the hardening migration', async () => {
    const statements = await parseFile(
      readMigration('20261006000000_security_hardening.sql'),
      '20261006000000_security_hardening.sql'
    );

    const drops = statements
      .map((s) => s.stmt?.DropStmt)
      .filter((d): d is DropStmtNode => d?.removeType === 'OBJECT_POLICY');
    const creates = policiesIn(statements);

    // 23 re-scoped (20 base schema + 3 communications) and 2 brand-new
    // audit_log policies, each preceded by its own guarded drop.
    const rescopeTargets = drops.map(dropTarget).filter((t) => t !== 'audit_log');
    expect(rescopeTargets.length).toBe(23);
    expect(drops.length).toBe(25);
    expect(creates.length).toBe(25);

    // Every drop is guarded, so the migration stays re-runnable — which is what
    // made it safe to re-run after the semicolon defect rolled the first
    // attempt back.
    for (const drop of drops) {
      expect(drop.missing_ok).toBe(true);
    }
  });
});

describe('Supervisor Bale requests remain separate until payment is confirmed', () => {
  const sql = readMigration('20261013000000_advance_requests.sql');

  it('stores request metadata separately from issued advances', () => {
    expect(sql).toMatch(/create table if not exists public\.advance_requests/i);
    expect(sql).toMatch(/requested_amount\s+numeric\(10,\s*2\)\s+not null\s+check\s*\(requested_amount > 0\)/i);
    expect(sql).toMatch(/submitted_by\s+uuid\s+not null\s+references public\.users\(id\)/i);
    expect(sql).toMatch(/status\s+text\s+not null\s+default 'pending_approval'[\s\S]*?'issued'/i);
    expect(sql).toMatch(/grant select, insert on public\.advance_requests to authenticated/i);
    expect(sql).toMatch(/revoke update, delete on public\.advance_requests from authenticated/i);
    expect(sql).toContain("'Approved Bale request'");
  });

  it('limits review and payment issuance to Founder RPCs', () => {
    expect(sql).toMatch(/create or replace function public\.review_advance_request[\s\S]*?if not public\.is_founder\(\)/i);
    expect(sql).toMatch(/create or replace function public\.issue_advance_request[\s\S]*?if not public\.is_founder\(\)/i);
    expect(sql).toMatch(/status <> 'pending_approval'/i);
    expect(sql).toMatch(/status <> 'approved_pending_payment'/i);
    expect(sql).toMatch(/revoke all on function public\.review_advance_request\(uuid, text\) from public/i);
    expect(sql).toMatch(/revoke all on function public\.issue_advance_request\(uuid\) from public/i);
    expect(sql).toMatch(/grant execute on function public\.review_advance_request\(uuid, text\) to authenticated/i);
    expect(sql).toMatch(/grant execute on function public\.issue_advance_request\(uuid\) to authenticated/i);
  });
});

describe('every policy names its grantee', () => {
  it('has no policy anywhere that resolves to PUBLIC', async () => {
    const offenders: string[] = [];

    for (const name of migrationFiles()) {
      const policies = policiesIn(await parseFile(readMigration(name), name));
      for (const policy of unscopedPolicies(policies)) {
        offenders.push(`${name}: ${describePolicy(policy)}`);
      }
    }

    expect(
      offenders,
      `policies with no TO clause (PostgreSQL defaults these to PUBLIC, which includes anon):\n${offenders.join('\n')}`
    ).toEqual([]);
  });

  it('scopes all 20 policies in the base schema', async () => {
    const policies = policiesIn(
      await parseFile(
        readMigration('20260913000000_bale_schema.sql'),
        '20260913000000_bale_schema.sql'
      )
    );
    expect(policies.length).toBe(20);
    expect(unscopedPolicies(policies).map(describePolicy)).toEqual([]);
  });

  it('scopes all 4 storage policies in the schema additions', async () => {
    const policies = policiesIn(
      await parseFile(
        readMigration('20260913000001_bale_schema_additions.sql'),
        '20260913000001_bale_schema_additions.sql'
      )
    );
    expect(policies.length).toBe(4);
    expect(unscopedPolicies(policies).map(describePolicy)).toEqual([]);
  });

  it('scopes all 3 communications policies', async () => {
    // Called out separately because these three tables are created by a
    // migration the founder may not have run yet — and the hardening migration
    // re-scopes policies on tables that must therefore already exist.
    const policies = policiesIn(
      await parseFile(
        readMigration('20260929000000_communications.sql'),
        '20260929000000_communications.sql'
      )
    );
    expect(policies.length).toBe(3);
    expect(unscopedPolicies(policies).map(describePolicy)).toEqual([]);
  });
});

describe('audit_log stays append-only', () => {
  it('grants only select and insert, never update, delete or all', async () => {
    const policies = policiesIn(
      await parseFile(
        readMigration('20261006000000_security_hardening.sql'),
        '20261006000000_security_hardening.sql'
      )
    ).filter((policy) => policy.table?.relname === 'audit_log');

    expect(policies.length).toBe(2);
    expect(policies.map((policy) => policy.cmd_name).sort()).toEqual(['insert', 'select']);
    // `for all` would silently include update and delete.
    expect(policies.map((policy) => policy.cmd_name)).not.toContain('all');
  });
});

describe('the generated bundles are valid SQL too', () => {
  // The bundles are what the founder actually pastes into the SQL editor, so
  // they get the same guarantee as their sources — plus a staleness check,
  // because a bundle that was never regenerated after a migration change would
  // otherwise sail through every migration-level assertion below while being
  // the wrong file to paste.
  for (const name of ['fresh-install.sql', 'upgrade-hardening.sql']) {
    it(`parses supabase/apply/${name}`, async () => {
      const sql = readFileSync(join(APPLY_DIR, name), 'utf8');
      const policies = policiesIn(await parseFile(sql, `supabase/apply/${name}`));

      expect(policies.length).toBeGreaterThan(0);
      expect(
        unscopedPolicies(policies).map(describePolicy),
        `${name} carries a policy with no TO clause`
      ).toEqual([]);

      const sources = bundleSources(sql);
      expect(sources.length, `${name} records no source digests in its header`).toBeGreaterThan(0);

      for (const source of sources) {
        expect(
          sourceDigest(source.name),
          `${name} is STALE — it was generated from a different ${source.name}. ` +
            `Run \`npm run build:apply-sql\` and commit the regenerated bundle.`
        ).toBe(source.digest);
      }
    });
  }
});

describe('hand-written apply scripts parse and stay safe', () => {
  for (const name of ['preflight.sql', 'seed-cleanup.sql', 'verify-live.sql']) {
    it(`parses supabase/apply/${name}`, async () => {
      const sql = readFileSync(join(APPLY_DIR, name), 'utf8');
      const statements = await parseFile(sql, `supabase/apply/${name}`);
      expect(statements.length).toBeGreaterThan(0);
    });
  }

  it('seed-cleanup.sql compares as ::text = any($1::text[]) in all 32 places and stays disarmed', async () => {
    const sql = readFileSync(join(APPLY_DIR, 'seed-cleanup.sql'), 'utf8');

    // Every dynamic query in §3 must parse as valid SQL and compare via
    // `::text = any($1::text[])` because `auth.refresh_tokens.user_id` is
    // `character varying`, not `uuid`.
    const dynamicQueries = [...sql.matchAll(/execute\s+'([^']+)'/gi)].map((m) => m[1]);
    expect(dynamicQueries.length).toBe(34); // 2 in §2 + 32 in §3
    for (const query of dynamicQueries) {
      await parseFile(query, `seed-cleanup dynamic SQL (${query})`);
    }

    const allAnyComparisons = sql.match(/=\s*any\s*\([^)]+\)/gi) ?? [];
    const textCastComparisons = sql.match(/::text\s*=\s*any\(\$1::text\[\]\)/g) ?? [];
    expect(textCastComparisons.length).toBe(32);
    expect(allAnyComparisons.length).toBe(32);

    // Never ship a live replacement password or an armed §3 block in git.
    expect(sql).toMatch(/k_new_password\s+constant\s+text\s*:=\s*'CHANGE-ME-BEFORE-RUNNING'/);
    expect(sql).toMatch(/k_armed\s+constant\s+boolean\s*:=\s*false/);
  });
});

