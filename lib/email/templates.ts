/**
 * BALE email template engine.
 *
 * Founders edit safe text templates with {{placeholder}} tokens — never
 * executable HTML. All values are resolved server-side from authoritative
 * database rows, escaped, and rendered into both plain-text and HTML
 * variants. This module is pure (no I/O) so it can be unit-tested directly.
 */

import { escapeHtml, formatDatePH, formatPeso } from './format';

const EMAIL_TEMPLATE_TYPES = [
  'initial_request',
  'upcoming_reminder',
  'due_today',
  'overdue',
  'payment_acknowledgment',
  'final_demand',
] as const;

export type EmailTemplateType = (typeof EMAIL_TEMPLATE_TYPES)[number];

/** Template types Founders may edit in the current release. */
export const EDITABLE_TEMPLATE_TYPES: EmailTemplateType[] = ['initial_request'];

export const SUPPORTED_PLACEHOLDERS = [
  'client_contact_name',
  'client_company_name',
  'project_name',
  'invoice_number',
  'issue_date',
  'invoice_amount',
  'amount_paid',
  'outstanding_balance',
  'due_date',
  'invoice_notes',
  'firm_email',
  'firm_contact_number',
] as const;

export type SupportedPlaceholder = (typeof SUPPORTED_PLACEHOLDERS)[number];

/** Placeholders a billing template should not lose without a warning. */
export const IMPORTANT_PLACEHOLDERS: SupportedPlaceholder[] = [
  'project_name',
  'invoice_number',
  'outstanding_balance',
  'due_date',
];

export const DEFAULT_INITIAL_REQUEST_SUBJECT =
  'Request for Payment – {{project_name}} – {{invoice_number}}';

export const DEFAULT_INITIAL_REQUEST_BODY = `Dear {{client_contact_name}},

Good day.

Please find below the Request for Payment from Asinta Architects for the project {{project_name}}.

Invoice Number: {{invoice_number}}
Invoice Date: {{issue_date}}
Total Invoice Amount: {{invoice_amount}}
Payments Received: {{amount_paid}}
Outstanding Balance: {{outstanding_balance}}
Payment Due Date: {{due_date}}

{{invoice_notes}}

We kindly request that payment be settled on or before the stated due date. If payment has already been made, please disregard this request and send us the payment confirmation for proper recording.

For questions or clarifications regarding this billing, you may reply to this email or contact Asinta Architects directly.

Thank you for your continued trust and support.

God bless.

Sincerely,

Asinta Architects
{{firm_email}}
{{firm_contact_number}}

This email was generated through the BALE management system.`;

/** One neutral template for future automatic reminders at every stage. */
export const REMINDER_EMAIL_TEMPLATE_TYPE = 'upcoming_reminder' as const;
export const DEFAULT_REMINDER_SUBJECT = 'Payment reminder – {{project_name}} – {{invoice_number}}';
export const DEFAULT_REMINDER_BODY = `Dear {{client_contact_name}},

Good day. This is a reminder about the outstanding balance for {{project_name}}.

Invoice Number: {{invoice_number}}
Outstanding Balance: {{outstanding_balance}}
Payment Due Date: {{due_date}}

If payment has already been made, please disregard this reminder and send us the payment confirmation for our records. For questions, please reply to this email.

Thank you and God bless.

Asinta Architects
{{firm_email}}
{{firm_contact_number}}`;

/** In addition to unknown tokens, reject incomplete token syntax. */
export function validateReminderEmailTemplate(subject: string, body: string): TemplateValidationResult {
  const result = validateTemplate(subject, body);
  const leftover = (subject + '\n' + body).replace(/\{\{[a-z_]+\}\}/g, '');
  const malformed = leftover.includes('{{') || leftover.includes('}}');
  return { ...result, valid: result.valid && !malformed && Boolean(subject.trim()) && Boolean(body.trim()) && subject.length <= 500 && body.length <= 10000 && !/[\r\n]/.test(subject) };
}

export interface TemplateInvoiceData {
  clientContactPerson?: string | null;
  clientCompanyName?: string | null;
  projectName: string;
  invoiceNumber: string;
  /** ISO date (YYYY-MM-DD). */
  issueDate: string;
  invoiceAmount: number;
  amountPaid: number;
  /** ISO date (YYYY-MM-DD). */
  dueDate: string;
  invoiceNotes?: string | null;
  firmEmail?: string | null;
  firmContactNumber?: string | null;
}

/** Prefer contact person → company name → "Valued Client". */
export function resolveClientGreetingName(
  contactPerson: string | null | undefined,
  companyName: string | null | undefined
): string {
  const contact = (contactPerson || '').trim();
  if (contact) return contact;
  const company = (companyName || '').trim();
  if (company) return company;
  return 'Valued Client';
}

function buildPlaceholderValues(data: TemplateInvoiceData): Record<SupportedPlaceholder, string> {
  return {
    client_contact_name: resolveClientGreetingName(data.clientContactPerson, data.clientCompanyName),
    client_company_name: (data.clientCompanyName || '').trim() || 'Valued Client',
    project_name: data.projectName || '',
    invoice_number: data.invoiceNumber || '',
    issue_date: formatDatePH(data.issueDate),
    invoice_amount: formatPeso(data.invoiceAmount),
    amount_paid: formatPeso(data.amountPaid),
    outstanding_balance: formatPeso(Math.max(0, data.invoiceAmount - data.amountPaid)),
    due_date: formatDatePH(data.dueDate),
    invoice_notes: (data.invoiceNotes || '').trim(),
    firm_email: (data.firmEmail || '').trim(),
    firm_contact_number: (data.firmContactNumber || '').trim(),
  };
}

const PLACEHOLDER_PATTERN = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/** Extracts every {{placeholder}} token found in a template string. */
export function extractPlaceholders(template: string): string[] {
  const found: string[] = [];
  let match: RegExpExecArray | null;
  const pattern = new RegExp(PLACEHOLDER_PATTERN.source, 'g');
  while ((match = pattern.exec(template)) !== null) {
    found.push(match[1]);
  }
  return found;
}

export interface TemplateValidationResult {
  valid: boolean;
  /** Placeholders that are not in the supported list. Sending must be rejected. */
  unknownPlaceholders: string[];
  /** Important billing placeholders missing from the template. Warn, don't block. */
  missingImportantPlaceholders: string[];
}

/** Validates a subject + body template pair against the supported placeholder set. */
export function validateTemplate(subjectTemplate: string, bodyTemplate: string): TemplateValidationResult {
  const used = new Set([
    ...extractPlaceholders(subjectTemplate),
    ...extractPlaceholders(bodyTemplate),
  ]);

  const supported = new Set<string>(SUPPORTED_PLACEHOLDERS);
  const unknownPlaceholders = [...used].filter((token) => !supported.has(token));
  const missingImportantPlaceholders = IMPORTANT_PLACEHOLDERS.filter((token) => !used.has(token));

  return {
    valid: unknownPlaceholders.length === 0,
    unknownPlaceholders,
    missingImportantPlaceholders,
  };
}

function replacePlaceholders(template: string, values: Record<string, string>): string {
  return template.replace(new RegExp(PLACEHOLDER_PATTERN.source, 'g'), (whole, token: string) =>
    Object.prototype.hasOwnProperty.call(values, token) ? values[token] : whole
  );
}

/** Collapses 3+ consecutive blank lines left behind by empty optional values. */
function tidyBlankLines(text: string): string {
  return text.replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

export interface RenderedEmail {
  subject: string;
  bodyText: string;
  bodyHtml: string;
  validation: TemplateValidationResult;
}

export class TemplateRenderError extends Error {
  unknownPlaceholders: string[];
  constructor(message: string, unknownPlaceholders: string[]) {
    super(message);
    this.name = 'TemplateRenderError';
    this.unknownPlaceholders = unknownPlaceholders;
  }
}

/**
 * Renders a subject/body template pair with authoritative invoice data into
 * the exact plain-text and HTML messages to be sent.
 *
 * Throws TemplateRenderError when the template contains unsupported
 * placeholders — unresolved tokens must never reach a client inbox.
 */
export function renderEmail(
  subjectTemplate: string,
  bodyTemplate: string,
  data: TemplateInvoiceData
): RenderedEmail {
  const validation = validateTemplate(subjectTemplate, bodyTemplate);
  if (!validation.valid) {
    throw new TemplateRenderError(
      `Template contains unsupported placeholders: ${validation.unknownPlaceholders.join(', ')}`,
      validation.unknownPlaceholders
    );
  }

  const values = buildPlaceholderValues(data);
  const subject = replacePlaceholders(subjectTemplate, values).replace(/[\r\n]+/g, ' ').trim();
  const bodyText = tidyBlankLines(replacePlaceholders(bodyTemplate, values));

  // Safety net: no unresolved tokens may survive rendering.
  const leftover = [...extractPlaceholders(subject), ...extractPlaceholders(bodyText)];
  if (leftover.length > 0) {
    throw new TemplateRenderError(
      `Rendered email still contains unresolved placeholders: ${leftover.join(', ')}`,
      leftover
    );
  }

  const bodyHtml = renderHtmlEmail(bodyText, data);
  return { subject, bodyText, bodyHtml, validation };
}

// ---------------------------------------------------------------------------
// HTML rendering — generated entirely server-side from the rendered plain
// text. Every value is escaped; no scripts, iframes, event handlers, or
// remote images are ever emitted.
// ---------------------------------------------------------------------------

interface HtmlBlock {
  kind: 'paragraph' | 'table';
  lines: string[];
}

/** Lines shaped like "Label: value" are grouped into a billing summary table. */
function groupBodyIntoBlocks(bodyText: string): HtmlBlock[] {
  const blocks: HtmlBlock[] = [];
  const paragraphs = bodyText.split(/\n{2,}/);

  for (const paragraph of paragraphs) {
    const lines = paragraph.split('\n').filter((line) => line.trim().length > 0);
    if (lines.length === 0) continue;

    const isSummary =
      lines.length >= 2 &&
      lines.every((line) => {
        const idx = line.indexOf(': ');
        return idx > 0 && idx <= 40;
      });

    blocks.push({ kind: isSummary ? 'table' : 'paragraph', lines });
  }

  return blocks;
}

function isEmphasisLabel(label: string): boolean {
  return /balance|due date/i.test(label);
}

/**
 * Builds the branded Asinta Architects HTML email. Content is derived from
 * the already-rendered plain-text body so both variants always match.
 */
function renderHtmlEmail(bodyText: string, data: TemplateInvoiceData): string {
  const blocks = groupBodyIntoBlocks(bodyText);
  const heading = `${data.projectName} — ${data.invoiceNumber}`;

  const blockHtml = blocks
    .map((block) => {
      if (block.kind === 'table') {
        const rows = block.lines
          .map((line) => {
            const idx = line.indexOf(': ');
            const label = line.slice(0, idx).trim();
            const value = line.slice(idx + 2).trim();
            const emphasize = isEmphasisLabel(label);
            const labelStyle =
              'padding:8px 12px;border-bottom:1px solid #e2e8f0;color:#475569;font-size:13px;text-align:left;white-space:nowrap;';
            const valueStyle = emphasize
              ? 'padding:8px 12px;border-bottom:1px solid #e2e8f0;color:#0b1f3a;font-size:14px;font-weight:700;text-align:right;'
              : 'padding:8px 12px;border-bottom:1px solid #e2e8f0;color:#1e293b;font-size:13px;text-align:right;';
            return `<tr><td style="${labelStyle}">${escapeHtml(label)}</td><td style="${valueStyle}">${escapeHtml(value)}</td></tr>`;
          })
          .join('');
        return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:8px;border-collapse:separate;margin:16px 0;">${rows}</table>`;
      }

      const text = block.lines.map((line) => escapeHtml(line)).join('<br />');
      return `<p style="margin:0 0 16px 0;color:#1e293b;font-size:14px;line-height:1.6;">${text}</p>`;
    })
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeHtml('Request for Payment — Asinta Architects')}</title>
</head>
<body style="margin:0;padding:0;background-color:#f1f5f9;font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f1f5f9;padding:24px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0;">
          <tr>
            <td style="background-color:#0b1f3a;padding:24px 32px;">
              <div style="color:#ffffff;font-size:20px;font-weight:800;letter-spacing:1px;">ASINTA ARCHITECTS</div>
              <div style="color:#cbd5e1;font-size:11px;letter-spacing:2px;text-transform:uppercase;margin-top:4px;">Billing &amp; Advance Ledger Engine</div>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 32px 8px 32px;">
              <div style="color:#0b1f3a;font-size:16px;font-weight:700;border-bottom:2px solid #0b1f3a;padding-bottom:8px;margin-bottom:16px;">${escapeHtml(heading)}</div>
              ${blockHtml}
            </td>
          </tr>
          <tr>
            <td style="padding:8px 32px 24px 32px;">
              <div style="border-top:1px solid #e2e8f0;padding-top:12px;color:#64748b;font-size:11px;line-height:1.5;">
                This email was generated through the BALE management system of Asinta Architects.
                Please reply to this email for any questions or clarifications regarding this billing.
              </div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/** Safe sample data for template previews when no real invoice is selected. */
export const SAMPLE_TEMPLATE_DATA: TemplateInvoiceData = {
  clientContactPerson: 'Juan Dela Cruz',
  clientCompanyName: 'Sample Development Corp.',
  projectName: 'Sample Residence — Batangas',
  invoiceNumber: 'ASINTA-2026-001',
  issueDate: '2026-01-05',
  invoiceAmount: 1500000,
  amountPaid: 500000,
  dueDate: '2026-01-20',
  invoiceNotes: '25% Structural Framing Progress Billing.',
  firmEmail: 'billing@example.com',
  firmContactNumber: '+63 900 000 0000',
};
