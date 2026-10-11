import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createServiceRoleClient, isServiceRoleConfigured } from '@/lib/supabase/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Allows an authenticated Founder or Site Supervisor to register a new site
 * worker (`POST /api/workers`) so newly arrived craftsmen can immediately be
 * added to the daily attendance roster.
 *
 * Editing wage rates or deactivating workers remains restricted to Founders
 * via PostgreSQL RLS on `public.workers`.
 */
export async function POST(request: NextRequest) {
  const supabase = createServerSupabaseClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json(
      { ok: false, error: 'Authentication required.' },
      { status: 401, headers: { 'Cache-Control': 'private, no-store' } }
    );
  }

  const { data: profile } = await supabase
    .from('users')
    .select('id, role, email')
    .eq('id', user.id)
    .maybeSingle();

  if (!profile || (profile.role !== 'founder' && profile.role !== 'supervisor')) {
    return NextResponse.json(
      { ok: false, error: 'Valid BALE account required.' },
      { status: 403, headers: { 'Cache-Control': 'private, no-store' } }
    );
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { ok: false, error: 'Invalid JSON request body.' },
      { status: 400, headers: { 'Cache-Control': 'private, no-store' } }
    );
  }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const contactNumber = typeof body.contact_number === 'string' ? body.contact_number.trim() : '';
  const position = typeof body.position === 'string' ? body.position.trim() : '';
  const payRate = Number(body.pay_rate);
  const payRateType = body.pay_rate_type === 'hourly' ? 'hourly' : 'daily';

  if (!name || name.length < 2) {
    return NextResponse.json(
      { ok: false, error: 'Worker full name is required.' },
      { status: 400, headers: { 'Cache-Control': 'private, no-store' } }
    );
  }

  if (!position) {
    return NextResponse.json(
      { ok: false, error: 'Craft / position is required (e.g. Mason, Carpenter, Foreman).' },
      { status: 400, headers: { 'Cache-Control': 'private, no-store' } }
    );
  }

  if (!Number.isFinite(payRate) || payRate < 0) {
    return NextResponse.json(
      { ok: false, error: 'A valid non-negative pay rate is required.' },
      { status: 400, headers: { 'Cache-Control': 'private, no-store' } }
    );
  }

  const insertPayload = {
    name,
    contact_number: contactNumber || '—',
    position,
    pay_rate: payRate,
    pay_rate_type: payRateType,
    active: true,
  };

  // Founders have direct RLS INSERT permission on `public.workers`; Supervisors
  // use the service-role client on the server when registering a worker on-site.
  const dbClient =
    profile.role === 'founder' || !isServiceRoleConfigured()
      ? supabase
      : createServiceRoleClient();

  const { data: created, error: insertError } = await dbClient
    .from('workers')
    .insert(insertPayload)
    .select()
    .single();

  if (insertError || !created) {
    return NextResponse.json(
      {
        ok: false,
        error:
          insertError?.message ||
          'Could not register worker. Ensure SUPABASE_SERVICE_ROLE_KEY is configured for Supervisor worker registration.',
      },
      { status: 400, headers: { 'Cache-Control': 'private, no-store' } }
    );
  }

  return NextResponse.json(
    { ok: true, worker: created },
    { status: 201, headers: { 'Cache-Control': 'private, no-store' } }
  );
}
