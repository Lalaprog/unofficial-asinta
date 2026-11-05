import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { requireSessionAssurance } from '@/lib/auth/session-assurance';
import { validatePasswordStrength } from '@/lib/users/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };

/** Optional password change for the current authenticated and MFA-complete user. */
export async function POST(request: NextRequest) {
  const supabase = createServerSupabaseClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) return NextResponse.json({ ok: false, error: 'Authentication required.' }, { status: 401, headers });
  const assurance = await requireSessionAssurance(supabase);
  if (!assurance.ok) return NextResponse.json({ ok: false, error: assurance.error }, { status: assurance.status, headers });
  let body: { newPassword?: unknown };
  try { body = await request.json(); } catch {
    return NextResponse.json({ ok: false, error: 'Invalid request.' }, { status: 400, headers });
  }
  const password = typeof body?.newPassword === 'string' ? body.newPassword : '';
  const validation = validatePasswordStrength(password);
  if (!validation.valid) return NextResponse.json({ ok: false, error: validation.error || 'Password is too weak.' }, { status: 400, headers });
  try {
    // A successful personal-password change also satisfies a pending
    // temporary-password requirement; skipping does not clear it.
    const { error: updateError } = await supabase.auth.updateUser({
      password,
      ...(user.user_metadata?.must_change_password === true ? {
        data: { ...user.user_metadata, must_change_password: false, password_changed_at: new Date().toISOString() },
      } : {}),
    });
    if (updateError) return NextResponse.json({ ok: false, error: 'Could not change your password. Please try again.' }, { status: 400, headers });
    return NextResponse.json({ ok: true }, { headers });
  } catch {
    return NextResponse.json({ ok: false, error: 'The password change could not be confirmed. Sign in again before retrying.' }, { status: 503, headers });
  }
}
