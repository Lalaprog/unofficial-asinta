/**
 * Prepare (but never send) a scheduled reminder email from authoritative data.
 * This is deliberately not connected to the cron. A future dispatcher must
 * separately enforce channel/master settings, schedule, provider readiness,
 * delivery locks, recent manual sends and a fresh snapshot immediately before
 * dispatch. A fingerprint is a best-effort change detector, not a lock.
 */
import { createHash } from 'node:crypto';
import { isValidEmail } from '@/lib/email/format';
import {
  DEFAULT_REMINDER_BODY, DEFAULT_REMINDER_SUBJECT, REMINDER_EMAIL_TEMPLATE_TYPE,
  renderEmail, validateReminderEmailTemplate, type RenderedEmail, type TemplateInvoiceData,
} from '@/lib/email/templates';

type Db = { from: (table: string) => any };
export type PreparedReminder = {
  invoiceId: string;
  recipient: string;
  rendered: RenderedEmail;
  templateVersion: number;
  fingerprint: string;
};
export type PrepareReminderResult = { ok: true; prepared: PreparedReminder } | { ok: false; reason: string };

function money(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim())) return NaN;
  return Number(value);
}
function calendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function nonempty(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }

export async function prepareReminderEmail(params: {
  db: Db;
  invoiceId: string;
  now: Date;
  firmEmail: string;
  firmContactNumber: string;
}): Promise<PrepareReminderResult> {
  try {
    if (!nonempty(params.invoiceId) || !Number.isFinite(params.now.getTime())) return { ok: false, reason: 'invalid_request' };
    const { data: invoice, error: invoiceError } = await params.db.from('invoices')
      .select('id,invoice_number,client_id,project_id,amount,amount_paid,issue_date,due_date,status,notes,automatic_reminders_enabled,reminders_paused_until')
      .eq('id', params.invoiceId).maybeSingle();
    if (invoiceError || !invoice) return { ok: false, reason: 'invoice_unavailable' };
    const amount = money(invoice.amount); const paid = money(invoice.amount_paid);
    if (!['pending','partially_paid','overdue'].includes(invoice.status) || !Number.isFinite(amount) || !Number.isFinite(paid) || amount < 0 || paid < 0 || amount - paid <= 0 || invoice.automatic_reminders_enabled !== true) return {ok:false,reason:'invoice_ineligible'};
    if (invoice.reminders_paused_until != null) {
      const pause = new Date(invoice.reminders_paused_until).getTime();
      if (!Number.isFinite(pause) || pause > params.now.getTime()) return {ok:false,reason:'invoice_paused_or_invalid'};
    }
    if (!calendarDate(invoice.issue_date) || !calendarDate(invoice.due_date) || !nonempty(invoice.invoice_number) || !nonempty(invoice.client_id) || !nonempty(invoice.project_id)) return {ok:false,reason:'invoice_details_invalid'};
    const [clientResult, projectResult, templateResult] = await Promise.all([
      params.db.from('clients').select('id,name,contact_person,email').eq('id', invoice.client_id).maybeSingle(),
      params.db.from('projects').select('id,name').eq('id', invoice.project_id).maybeSingle(),
      params.db.from('email_templates').select('subject_template,body_template,version,active').eq('template_type', REMINDER_EMAIL_TEMPLATE_TYPE).maybeSingle(),
    ]);
    const client = clientResult.data, project = projectResult.data, row = templateResult.data;
    if (clientResult.error || !client || !nonempty(client.email) || !isValidEmail(client.email)) return {ok:false,reason:'recipient_unavailable'};
    if (projectResult.error || !project || !nonempty(project.name)) return {ok:false,reason:'project_unavailable'};
    if (templateResult.error) return {ok:false,reason:'template_unavailable'};
    if (row && (row.active !== true || !Number.isSafeInteger(row.version) || row.version < 1 || typeof row.subject_template !== 'string' || typeof row.body_template !== 'string')) return {ok:false,reason:'template_invalid'};
    const subject = row ? row.subject_template : DEFAULT_REMINDER_SUBJECT;
    const body = row ? row.body_template : DEFAULT_REMINDER_BODY;
    if (!validateReminderEmailTemplate(subject, body).valid) return {ok:false,reason:'template_invalid'};
    const data: TemplateInvoiceData = {
      clientContactPerson: client.contact_person, clientCompanyName: client.name,
      projectName: project.name, invoiceNumber: invoice.invoice_number, issueDate: invoice.issue_date,
      invoiceAmount: amount, amountPaid: paid, dueDate: invoice.due_date, invoiceNotes: invoice.notes,
      firmEmail: params.firmEmail, firmContactNumber: params.firmContactNumber,
    };
    const rendered = renderEmail(subject, body, data);
    const recipient = client.email.trim(); const templateVersion = row?.version ?? 0;
    const fingerprint = createHash('sha256').update(JSON.stringify({ invoiceId: invoice.id, recipient, status: invoice.status,
      enabled: invoice.automatic_reminders_enabled, pause: invoice.reminders_paused_until, clientId: invoice.client_id,
      projectId: invoice.project_id, templateVersion, data, subject: rendered.subject, bodyText: rendered.bodyText, bodyHtml: rendered.bodyHtml })).digest('hex');
    return {ok:true,prepared:{invoiceId:invoice.id,recipient,rendered,templateVersion,fingerprint}};
  } catch {
    return {ok:false,reason:'preparation_unavailable'};
  }
}
