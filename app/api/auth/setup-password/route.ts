import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { validatePasswordStrength } from '@/lib/users/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Completes first-login account setup (`POST /api/auth/setup-password`).
 *
 * When a Founder provisions an account with a temporary password,
 * `user_metadata.must_change_password` is set to `true`. On first login the
 * user calls this endpoint to set their own personal password and clear the
 * `must_change_password` flag.
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

  let body: { newPassword?: unknown } = {};
  try {
    body = (await request.json()) as { newPassword?: unknown };
  } catch {
    return NextResponse.json(
      { ok: false, error: 'Invalid JSON request body.' },
      { status: 400, headers: { 'Cache-Control': 'private, no-store' } }
    );
  }

  const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
  const validation = validatePasswordStrength(newPassword);
  if (!validation.valid) {
    return NextResponse.json(
      { ok: false, error: validation.error || 'Password is too weak.' },
      { status: 400, headers: { 'Cache-Control': 'private, no-store' } }
    );
  }

  const { error: updateError } = await supabase.auth.updateUser({
    password: newPassword,
    data: {
      ...(user.user_metadata || {}),
      must_change_password: false,
      password_changed_at: new Date().toISOString(),
    },
  });

  if (updateError) {
    return NextResponse.json(
      { ok: false, error: updateError.message || 'Could not update your password.' },
      { status: 400, headers: { 'Cache-Control': 'private, no-store' } }
    );
  }

  return NextResponse.json(
    { ok: true },
    { status: 200, headers: { 'Cache-Control': 'private, no-store' } }
  );
}
