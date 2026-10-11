import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AUDITED_TABLES,
  auditFailureMessage,
  buildAuditRow,
  writeAuditEntry,
  type AuditEntry,
} from '@/lib/audit/log';
import {
  EXPORTABLE_TABLES,
  handleLedgerExport,
  isExportableTable,
  sanitizeCsvCell,
  toCsv,
} from '@/lib/export/csv';
import { resetRateLimits } from '@/lib/rateLimit';

afterEach(() => {
  resetRateLimits();
});

const entry: AuditEntry = {
  actorId: 'user-1',
  actorEmail: 'junel@asinta.ph',
  action: 'update',
  table: 'invoices',
  recordId: 'inv-9',
  before: { id: 'inv-9', amount_paid: 0, status: 'pending' },
  after: { id: 'inv-9', amount_paid: 120000, status: 'paid' },
};

describe('audit row building', () => {
  it('records who, what, which operation and both snapshots', () => {
    const row = buildAuditRow(entry);
    expect(row).toMatchObject({
      actor_id: 'user-1',
      actor_email: 'junel@asinta.ph',
      action: 'update',
      table_name: 'invoices',
      record_id: 'inv-9',
    });
    expect(row.before_row).toEqual({ id: 'inv-9', amount_paid: 0, status: 'pending' });
    expect(row.after_row).toEqual({ id: 'inv-9', amount_paid: 120000, status: 'paid' });
  });

  it('keeps null snapshots null instead of writing {}', () => {
    const insert = buildAuditRow({ ...entry, action: 'insert', before: null, after: { id: 'x' } });
    expect(insert.before_row).toBeNull();
    expect(insert.after_row).toEqual({ id: 'x' });

    const removal = buildAuditRow({ ...entry, action: 'delete', before: { id: 'x' }, after: null });
    expect(removal.after_row).toBeNull();
  });

  it('allows a system actor (migrations) with no user id', () => {
    const row = buildAuditRow({ ...entry, actorId: null, actorEmail: 'migration:x' });
    expect(row.actor_id).toBeNull();
  });

  it('never copies a retired column into the trail', () => {
    const row = buildAuditRow({
      ...entry,
      after: { id: 'inv-9', ai_approval_suggestion: 'founder_review' },
    });
    expect(row.after_row).not.toHaveProperty('ai_approval_suggestion');
  });

  it('normalises undefined values so the JSONB payload is deterministic', () => {
    const row = buildAuditRow({ ...entry, after: { id: 'inv-9', notes: undefined } });
    expect(row.after_row).toEqual({ id: 'inv-9', notes: null });
  });
});

describe('audit table scope', () => {
  it('covers the money-moving tables', () => {
    expect([...AUDITED_TABLES]).toEqual(['invoices', 'expenses', 'advances', 'payroll']);
  });
});

describe('audit write failures are visible', () => {
  it('reports a database error instead of throwing', async () => {
    const db = { from: () => ({ insert: async () => ({ error: { message: 'permission denied' } }) }) };
    const result = await writeAuditEntry(db as any, entry);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('permission denied');
  });

  it('reports a thrown error (migration not applied) instead of throwing', async () => {
    const db = {
      from: () => ({
        insert: async () => {
          throw new Error('relation "audit_log" does not exist');
        },
      }),
    };
    const result = await writeAuditEntry(db as any, entry);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/does not exist/);
  });

  it('succeeds quietly when the write works', async () => {
    const insert = vi.fn(async () => ({ error: null }));
    const result = await writeAuditEntry({ from: () => ({ insert }) } as any, entry);
    expect(result.ok).toBe(true);
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it('tells the Founder the change saved but the trail did not', () => {
    const message = auditFailureMessage('This change', 'permission denied');
    expect(message).toMatch(/was saved, but the audit trail entry could not be recorded/);
    expect(message).toMatch(/permission denied/);
    expect(message).toMatch(/report/i);
  });
});

describe('Founder CSV export (Task 3b — audited, Founder-only, Excel-safe)', () => {
  function makeExportSupabase(options?: {
    user?: { id: string; email?: string } | null;
    role?: 'founder' | 'supervisor' | null;
    rows?: Record<string, unknown>[];
    auditError?: { message: string } | null;
  }) {
    const user = options && 'user' in options ? options.user : { id: 'founder-1', email: 'junel@asinta.ph' };
    const role = options && 'role' in options ? options.role : 'founder';
    const rows = options?.rows ?? [
      {
        id: 'w-1',
        name: 'Juan Dela Cruz',
        contact_number: '09171234567',
        position: 'Mason',
        pay_rate: 850,
        pay_rate_type: 'daily',
        active: true,
        created_at: '2026-10-06T00:00:00Z',
        encrypted_password: '$2a$10$mustneverleak',
      },
    ];
    const auditInsertSpy = vi.fn(async () => ({ error: options?.auditError ?? null }));

    const client = {
      auth: {
        getUser: async () => ({ data: { user: user ?? null }, error: user ? null : new Error('no session') }),
      },
      from: (table: string) => {
        if (table === 'users') {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: role ? { role } : null,
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === 'audit_log') {
          return { insert: auditInsertSpy };
        }
        return {
          select: () => ({
            order: async () => ({ data: rows, error: null }),
          }),
        };
      },
    };

    return { client, auditInsertSpy };
  }

  it('enforces requireFounder() server-side (blocks unauthenticated and Supervisor callers)', async () => {
    const unauth = makeExportSupabase({ user: null });
    const resUnauth = await handleLedgerExport({
      tableParam: 'expenses',
      headers: new Headers(),
      supabase: unauth.client as any,
    });
    expect(resUnauth.status).toBe(401);

    const supervisor = makeExportSupabase({ role: 'supervisor' });
    const resSup = await handleLedgerExport({
      tableParam: 'expenses',
      headers: new Headers(),
      supabase: supervisor.client as any,
    });
    expect(resSup.status).toBe(403);
    expect(supervisor.auditInsertSpy).not.toHaveBeenCalled();
  });

  it('never exports auth tables, public.users, or password hashes', async () => {
    for (const forbidden of ['auth.users', 'auth.refresh_tokens', 'users', 'pg_shadow', '']) {
      expect(isExportableTable(forbidden)).toBe(false);
      const { client, auditInsertSpy } = makeExportSupabase();
      const res = await handleLedgerExport({
        tableParam: forbidden,
        headers: new Headers(),
        supabase: client as any,
      });
      expect(res.status).toBe(400);
      expect(auditInsertSpy).not.toHaveBeenCalled();
    }

    // Even if a row object contains `encrypted_password`, `toCsv` strips it.
    const csv = toCsv('workers', [
      {
        id: 'w-1',
        name: 'Pedro Penduko',
        contact_number: '09180001111',
        position: 'Carpenter',
        pay_rate: 900,
        pay_rate_type: 'daily',
        active: true,
        created_at: '2026-10-06T00:00:00Z',
        encrypted_password: 'LEAKED_HASH_VALUE',
      },
    ]);
    expect(csv).not.toContain('LEAKED_HASH_VALUE');
    expect(csv).not.toContain('encrypted_password');
  });

  it('writes an audit_log entry recording who exported what and when, and fails closed if audit logging fails', async () => {
    const now = new Date('2026-10-11T05:00:00.000Z');
    const { client, auditInsertSpy } = makeExportSupabase();

    const okRes = await handleLedgerExport({
      tableParam: 'workers',
      headers: new Headers(),
      supabase: client as any,
      now,
    });

    expect(okRes.status).toBe(200);
    expect(okRes.headers['Content-Type']).toContain('text/csv');
    expect(okRes.headers['Content-Disposition']).toContain('bale-workers-2026-10-11.csv');
    expect(typeof okRes.body).toBe('string');
    expect((okRes.body as string).startsWith('\uFEFF')).toBe(true);
    expect(auditInsertSpy).toHaveBeenCalledTimes(1);
    expect(auditInsertSpy).toHaveBeenCalledWith({
      actor_id: 'founder-1',
      actor_email: 'junel@asinta.ph',
      action: 'insert',
      table_name: 'export:workers',
      record_id: null,
      before_row: null,
      after_row: {
        operation: 'csv_export',
        table: 'workers',
        row_count: 1,
        contains_personal_data: true,
        exported_at: '2026-10-11T05:00:00.000Z',
      },
    });

    // When audit_log fails, the export MUST fail closed (no unlogged RA 10173 export).
    const brokenAudit = makeExportSupabase({ auditError: { message: 'audit table locked' } });
    const failRes = await handleLedgerExport({
      tableParam: 'workers',
      headers: new Headers(),
      supabase: brokenAudit.client as any,
      now,
    });
    expect(failRes.status).toBe(500);
    expect(typeof failRes.body).toBe('object');
  });

  it('neutralises Excel formula injection while keeping negative numbers intact', () => {
    expect(sanitizeCsvCell('=CMD|\' /C calc\'!A0')).toBe("'=CMD|' /C calc'!A0");
    expect(sanitizeCsvCell('+SUM(A1:A2)')).toBe("'+SUM(A1:A2)");
    expect(sanitizeCsvCell('@IMPORTXML()')).toBe("'@IMPORTXML()");
    expect(sanitizeCsvCell('-cmd')).toBe("'-cmd");
    expect(sanitizeCsvCell(-1250.5)).toBe('-1250.5');
    expect(sanitizeCsvCell('-500')).toBe('-500');
    expect(Object.keys(EXPORTABLE_TABLES)).not.toContain('users');
  });
});

describe('automated pg_dump backup workflow (Task 3a)', () => {
  it('ships .github/workflows/backup.yml with cron, workflow_dispatch, and the project-ref guard', () => {
    const workflow = readFileSync(join(process.cwd(), '.github/workflows/backup.yml'), 'utf8');
    expect(workflow).toMatch(/schedule:/);
    expect(workflow).toMatch(/cron:/);
    expect(workflow).toMatch(/workflow_dispatch:/);
    expect(workflow).toMatch(/EXPECTED_REF:\s*mchkdkjntnbwrgmyobpd/);
    expect(workflow).toMatch(/SUPABASE_DB_URL/);
    expect(workflow).toMatch(/pg_dump/);
    expect(workflow).toMatch(/actions\/upload-artifact@v4/);
  });
});

