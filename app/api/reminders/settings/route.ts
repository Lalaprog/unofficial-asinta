import { NextRequest, NextResponse } from 'next/server';
import { requireFounder } from '@/lib/auth/serverRole';
import { readReminderSettings, isReminderSettings } from '@/lib/reminders/settings';
import { createServerSupabaseClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const headers = { 'Cache-Control': 'private, no-store' };

export async function GET() {
  try {
    const db = createServerSupabaseClient();
    const founder = await requireFounder(db);
    if (!founder.ok) return NextResponse.json({ error: founder.error }, { status: founder.status, headers });
    const settings = await readReminderSettings(db);
    if (!settings) return NextResponse.json({ error: 'Reminder settings are unavailable.' }, { status: 503, headers });
    return NextResponse.json({ settings, rolloutReady: false }, { headers });
  } catch {
    return NextResponse.json({ error: 'Reminder settings are unavailable.' }, { status: 503, headers });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const db = createServerSupabaseClient();
    const founder = await requireFounder(db);
    if (!founder.ok) return NextResponse.json({ error: founder.error }, { status: founder.status, headers });
    const body = await req.json().catch(() => null);
    if (!body || typeof body.email_enabled !== 'boolean' || typeof body.sms_enabled !== 'boolean' ||
        body.master_enabled !== false || !Number.isSafeInteger(body.revision) || body.revision < 1) {
      return NextResponse.json({ error: 'Automatic reminders are not ready to turn on. Check your settings.' }, { status: 422, headers });
    }
    const { data, error } = await db.from('reminder_settings')
      .update({ master_enabled: false, email_enabled: body.email_enabled, sms_enabled: body.sms_enabled })
      .eq('singleton', true).eq('revision', body.revision)
      .select('master_enabled,email_enabled,sms_enabled,revision').maybeSingle();
    if (error) return NextResponse.json({ error: 'Could not save reminder settings.' }, { status: 503, headers });
    if (!data) return NextResponse.json({ error: 'Settings changed elsewhere. Refresh before saving again.' }, { status: 409, headers });
    if (!isReminderSettings(data) || data.master_enabled !== false) return NextResponse.json({ error: 'Could not confirm the saved settings.' }, { status: 503, headers });
    return NextResponse.json({ settings: data, rolloutReady: false }, { headers });
  } catch {
    return NextResponse.json({ error: 'Could not save reminder settings.' }, { status: 503, headers });
  }
}
