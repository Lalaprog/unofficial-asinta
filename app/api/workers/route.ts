import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createServiceRoleClient, isServiceRoleConfigured } from '@/lib/supabase/admin';
import { requireSessionAssurance } from '@/lib/auth/session-assurance';

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

  // This route can use service_role for Supervisors, bypassing RLS. Check the
  // caller's assurance first; an enrolled factor cannot be skipped.
  const assurance = await requireSessionAssurance(supabase);
  if (!assurance.ok) {
    return NextResponse.json({ ok: false, error: assurance.error }, {
      status: assurance.status, headers: { 'Cache-Control': 'private, no-store' },
    });
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

  const customId =
    typeof body.id === 'string' && /^[0-9a-f-]{36}$/i.test(body.id.trim())
      ? body.id.trim()
      : undefined;
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
    ...(customId ? { id: customId } : {}),
    name,
    contact_number: contactNumber || '—',
    position,
    pay_rate: payRate,
    pay_rate_type: payRateType,
    active: true,
  };

  // When deactivation is rolled out, the Supervisor's service-role insert
  // must recheck access under the same DB lock used by revocation. A missing
  // migration/service key never falls back to an unguarded insert.
  if (profile.role === 'supervisor' && process.env.TEAM_DEACTIVATION_ENABLED === 'true') {
    if (!isServiceRoleConfigured()) return NextResponse.json({ok:false,error:'Could not verify worker registration. Please try again.'},{status:503,headers:{'Cache-Control':'private, no-store'}});
    try {
      const id=customId || randomUUID();
      const {data,error}=await createServiceRoleClient().rpc('create_global_worker_guarded',{
        p_actor:user.id,p_worker:id,p_name:name,p_contact:contactNumber || '—',p_position:position,p_rate:payRate,p_rate_type:payRateType,
      });
      if(error || !data || data.id!==id) return NextResponse.json({ok:false,error:'Worker registration was not confirmed. Refresh and check the worker list before retrying.'},{status:error?.code==='42501'?403:503,headers:{'Cache-Control':'private, no-store'}});
      return NextResponse.json({ok:true,worker:data},{status:201,headers:{'Cache-Control':'private, no-store'}});
    } catch {return NextResponse.json({ok:false,error:'Worker registration was not confirmed. Refresh and check the worker list before retrying.'},{status:503,headers:{'Cache-Control':'private, no-store'}});}
  }

  // Founders have direct RLS INSERT permission on `public.workers`; Supervisors
  // use the service-role client on the server when registering a worker on-site.
  const dbClient =
    profile.role === 'founder' || !isServiceRoleConfigured()
      ? supabase
      : createServiceRoleClient();

  const { data: created, error: insertError } = await dbClient
    .from('workers')
    // Registration must not overwrite an existing worker via a supplied id.
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
