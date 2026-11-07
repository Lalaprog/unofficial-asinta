/**
 * Server-side Request for Payment email workflow.
 *
 * All authoritative data (invoice, client, project, balances, recipient) is
 * loaded from the database here — browser-submitted financial or recipient
 * fields are never trusted. The Supabase client and mailer are injected so
 * unit tests can exercise every branch without network access.
 */

import {
  DEFAULT_INITIAL_REQUEST_BODY,
  DEFAULT_INITIAL_REQUEST_SUBJECT,
  RenderedEmail,
  TemplateInvoiceData,
  TemplateRenderError,
  renderEmail,
  validateTemplate,
} from './templates';
import { isValidEmail } from './format';
import { createHash } from 'node:crypto';
import type { SendEmailParams, SendEmailResult } from './mailer';

// Minimal structural type for the Supabase PostgREST client we rely on.
export type DbClient = { from: (table: string) => any };

export interface EmailServiceDeps {
  db: DbClient;
  sendEmail: (params: SendEmailParams) => Promise<SendEmailResult>;
  isSmtpConfigured: () => boolean;
  firmIdentity: { fromAddress: string; replyTo?: string; firmContactNumber: string };
}

export interface InvoiceEmailContext {
  invoice: {
    id: string;
    invoice_number: string;
    amount: number;
    amount_paid: number;
    issue_date: string;
    due_date: string;
    status: string;
    notes: string | null;
    project_id: string;
    client_id: string;
  };
  client: { id: string; name: string; contact_person: string | null; email: string; phone: string | null };
  project: { id: string; name: string };
  template: { subject_template: string; body_template: string; version: number };
  templateData: TemplateInvoiceData;
  recipient: string;
}

export interface ServiceError {
  status: number;
  error: string;
}

export type ContextResult =
  | { ok: true; context: InvoiceEmailContext }
  | { ok: false; error: ServiceError };

const num = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

/** Loads the authoritative invoice/client/project/template context. */
export async function loadInvoiceEmailContext(
  deps: Pick<EmailServiceDeps, 'db' | 'firmIdentity'>,
  invoiceId: string
): Promise<ContextResult> {
  if (!invoiceId || typeof invoiceId !== 'string') {
    return { ok: false, error: { status: 400, error: 'An invoice ID is required' } };
  }

  const { data: invoice, error: invoiceError } = await deps.db
    .from('invoices')
    .select('*')
    .eq('id', invoiceId)
    .maybeSingle();

  if (invoiceError || !invoice) {
    return { ok: false, error: { status: 404, error: 'Invoice not found' } };
  }
  if (invoice.status === 'cancelled') {
    return { ok: false, error: { status: 422, error: 'This invoice is cancelled — billing emails cannot be sent for it' } };
  }

  const [{ data: client }, { data: project }] = await Promise.all([
    deps.db.from('clients').select('*').eq('id', invoice.client_id).maybeSingle(),
    deps.db.from('projects').select('id, name').eq('id', invoice.project_id).maybeSingle(),
  ]);

  if (!client) {
    return { ok: false, error: { status: 422, error: 'The client linked to this invoice could not be loaded' } };
  }
  if (!project) {
    return { ok: false, error: { status: 422, error: 'The project linked to this invoice could not be loaded' } };
  }

  const recipient = (client.email || '').trim();
  if (!isValidEmail(recipient)) {
    return {
      ok: false,
      error: { status: 422, error: 'The client does not have a valid email address on file. Update the client record first.' },
    };
  }

  const { data: templateRow } = await deps.db
    .from('email_templates')
    .select('subject_template, body_template, version')
    .eq('template_type', 'initial_request')
    .eq('active', true)
    .maybeSingle();

  const template = templateRow || {
    subject_template: DEFAULT_INITIAL_REQUEST_SUBJECT,
    body_template: DEFAULT_INITIAL_REQUEST_BODY,
    version: 1,
  };

  const templateData: TemplateInvoiceData = {
    clientContactPerson: client.contact_person,
    clientCompanyName: client.name,
    projectName: project.name,
    invoiceNumber: invoice.invoice_number,
    issueDate: invoice.issue_date,
    invoiceAmount: num(invoice.amount),
    amountPaid: num(invoice.amount_paid),
    dueDate: invoice.due_date,
    invoiceNotes: invoice.notes,
    firmEmail: deps.firmIdentity.replyTo || deps.firmIdentity.fromAddress,
    firmContactNumber: deps.firmIdentity.firmContactNumber,
  };

  return {
    ok: true,
    context: {
      invoice: { ...invoice, amount: num(invoice.amount), amount_paid: num(invoice.amount_paid) },
      client,
      project,
      template: {
        subject_template: template.subject_template,
        body_template: template.body_template,
        version: num(template.version) || 1,
      },
      templateData,
      recipient,
    },
  };
}

export interface SendRequestForPaymentInput {
  invoiceId: string;
  /** Founder-edited subject template (placeholders allowed). */
  subjectTemplate?: string;
  /** Founder-edited body template (placeholders allowed). */
  bodyTemplate?: string;
  /** Unique key per confirmed attempt; repeats never send twice. */
  idempotencyKey: string;
  sentBy: string;
  /** Optional for compatibility with already-open older clients. */
  previewFingerprint?: string;
}

export type SendRequestForPaymentResult =
  | {
      ok: true;
      status: 'accepted' | 'failed' | 'unconfirmed';
      logId: string;
      logUpdateFailed?: boolean;
      providerMessageId?: string;
      /** Present when this key was already processed — nothing was re-sent. */
      duplicate?: boolean;
      error?: string;
    }
  | { ok: false; error: ServiceError };

function renderWithTemplates(
  context: InvoiceEmailContext,
  subjectTemplate: string,
  bodyTemplate: string
): { rendered: RenderedEmail } | { failure: ServiceError } {
  const validation = validateTemplate(subjectTemplate, bodyTemplate);
  if (!validation.valid) {
    return {
      failure: {
        status: 422,
        error: `The message contains unsupported placeholders: ${validation.unknownPlaceholders.join(', ')}`,
      },
    };
  }

  try {
    return { rendered: renderEmail(subjectTemplate, bodyTemplate, context.templateData) };
  } catch (error) {
    if (error instanceof TemplateRenderError) {
      return { failure: { status: 422, error: error.message } };
    }
    return { failure: { status: 500, error: 'Failed to render the email template' } };
  }
}

/** Detect changes to the reviewed recipient, invoice details or rendered message.
 * This is a best-effort check immediately before dispatch, not a database lock. */
export function emailPreviewFingerprint(context: InvoiceEmailContext, rendered: RenderedEmail): string {
  return createHash('sha256').update(JSON.stringify({
    invoiceId: context.invoice.id,
    invoiceStatus: context.invoice.status,
    recipient: context.recipient,
    data: context.templateData,
    subject: rendered.subject,
    bodyText: rendered.bodyText,
    bodyHtml: rendered.bodyHtml,
  })).digest('hex');
}

/** Renders a preview without sending (used by the Founder preview modal). */
export async function previewRequestForPayment(
  deps: Pick<EmailServiceDeps, 'db' | 'firmIdentity'>,
  input: { invoiceId: string; subjectTemplate?: string; bodyTemplate?: string }
): Promise<
  | { ok: true; context: InvoiceEmailContext; rendered: RenderedEmail }
  | { ok: false; error: ServiceError }
> {
  const contextResult = await loadInvoiceEmailContext(deps, input.invoiceId);
  if (!contextResult.ok) return contextResult;

  const context = contextResult.context;
  const subjectTemplate = input.subjectTemplate ?? context.template.subject_template;
  const bodyTemplate = input.bodyTemplate ?? context.template.body_template;

  const outcome = renderWithTemplates(context, subjectTemplate, bodyTemplate);
  if ('failure' in outcome) return { ok: false, error: outcome.failure };

  return { ok: true, context, rendered: outcome.rendered };
}

/**
 * Sends the Request for Payment:
 * 1. loads authoritative data server-side,
 * 2. renders exact plain-text + HTML snapshots,
 * 3. creates a `pending` email_logs row keyed by the idempotency key
 *    (duplicate keys short-circuit and never send twice),
 * 4. dispatches via SMTP and records `accepted` or `failed`.
 */
export async function sendRequestForPayment(
  deps: EmailServiceDeps,
  input: SendRequestForPaymentInput
): Promise<SendRequestForPaymentResult> {
  if (!input.idempotencyKey || input.idempotencyKey.length < 8) {
    return { ok: false, error: { status: 400, error: 'A unique idempotency key is required for every confirmed send' } };
  }
  if (!deps.isSmtpConfigured()) {
    return {
      ok: false,
      error: { status: 503, error: 'SMTP is not configured on the server. Add the SMTP environment variables before sending emails.' },
    };
  }

  const contextResult = await loadInvoiceEmailContext(deps, input.invoiceId);
  if (!contextResult.ok) return contextResult;
  const context = contextResult.context;

  const subjectTemplate = input.subjectTemplate ?? context.template.subject_template;
  const bodyTemplate = input.bodyTemplate ?? context.template.body_template;
  const outcome = renderWithTemplates(context, subjectTemplate, bodyTemplate);
  if ('failure' in outcome) return { ok: false, error: outcome.failure };
  const { rendered } = outcome;

  // Idempotency: if this key was already recorded, return the prior outcome.
  const { data: existing } = await deps.db
    .from('email_logs')
    .select('id, status, provider_message_id, error_message')
    .eq('idempotency_key', input.idempotencyKey)
    .maybeSingle();

  if (existing) {
    return {
      ok: true,
      status: existing.status === 'accepted' || existing.status === 'delivered' ? 'accepted' : existing.status === 'pending' ? 'unconfirmed' : 'failed',
      logId: existing.id,
      providerMessageId: existing.provider_message_id || undefined,
      duplicate: true,
      error: existing.error_message || undefined,
    };
  }

  if (input.previewFingerprint && input.previewFingerprint !== emailPreviewFingerprint(context, rendered)) {
    return { ok: false, error: { status: 409, error: 'The invoice, recipient, or message has changed. Update the preview and confirm it again before sending.' } };
  }

  // 1. Create the pending log BEFORE sending (exact snapshots included).
  const { data: pendingLog, error: insertError } = await deps.db
    .from('email_logs')
    .insert({
      invoice_id: context.invoice.id,
      recipient: context.recipient,
      subject: rendered.subject,
      body_text: rendered.bodyText,
      body_html: rendered.bodyHtml,
      template_type: 'initial_request',
      template_version: context.template.version,
      status: 'pending',
      sent_by: input.sentBy,
      idempotency_key: input.idempotencyKey,
    })
    .select('id')
    .single();

  if (insertError || !pendingLog) {
    // A concurrent request with the same key may have won the unique race.
    const { data: raced } = await deps.db
      .from('email_logs')
      .select('id, status, provider_message_id, error_message')
      .eq('idempotency_key', input.idempotencyKey)
      .maybeSingle();
    if (raced) {
      return {
        ok: true,
        status: raced.status === 'accepted' || raced.status === 'delivered' ? 'accepted' : raced.status === 'pending' ? 'unconfirmed' : 'failed',
        logId: raced.id,
        providerMessageId: raced.provider_message_id || undefined,
        duplicate: true,
        error: raced.error_message || undefined,
      };
    }
    return { ok: false, error: { status: 500, error: 'Failed to record the email log before sending' } };
  }

  // 2. A timeout or thrown transport error may follow provider acceptance.
  // Keep the idempotency record pending and never automatically resend it.
  let sendResult: SendEmailResult;
  try {
    sendResult = await deps.sendEmail({
      to: context.recipient,
      subject: rendered.subject,
      text: rendered.bodyText,
      html: rendered.bodyHtml,
    });
  } catch {
    sendResult = { accepted: false, uncertain: true, error: 'Mail server acceptance was not confirmed.' };
  }
  const confirmedAccepted = sendResult?.accepted === true;
  const uncertain = !confirmedAccepted && sendResult?.uncertain !== false;
  const nowIso = new Date().toISOString();
  let logUpdateFailed = false;
  try {
    const { data: updatedLog, error } = await deps.db.from('email_logs').update(
      confirmedAccepted
        ? { status: 'accepted', provider_message_id: sendResult.providerMessageId || null, sent_at: nowIso }
        : uncertain
          ? { status: 'pending', error_message: sendResult?.error || 'Mail server acceptance was not confirmed.' }
          : { status: 'failed', error_message: sendResult?.error || 'Mail server rejected the message.' }
    ).eq('id', pendingLog.id).select('id').maybeSingle();
    logUpdateFailed = Boolean(error || !updatedLog);
  } catch { logUpdateFailed = true; }

  return {
    ok: true,
    status: confirmedAccepted ? 'accepted' : uncertain ? 'unconfirmed' : 'failed',
    logId: pendingLog.id,
    logUpdateFailed,
    providerMessageId: confirmedAccepted ? sendResult.providerMessageId : undefined,
    error: confirmedAccepted ? undefined : sendResult?.error,
  };
}
