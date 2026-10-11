import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AUDITED_TABLES,
  auditFailureMessage,
  buildAuditRow,
  writeAuditEntry,
  type AuditEntry,
} from '@/lib/audit/log';

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

