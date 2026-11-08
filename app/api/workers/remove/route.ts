import { NextRequest, NextResponse } from 'next/server';
import { requireFounder } from '@/lib/auth/serverRole';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createServiceRoleClient, isServiceRoleConfigured } from '@/lib/supabase/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const unconfirmed = 'Change was not confirmed. Refresh the roster and check before trying again.';

export async function POST(request: NextRequest) {
  const founder = await requireFounder(createServerSupabaseClient());
  if (!founder.ok || !founder.userId) return NextResponse.json({ ok: false, error: founder.error || 'Founder access required.' }, { status: founder.status, headers });
  if (!isServiceRoleConfigured()) return NextResponse.json({ ok: false, error: 'Worker removal is not available right now.' }, { status: 503, headers });
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ ok: false, error: 'Invalid request.' }, { status: 400, headers }); }
  const ids = (body as { ids?: unknown } | null)?.ids;
  const action = (body as { action?: unknown } | null)?.action;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 100 || ids.some((id) => typeof id !== 'string' || !uuid.test(id)) || new Set(ids.map((id) => id.toLowerCase())).size !== ids.length || (action !== 'remove' && action !== 'restore')) {
    return NextResponse.json({ ok: false, error: 'Select between 1 and 100 distinct workers and a valid action.' }, { status: 400, headers });
  }
  const normalizedIds: string[] = ids.map((id) => id.toLowerCase());
  try {
    const { data, error } = await createServiceRoleClient().rpc('set_workers_removed_guarded', { p_actor: founder.userId, p_ids: normalizedIds, p_remove: action === 'remove' });
    const results = data?.results;
    const statuses = action === 'remove' ? ['removed','already_removed','missing'] : ['restored','already_available','missing'];
    const valid = Array.isArray(results) && results.length === ids.length && results.every((item: {id?: unknown; status?: unknown}) =>
      typeof item.id === 'string' && normalizedIds.includes(item.id) && statuses.includes(String(item.status))) && new Set(results.map((item: {id:string}) => item.id)).size === ids.length;
    if (error || !valid) return NextResponse.json({ ok: false, error: unconfirmed }, { status: 503, headers });
    return NextResponse.json({ ok: true, results }, { headers });
  } catch {
    return NextResponse.json({ ok: false, error: unconfirmed }, { status: 503, headers });
  }
}
