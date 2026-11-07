import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { requireFounder } from '@/lib/auth/serverRole';
import {
  DEFAULT_INITIAL_REQUEST_BODY,
  DEFAULT_INITIAL_REQUEST_SUBJECT,
  EDITABLE_TEMPLATE_TYPES,
  IMPORTANT_PLACEHOLDERS,
  SUPPORTED_PLACEHOLDERS,
  validateTemplate,
  type EmailTemplateType,
} from '@/lib/email/templates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULTS: Record<string, { subject: string; body: string }> = {
  initial_request: {
    subject: DEFAULT_INITIAL_REQUEST_SUBJECT,
    body: DEFAULT_INITIAL_REQUEST_BODY,
  },
};

/** Founder-only: fetch the active template for a type (default: initial_request). */
async function getTemplate(req: NextRequest) {
  const supabase = createServerSupabaseClient();
  const founder = await requireFounder(supabase);
  if (!founder.ok) {
    return NextResponse.json({ error: founder.error }, { status: founder.status });
  }

  const templateType = req.nextUrl.searchParams.get('type') || 'initial_request';
  if (!EDITABLE_TEMPLATE_TYPES.includes(templateType as EmailTemplateType)) {
    return NextResponse.json({ error: 'This template type is not editable yet' }, { status: 400 });
  }

  const { data: row, error } = await supabase
    .from('email_templates')
    .select('id, template_type, subject_template, body_template, version, active, updated_at')
    .eq('template_type', templateType)
    .maybeSingle();
  if (error || (row !== null && (!row || typeof row !== 'object' || Array.isArray(row)))) {
    return NextResponse.json({ error: 'Could not load the saved email template.' }, { status: 503, headers: { 'Cache-Control': 'private, no-store' } });
  }
  if (row && (typeof row.id !== 'string' || typeof row.subject_template !== 'string' || typeof row.body_template !== 'string' || typeof row.active !== 'boolean' || !Number.isSafeInteger(row.version) || row.version < 1)) {
    return NextResponse.json({ error: 'The saved email template needs attention.' }, { status: 503, headers: { 'Cache-Control': 'private, no-store' } });
  }

  const defaults = DEFAULTS[templateType];
  return NextResponse.json({
    template: row || {
      id: null,
      template_type: templateType,
      subject_template: defaults.subject,
      body_template: defaults.body,
      version: 1,
      active: true,
    },
    defaults: { subject_template: defaults.subject, body_template: defaults.body },
    supportedPlaceholders: SUPPORTED_PLACEHOLDERS,
    importantPlaceholders: IMPORTANT_PLACEHOLDERS,
    isSystemDefault:
      !row ||
      (row.subject_template === defaults.subject && row.body_template === defaults.body),
  }, {headers: { 'Cache-Control': 'private, no-store' }});
}

export async function GET(req: NextRequest) {
  try { return await getTemplate(req); }
  catch { return NextResponse.json({ error: 'Could not load the saved email template.' }, { status: 503, headers: { 'Cache-Control': 'private, no-store' } }); }
}

/**
 * Founder-only: save a new template version, or restore the system default.
 * Every saved change increments `version`; historical email_logs snapshots
 * are never touched.
 */
export async function PUT(req: NextRequest) {
  try {
    const supabase = createServerSupabaseClient();
    const founder = await requireFounder(supabase);
    if (!founder.ok) {
      return NextResponse.json({ error: founder.error }, { status: founder.status });
    }

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const templateType: string = typeof body.template_type === 'string' ? body.template_type : 'initial_request';
    if (!EDITABLE_TEMPLATE_TYPES.includes(templateType as EmailTemplateType)) {
      return NextResponse.json({ error: 'This template type is not editable yet' }, { status: 400 });
    }

    const defaults = DEFAULTS[templateType];
    const restoreDefault = body.restore_default === true;
    const subjectTemplate: string = restoreDefault
      ? defaults.subject
      : typeof body.subject_template === 'string'
        ? body.subject_template.trim()
        : '';
    const bodyTemplate: string = restoreDefault
      ? defaults.body
      : typeof body.body_template === 'string'
        ? body.body_template.trim()
        : '';

    if (!subjectTemplate || !bodyTemplate) {
      return NextResponse.json({ error: 'Subject and body templates are required' }, { status: 400 });
    }
    if (subjectTemplate.length > 500 || bodyTemplate.length > 10000) {
      return NextResponse.json({ error: 'The template is too long' }, { status: 400 });
    }

    const validation = validateTemplate(subjectTemplate, bodyTemplate);
    if (!validation.valid) {
      return NextResponse.json(
        {
          error: `Unsupported placeholders: ${validation.unknownPlaceholders.join(', ')}`,
          unknownPlaceholders: validation.unknownPlaceholders,
        },
        { status: 422 }
      );
    }

    const { data: existing, error: readError } = await supabase
      .from('email_templates')
      .select('id, version')
      .eq('template_type', templateType)
      .maybeSingle();
    if (readError || (existing !== null && (!existing || typeof existing !== 'object' || Array.isArray(existing)))) {
      return NextResponse.json({ error: 'Could not check the saved email template. Refresh before trying again.' }, { status: 503 });
    }

    if (existing && (typeof existing.id !== 'string' || !Number.isSafeInteger(existing.version) || existing.version < 1)) {
      return NextResponse.json({ error: 'The saved email template needs attention.' }, { status: 503 });
    }
    // Newer editors submit the exact saved row they loaded. Keep older open
    // clients compatible; they still get the read-to-write race guard below.
    if ('expectedVersion' in body || 'expectedTemplateId' in body) {
      if (!Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 1 ||
          !(body.expectedTemplateId === null || (typeof body.expectedTemplateId === 'string' && body.expectedTemplateId.length > 0))) {
        return NextResponse.json({ error: 'Refresh the template before saving.' }, { status: 422 });
      }
      if (existing ? (existing.id !== body.expectedTemplateId || existing.version !== body.expectedVersion) : (body.expectedTemplateId !== null || body.expectedVersion !== 1)) {
        return NextResponse.json({ error: 'The template changed elsewhere. Refresh before saving again.' }, { status: 409 });
      }
    }
    const previousVersion = existing?.version;
    const expectedSavedVersion = existing ? previousVersion + 1 : 1;
    const nowIso = new Date().toISOString();
    let saved: { version: number } | null = null;

    if (existing) {
      const { data: updated, error: updateError } = await supabase
        .from('email_templates')
        .update({
          subject_template: subjectTemplate,
          body_template: bodyTemplate,
          version: expectedSavedVersion,
          active: true,
          updated_by: founder.userId,
          updated_at: nowIso,
        })
        .eq('id', existing.id)
        .eq('version', previousVersion)
        .select('version')
        .maybeSingle();
      if (updateError) {
        return NextResponse.json({ error: 'Save was not confirmed. Refresh the template before trying again.' }, { status: 503 });
      }
      if (!updated) return NextResponse.json({ error: 'The template changed elsewhere. Refresh before saving again.' }, { status: 409 });
      saved = updated;
    } else {
      const { data: inserted, error: insertError } = await supabase
        .from('email_templates')
        .insert({
          template_type: templateType,
          subject_template: subjectTemplate,
          body_template: bodyTemplate,
          version: 1,
          active: true,
          updated_by: founder.userId,
        })
        .select('version')
        .single();
      if (insertError || !inserted) {
        return NextResponse.json({ error: 'Save was not confirmed. Refresh the template before trying again.' }, { status: 503 });
      }
      saved = inserted;
    }

    if (!saved || saved.version !== expectedSavedVersion) {
      return NextResponse.json({ error: 'Save was not confirmed. Refresh the template before trying again.' }, { status: 503 });
    }
    return NextResponse.json({
      saved: true,
      restored: restoreDefault,
      version: saved.version,
      warnings: validation.missingImportantPlaceholders,
    });
  } catch {
    return NextResponse.json({ error: 'Save was not confirmed. Refresh the template before trying again.' }, { status: 503 });
  }
}
