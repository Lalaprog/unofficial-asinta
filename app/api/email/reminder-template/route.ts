import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { requireFounder } from '@/lib/auth/serverRole';
import {
  DEFAULT_REMINDER_BODY,
  DEFAULT_REMINDER_SUBJECT,
  IMPORTANT_PLACEHOLDERS,
  REMINDER_EMAIL_TEMPLATE_TYPE,
  SUPPORTED_PLACEHOLDERS,
  validateReminderEmailTemplate,
} from '@/lib/email/templates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const defaults = { subject_template: DEFAULT_REMINDER_SUBJECT, body_template: DEFAULT_REMINDER_BODY };
const headers = { 'Cache-Control': 'private, no-store' };
const error = (message: string, status: number) => NextResponse.json({ error: message }, { status, headers });

/** This editor does not enable or send reminders. */
export async function GET() {
  try {
    const db = createServerSupabaseClient();
    const founder = await requireFounder(db);
    if (!founder.ok) return error(founder.error || 'Not authorized.', founder.status);

    const { data: row, error: readError } = await db.from('email_templates')
      .select('template_type,subject_template,body_template,version,active')
      .eq('template_type', REMINDER_EMAIL_TEMPLATE_TYPE).maybeSingle();
    if (readError) return error('Could not load the reminder email template.', 503);

    // Version zero is an unsaved default, not a database row.
    const template = row || { template_type: REMINDER_EMAIL_TEMPLATE_TYPE, ...defaults, version: 0, active: true };
    if (!validateReminderEmailTemplate(template.subject_template, template.body_template).valid) {
      return error('The saved reminder email needs attention. Contact the administrator.', 503);
    }
    return NextResponse.json({
      template,
      defaults,
      supportedPlaceholders: SUPPORTED_PLACEHOLDERS,
      importantPlaceholders: IMPORTANT_PLACEHOLDERS,
      isSystemDefault: template.subject_template === defaults.subject_template && template.body_template === defaults.body_template,
    }, { headers });
  } catch {
    return error('Could not load the reminder email template.', 503);
  }
}

export async function PUT(req: NextRequest) {
  try {
    const db = createServerSupabaseClient();
    const founder = await requireFounder(db);
    if (!founder.ok) return error(founder.error || 'Not authorized.', founder.status);

    const payload = await req.json().catch(() => null);
    const revision = payload?.version;
    if (!Number.isSafeInteger(revision) || revision < 0) return error('Refresh Settings before trying again.', 400);
    const subject = payload?.restore_default === true ? defaults.subject_template :
      typeof payload?.subject_template === 'string' ? payload.subject_template.trim() : '';
    const body = payload?.restore_default === true ? defaults.body_template :
      typeof payload?.body_template === 'string' ? payload.body_template.trim() : '';
    const validation = validateReminderEmailTemplate(subject, body);
    if (!validation.valid) return error('Check the subject, message and fields before saving.', 422);

    const values = {
      subject_template: subject, body_template: body, version: revision + 1,
      active: true, updated_by: founder.userId, updated_at: new Date().toISOString(),
    };
    if (revision === 0) {
      // template_type is unique; concurrent first saves cannot overwrite each other.
      const { error: insertError } = await db.from('email_templates')
        .insert({ template_type: REMINDER_EMAIL_TEMPLATE_TYPE, ...values });
      if (insertError) return error('Save was not confirmed. Refresh Settings before trying again.', 409);
    } else {
      const { data, error: updateError } = await db.from('email_templates').update(values)
        .eq('template_type', REMINDER_EMAIL_TEMPLATE_TYPE).eq('version', revision)
        .select('version').maybeSingle();
      if (updateError) return error('Save was not confirmed. Refresh Settings before trying again.', 503);
      if (!data) return error('This template changed elsewhere. Refresh Settings before saving again.', 409);
    }
    return NextResponse.json({ version: revision + 1, warnings: validation.missingImportantPlaceholders }, { headers });
  } catch {
    return error('Save was not confirmed. Refresh Settings before trying again.', 503);
  }
}
