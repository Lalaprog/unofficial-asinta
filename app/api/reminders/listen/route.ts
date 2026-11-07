import { NextRequest, NextResponse } from 'next/server';
import { requireFounder } from '@/lib/auth/serverRole';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { runCoordinatedReminderScan } from '@/lib/reminders/runCoordinatedScan';

export const runtime='nodejs';
export const dynamic='force-dynamic';

/** Called only by an open Founder session. Never falls back to legacy sending. */
export async function POST(req:NextRequest) {
  // A cross-origin HTML form cannot set this header/content type; browsers must
  // preflight cross-origin requests and this endpoint does not grant CORS.
  if(req.headers.get('x-bale-reminder-listener')!=='1' || req.headers.get('content-type')!=='application/json' || req.headers.get('sec-fetch-site')==='cross-site') {
    return NextResponse.json({error:'Request refused.'},{status:403});
  }
  if(process.env.REMINDER_LISTENER_ENABLED!=='true')return NextResponse.json({ran:false,reason:'listener_disabled'});
  try {
    const founder=await requireFounder(createServerSupabaseClient());
    if(!founder.ok)return NextResponse.json({error:founder.error},{status:founder.status});
    const {body,status}=await runCoordinatedReminderScan();
    return NextResponse.json(body,{status,headers:{'Cache-Control':'no-store'}});
  } catch {
    return NextResponse.json({error:'Reminder check unavailable.'},{status:503,headers:{'Cache-Control':'no-store'}});
  }
}
