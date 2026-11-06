import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { requireFounder } from '@/lib/auth/serverRole';
import { getFirmEmailIdentity } from '@/lib/email/mailer';
import { emailPreviewFingerprint, previewRequestForPayment } from '@/lib/email/service';
import {
  SAMPLE_TEMPLATE_DATA,
  DEFAULT_INITIAL_REQUEST_BODY,
  DEFAULT_INITIAL_REQUEST_SUBJECT,
  TemplateRenderError,
  renderEmail,
  validateTemplate,
} from '@/lib/email/templates';
import { enforceRateLimit } from '@/lib/api/rateLimitGuard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Founder-only server-side email preview.
 *
 * With an invoiceId: renders against the authoritative invoice data.
 * Without: renders against safe sample data (used by the template editor).
 * Rendering always happens on the server so the browser never assembles
 * financial HTML itself.
 */
export async function POST(req: NextRequest) {
  try {
    const supabase = createServerSupabaseClient();
    const founder = await requireFounder(supabase);
    if (!founder.ok) {
      return NextResponse.json({ error: founder.error }, { status: founder.status });
    }

    const limited = enforceRateLimit('emailPreview', req.headers, founder.userId);
    if (limited) return limited;

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const subjectTemplate =
      typeof body.subjectTemplate === 'string' ? body.subjectTemplate : undefined;
    const bodyTemplate = typeof body.bodyTemplate === 'string' ? body.bodyTemplate : undefined;
    const identity = getFirmEmailIdentity();

    // Sample-data preview (template editor without a selected invoice).
    if (!body.invoiceId) {
      const subject = subjectTemplate ?? DEFAULT_INITIAL_REQUEST_SUBJECT;
      const template = bodyTemplate ?? DEFAULT_INITIAL_REQUEST_BODY;
      const validation = validateTemplate(subject, template);
      if (!validation.valid) {
        return NextResponse.json(
          {
            error: `Unsupported placeholders: ${validation.unknownPlaceholders.join(', ')}`,
            unknownPlaceholders: validation.unknownPlaceholders,
          },
          { status: 422 }
        );
      }
      try {
        const rendered = renderEmail(subject, template, {
          ...SAMPLE_TEMPLATE_DATA,
          firmEmail: identity.replyTo || identity.fromAddress || SAMPLE_TEMPLATE_DATA.firmEmail,
          firmContactNumber: identity.firmContactNumber || SAMPLE_TEMPLATE_DATA.firmContactNumber,
        });
        return NextResponse.json({
          sample: true,
          subject: rendered.subject,
          bodyText: rendered.bodyText,
          bodyHtml: rendered.bodyHtml,
          warnings: rendered.validation.missingImportantPlaceholders,
        });
      } catch (error) {
        const message =
          error instanceof TemplateRenderError ? error.message : 'Failed to render the preview';
        return NextResponse.json({ error: message }, { status: 422 });
      }
    }

    const result = await previewRequestForPayment(
      { db: supabase, firmIdentity: identity },
      {
        invoiceId: String(body.invoiceId),
        subjectTemplate,
        bodyTemplate,
      }
    );

    if (!result.ok) {
      return NextResponse.json({ error: result.error.error }, { status: result.error.status });
    }

    const { context, rendered } = result;
    return NextResponse.json({
      sample: false,
      previewFingerprint: emailPreviewFingerprint(context, rendered),
      subject: rendered.subject,
      bodyText: rendered.bodyText,
      bodyHtml: rendered.bodyHtml,
      warnings: rendered.validation.missingImportantPlaceholders,
      invoice: {
        id: context.invoice.id,
        invoiceNumber: context.invoice.invoice_number,
        issueDate: context.invoice.issue_date,
        dueDate: context.invoice.due_date,
        amount: context.invoice.amount,
        amountPaid: context.invoice.amount_paid,
        outstandingBalance: Math.max(0, context.invoice.amount - context.invoice.amount_paid),
        status: context.invoice.status,
      },
      client: {
        name: context.client.name,
        contactPerson: context.client.contact_person,
        email: context.recipient,
      },
      project: { name: context.project.name },
      template: {
        subjectTemplate: subjectTemplate ?? context.template.subject_template,
        bodyTemplate: bodyTemplate ?? context.template.body_template,
        version: context.template.version,
      },
    });
  } catch {
    return NextResponse.json({ error: 'Failed to build the email preview' }, { status: 500 });
  }
}
