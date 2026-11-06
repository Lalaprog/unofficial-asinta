import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { requireFounder } from '@/lib/auth/serverRole';
import { DEFAULT_SMS_TEMPLATE, SMS_FIELDS, validateSMSTemplate } from '@/lib/sms/templates';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  try {
    const db = createServerSupabaseClient(); const founder = await requireFounder(db);
    if (!founder.ok) return NextResponse.json({error: founder.error}, {status:founder.status});
    const {data, error} = await db.from('sms_template_settings').select('message_template,revision').eq('singleton',true).maybeSingle();
    if (error) return NextResponse.json({error:'Could not load the saved SMS template.'},{status:503});
    const template = data?.message_template ?? DEFAULT_SMS_TEMPLATE;
    if (!validateSMSTemplate(template).valid) return NextResponse.json({error:'The saved SMS template needs attention in Settings.'},{status:503});
    return NextResponse.json({template, revision:data?.revision ?? 0, fields:SMS_FIELDS}, {headers:{'Cache-Control':'no-store'}});
  } catch { return NextResponse.json({error:'Could not load the saved SMS template.'},{status:503}); }
}
export async function PUT(req: NextRequest) {
  try {
    const db = createServerSupabaseClient(); const founder = await requireFounder(db);
    if (!founder.ok) return NextResponse.json({error:founder.error},{status:founder.status});
    const payload = await req.json().catch(()=>null);
    const revision = payload?.revision;
    const template = payload?.restoreDefault === true ? DEFAULT_SMS_TEMPLATE : typeof payload?.template === 'string' ? payload.template.trim() : '';
    if (!Number.isSafeInteger(revision) || revision < 0 || !validateSMSTemplate(template).valid) return NextResponse.json({error:'Check the message and its fields before saving.'},{status:422});
    const values = {message_template:template, revision:revision+1, updated_by:founder.userId, updated_at:new Date().toISOString()};
    if (revision === 0) {
      const {error} = await db.from('sms_template_settings').insert({singleton:true,...values});
      if (error) return NextResponse.json({error:'Could not save the template. Refresh Settings before trying again.'},{status:409});
    } else {
      const {data, error} = await db.from('sms_template_settings').update(values).eq('singleton',true).eq('revision',revision).select('revision').maybeSingle();
      if (error) return NextResponse.json({error:'Could not save the template.'},{status:503});
      if (!data) return NextResponse.json({error:'The template changed elsewhere. Refresh Settings before saving again.'},{status:409});
    }
    return NextResponse.json({template, revision:revision+1, fields:SMS_FIELDS, warnings:validateSMSTemplate(template).missing},{headers:{'Cache-Control':'no-store'}});
  } catch { return NextResponse.json({error:'Could not save the SMS template.'},{status:503}); }
}
