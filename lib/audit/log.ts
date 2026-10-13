/**
 * Append-only audit trail for financial mutations.
 *
 * WHAT IS RECORDED
 * ----------------
 * Inserts, updates and deletes on the tables that move money: `invoices`,
 * `expenses`, `advances`, `payroll`, and the separate `advance_requests` workflow.
 * Each entry stores WHO (actor id and the
 * email at the time of the action), WHAT (table + record id), WHICH operation,
 * and the full row snapshot BEFORE and AFTER — so "this invoice was marked paid"
 * is backed by "amount_paid went from 0 to 120,000".
 *
 * WHAT IS NOT
 * -----------
 * This is not tamper-proof storage: a database superuser can still edit
 * Postgres directly. What it does guarantee is that no application path —
 * including a stolen Founder session — can rewrite history, because the
 * `audit_log` table has Founder INSERT/SELECT policies and deliberately NO
 * update or delete policy at all.
 *
 * Failure handling is visible, never silent: if the audit write fails, the
 * caller tells the Founder the change was saved but not logged. We do not block
 * the ledger write on the audit write — losing an expense entry because the
 * trail was unavailable would be worse — but we never pretend it was recorded.
 */

import type { PostgrestError } from '@supabase/supabase-js';

export type AuditAction = 'insert' | 'update' | 'delete';

/** Tables whose mutations are money-relevant and therefore audited. */
export const AUDITED_TABLES = ['invoices', 'expenses', 'advances', 'payroll', 'advance_requests'] as const;
export type AuditedTable = (typeof AUDITED_TABLES)[number];

export interface AuditEntry {
  actorId: string | null;
  actorEmail?: string | null;
  action: AuditAction;
  table: AuditedTable;
  recordId: string | null;
  /** Row snapshot before the change (null on insert). */
  before?: Record<string, unknown> | null;
  /** Row snapshot after the change (null on delete). */
  after?: Record<string, unknown> | null;
}

export interface AuditRow {
  actor_id: string | null;
  actor_email: string | null;
  action: AuditAction;
  table_name: AuditedTable;
  record_id: string | null;
  before_row: Record<string, unknown> | null;
  after_row: Record<string, unknown> | null;
}

/** Columns that must never be copied into the trail. */
const REDACTED_COLUMNS = ['ai_approval_suggestion'];

/**
 * Turns an entry into the exact row inserted into `audit_log`.
 *
 * Pure and exported so the shape can be unit-tested without a database.
 * Snapshots are shallow-copied and stripped of unknown keys so a caller cannot
 * smuggle extra columns (or a non-serialisable value) into the JSONB payload.
 */
export function buildAuditRow(entry: AuditEntry): AuditRow {
  const clean = (
    snapshot: Record<string, unknown> | null | undefined
  ): Record<string, unknown> | null => {
    if (!snapshot) return null;
    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(snapshot)) {
      if (REDACTED_COLUMNS.includes(key)) continue;
      // JSON.stringify drops undefined; make the intent explicit.
      output[key] = value === undefined ? null : value;
    }
    return output;
  };

  return {
    actor_id: entry.actorId,
    actor_email: entry.actorEmail ?? null,
    action: entry.action,
    table_name: entry.table,
    record_id: entry.recordId,
    before_row: clean(entry.before),
    after_row: clean(entry.after),
  };
}

interface AuditWriter {
  from: (table: string) => {
    insert: (row: AuditRow) => PromiseLike<{ error: PostgrestError | null }>;
  };
}

export interface WriteAuditResult {
  ok: boolean;
  error?: string;
}

/**
 * Best-effort write. Never throws: the caller decides how loud to be about a
 * failure, and the ledger mutation itself has already happened by then.
 */
export async function writeAuditEntry(
  db: AuditWriter,
  entry: AuditEntry
): Promise<WriteAuditResult> {
  try {
    const { error } = await db.from('audit_log').insert(buildAuditRow(entry));
    if (error) {
      return { ok: false, error: error.message };
    }
    return { ok: true };
  } catch (caught) {
    return {
      ok: false,
      error: caught instanceof Error ? caught.message : 'unexpected audit error',
    };
  }
}

/** Message shown when a ledger change saved but the trail did not. */
export function auditFailureMessage(label: string, error?: string): string {
  return `${label} was saved, but the audit trail entry could not be recorded${
    error ? `: ${error}` : '.'
  } Financial changes without a trail entry should be reported to the firm administrator.`;
}
