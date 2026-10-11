/**
 * Founder-only CSV ledger export (`GET /api/export?table=<name>`).
 *
 * DISTINCTION: BACKUP vs EXPORT
 * -----------------------------
 * - BACKUP (`.github/workflows/backup.yml`) = automated weekly `pg_dump`
 *   producing a restorable SQL archive of the database.
 * - EXPORT (this module) = on-demand CSV download so a Founder can inspect
 *   tables in Excel. A manual button is never a backup strategy because humans
 *   forget to press it.
 *
 * STORAGE GAP
 * -----------
 * Neither `pg_dump` nor this CSV export includes the receipt image files in the
 * `receipts` Supabase Storage bucket (`expenses.receipt_url` holds only the bare
 * storage path). Receipt photos must be copied separately from Supabase Storage.
 *
 * SECURITY & PRIVACY (RA 10173)
 * -----------------------------
 * 1. Enforced server-side with `requireFounder()` — never a hidden UI button.
 * 2. Rate-limited via `lib/rateLimit.ts` (`RATE_LIMITS.ledgerExport`).
 * 3. Every export writes an append-only `public.audit_log` row recording WHO
 *    exported WHICH table, HOW MANY rows, and WHEN. If the audit write fails,
 *    the export fails closed and no CSV leaves the server.
 * 4. Strict table + column allowlist: `auth.*` tables, password hashes, tokens,
 *    and secrets can never be requested or serialised.
 * 5. Excel-safe CSV: UTF-8 BOM (`\uFEFF`) for Filipino characters (`Ñ`/`ñ`, `₱`),
 *    RFC 4180 quoting, and formula-injection neutralisation (`=`, `+`, `-`, `@`).
 */

import { requireFounder, type MinimalSupabaseAuthClient } from '@/lib/auth/serverRole';
import {
  checkRateLimit,
  getRateLimitIdentity,
  rateLimitHeaders,
  rateLimitMessage,
  type RateLimitHeaders,
} from '@/lib/rateLimit';

/**
 * Explicit allowlist of exportable public ledger tables and their columns.
 * Auth tables (`auth.*`) and credential/token columns are never in this map.
 */
export const EXPORTABLE_TABLES = {
  invoices: [
    'id',
    'invoice_number',
    'project_id',
    'client_id',
    'amount',
    'amount_paid',
    'status',
    'issue_date',
    'due_date',
    'notes',
    'automatic_reminders_enabled',
    'reminders_paused_until',
    'created_at',
  ],
  expenses: [
    'id',
    'project_id',
    'expense_date',
    'category',
    'vendor',
    'description',
    'amount',
    'receipt_url',
    'notes',
    'ai_category_suggestion',
    'ai_bale_detection',
    'ai_confirmed',
    'created_by',
    'created_at',
  ],
  payroll: [
    'id',
    'worker_id',
    'period_start',
    'period_end',
    'days_worked',
    'hours_worked',
    'gross_pay',
    'bale_deduction',
    'other_deductions',
    'net_pay',
    'status',
    'notes',
    'created_at',
  ],
  advances: [
    'id',
    'worker_id',
    'project_id',
    'date',
    'amount',
    'amount_deducted',
    'status',
    'reason',
    'created_at',
  ],
  attendance: [
    'id',
    'worker_id',
    'project_id',
    'date',
    'status',
    'hours_worked',
    'notes',
    'recorded_by',
    'is_founder_override',
    'submitted_at',
    'created_at',
  ],
  projects: [
    'id',
    'name',
    'client_id',
    'location',
    'budget_estimate',
    'status',
    'start_date',
    'target_completion_date',
    'created_at',
  ],
  clients: [
    'id',
    'name',
    'contact_person',
    'phone',
    'email',
    'address',
    'created_at',
  ],
  workers: [
    'id',
    'name',
    'contact_number',
    'position',
    'pay_rate',
    'pay_rate_type',
    'active',
    'created_at',
  ],
  audit_log: [
    'id',
    'created_at',
    'actor_id',
    'actor_email',
    'action',
    'table_name',
    'record_id',
  ],
} as const satisfies Record<string, readonly string[]>;

export type ExportableTable = keyof typeof EXPORTABLE_TABLES;

/** Tables whose rows contain RA 10173 personal data (names, phones, wages). */
export const PERSONAL_DATA_TABLES: ReadonlySet<ExportableTable> = new Set<ExportableTable>([
  'workers',
  'clients',
  'attendance',
  'payroll',
  'advances',
  'audit_log',
]);

/**
 * Columns that must never be emitted in any CSV export even if present on an
 * input row.
 */
export const FORBIDDEN_EXPORT_COLUMNS = new Set([
  'encrypted_password',
  'password',
  'password_hash',
  'recovery_token',
  'confirmation_token',
  'reauthentication_token',
  'email_change_token_new',
  'email_change_token_current',
  'phone_change_token',
  'ai_approval_suggestion',
]);

export function isExportableTable(value: string | null | undefined): value is ExportableTable {
  if (!value) return false;
  return Object.prototype.hasOwnProperty.call(EXPORTABLE_TABLES, value);
}

/**
 * Neutralises spreadsheet formula injection (CSV/DDE injection).
 *
 * Excel evaluates cells starting with `=`, `+`, `-`, `@`, `\t`, or `\r` as
 * formulas when opening a CSV. Plain negative numbers (`-500`, `-12.34`) are
 * safe; everything else starting with a formula trigger is prefixed with `'`
 * so Excel treats it as literal text.
 */
export function sanitizeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  const trimmed = raw.trimStart();
  if (!trimmed) return raw;

  const first = trimmed[0];
  if (first === '=' || first === '+' || first === '@' || first === '\t' || first === '\r') {
    return `'${raw}`;
  }
  if (first === '-' && !/^-\d+(\.\d+)?$/.test(trimmed)) {
    return `'${raw}`;
  }
  return raw;
}

/** Formats one cell according to RFC 4180. */
export function encodeCsvCell(value: unknown): string {
  const safe = sanitizeCsvCell(value);
  if (
    safe.includes(',') ||
    safe.includes('"') ||
    safe.includes('\n') ||
    safe.includes('\r')
  ) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

/**
 * Serialises rows for an allowlisted table into an Excel-ready CSV string
 * (prefixed with a UTF-8 BOM `\uFEFF` and using `\r\n` line endings).
 */
export function toCsv(
  table: ExportableTable,
  rows: ReadonlyArray<Record<string, unknown>>
): string {
  const columns = EXPORTABLE_TABLES[table].filter(
    (col) => !FORBIDDEN_EXPORT_COLUMNS.has(col)
  );
  const headerLine = columns.map((col) => encodeCsvCell(col)).join(',');
  const bodyLines = rows.map((row) =>
    columns
      .map((col) => {
        if (FORBIDDEN_EXPORT_COLUMNS.has(col)) return '';
        return encodeCsvCell(row[col]);
      })
      .join(',')
  );

  return `\uFEFF${[headerLine, ...bodyLines].join('\r\n')}\r\n`;
}

export interface ExportOutcome {
  status: number;
  headers: Record<string, string>;
  body: string | { error: string; rateLimited?: boolean; retryAfterSeconds?: number };
}

/**
 * Pure server-side handler for `GET /api/export?table=<name>`.
 *
 * Enforces:
 *   1. `requireFounder(supabase)`
 *   2. `checkRateLimit('ledgerExport', ...)`
 *   3. `isExportableTable(table)` (blocks `auth.*` and unknown tables)
 *   4. Writes an `audit_log` entry BEFORE returning the CSV (fails closed if
 *      the audit entry cannot be recorded).
 */
export async function handleLedgerExport(params: {
  tableParam: string | null;
  headers: Headers;
  supabase: MinimalSupabaseAuthClient;
  now?: Date;
}): Promise<ExportOutcome> {
  const { tableParam, headers, supabase, now = new Date() } = params;

  // 1. Founder-only enforcement (server-side, includes MFA check when enabled).
  const founder = await requireFounder(supabase);
  if (!founder.ok) {
    return {
      status: founder.status,
      headers: { 'Cache-Control': 'private, no-store' },
      body: { error: founder.error || 'This action is restricted to Founder accounts' },
    };
  }

  // 2. Per-Founder rate limit.
  const identity = getRateLimitIdentity(headers, founder.userId);
  const decision = checkRateLimit('ledgerExport', identity, now.getTime());
  const limitHeaders: RateLimitHeaders = rateLimitHeaders('ledgerExport', decision);
  if (!decision.allowed) {
    return {
      status: 429,
      headers: { ...limitHeaders, 'Cache-Control': 'private, no-store' },
      body: {
        error: rateLimitMessage('ledgerExport', decision),
        rateLimited: true,
        retryAfterSeconds: decision.retryAfterSeconds,
      },
    };
  }

  // 3. Allowlist check — never export `auth.*`, `users`, or arbitrary tables.
  if (!isExportableTable(tableParam)) {
    const allowedList = Object.keys(EXPORTABLE_TABLES).join(', ');
    return {
      status: 400,
      headers: { ...limitHeaders, 'Cache-Control': 'private, no-store' },
      body: {
        error: `Unsupported or restricted table "${tableParam ?? ''}". Allowed ledger tables: ${allowedList}. Authentication tables and password hashes are never exported.`,
      },
    };
  }

  const columns = EXPORTABLE_TABLES[tableParam];

  // 4. Fetch rows through the Founder's RLS-scoped Supabase client.
  const { data: rows, error: queryError } = await supabase
    .from(tableParam)
    .select(columns.join(', '))
    .order('created_at', { ascending: false });

  if (queryError) {
    return {
      status: 500,
      headers: { ...limitHeaders, 'Cache-Control': 'private, no-store' },
      body: {
        error: `Could not read ${tableParam} for CSV export: ${queryError.message}`,
      },
    };
  }

  const safeRows = (Array.isArray(rows) ? rows : []) as Record<string, unknown>[];

  // 5. Record the export in `public.audit_log` BEFORE returning the CSV.
  //    RA 10173: worker names, contact numbers, wages, and client details are
  //    leaving the system. If the audit write fails, fail closed so no
  //    unlogged export ever leaves the server.
  const exportedAt = now.toISOString();
  const auditRow = {
    actor_id: founder.userId ?? null,
    actor_email: founder.userEmail ?? null,
    // `public.audit_log.action` has CHECK (action IN ('insert', 'update', 'delete')).
    action: 'insert' as const,
    table_name: `export:${tableParam}`,
    record_id: null,
    before_row: null,
    after_row: {
      operation: 'csv_export',
      table: tableParam,
      row_count: safeRows.length,
      contains_personal_data: PERSONAL_DATA_TABLES.has(tableParam),
      exported_at: exportedAt,
    },
  };

  try {
    const { error: auditError } = await supabase.from('audit_log').insert(auditRow);
    if (auditError) {
      return {
        status: 500,
        headers: { ...limitHeaders, 'Cache-Control': 'private, no-store' },
        body: {
          error: `Export refused because the audit trail entry could not be recorded: ${auditError.message}. Personal and financial data exports must be logged (RA 10173).`,
        },
      };
    }
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : 'unexpected audit error';
    return {
      status: 500,
      headers: { ...limitHeaders, 'Cache-Control': 'private, no-store' },
      body: {
        error: `Export refused because the audit trail entry could not be recorded: ${message}. Personal and financial data exports must be logged (RA 10173).`,
      },
    };
  }

  const csv = toCsv(tableParam, safeRows);
  const dateSlug = exportedAt.slice(0, 10);
  const filename = `bale-${tableParam}-${dateSlug}.csv`;

  return {
    status: 200,
    headers: {
      ...limitHeaders,
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'private, no-store',
    },
    body: csv,
  };
}
