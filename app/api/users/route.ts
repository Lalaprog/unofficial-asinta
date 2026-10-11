import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createServiceRoleClient, isServiceRoleConfigured } from '@/lib/supabase/admin';
import { requireFounder } from '@/lib/auth/serverRole';
import { isSmtpConfigured, sendEmail } from '@/lib/email/mailer';
import {
  createTeamAccount,
  deleteTeamAccount,
  updateTeamAccount,
} from '@/lib/users/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Founder-only team account provisioning (`POST /api/users`), role/site
 * management (`PATCH /api/users`), and deletion (`DELETE /api/users?id=<uuid>`).
 */
export async function POST(request: NextRequest) {
  const supabase = createServerSupabaseClient();
  const founder = await requireFounder(supabase);
  if (!founder.ok || !founder.userId) {
    return NextResponse.json(
      { ok: false, error: founder.error || 'This action is restricted to Founder accounts' },
      { status: founder.status, headers: { 'Cache-Control': 'private, no-store' } }
    );
  }

  if (!isServiceRoleConfigured()) {
    return NextResponse.json(
      {
        ok: false,
        error:
          'SUPABASE_SERVICE_ROLE_KEY is not configured on the server. Add it to your environment variables to create or delete auth accounts from BALE.',
      },
      { status: 503, headers: { 'Cache-Control': 'private, no-store' } }
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

  const adminClient = createServiceRoleClient();
  const outcome = await createTeamAccount({
    callerId: founder.userId,
    callerEmail: founder.userEmail,
    input: body,
    adminClient: adminClient as any,
    sendWelcomeMail: async ({ to, name, role, temporaryPassword }) => {
      if (!isSmtpConfigured()) {
        return {
          accepted: false,
          error:
            'SMTP is not configured on this server; copy the temporary password below and share it with the user directly.',
        };
      }
      const roleLabel = role === 'founder' ? 'Founder (Full Studio Ledger)' : 'Site Supervisor (Field Attendance & Assigned Projects)';
      const subject = 'Asinta Architects BALE — Your Account & Temporary Password';
      const text = [
        `Hello ${name},`,
        '',
        'An account has been created for you in the Asinta Architects BALE (Billing & Advance Ledger Engine) portal.',
        '',
        `Email: ${to}`,
        `Role: ${roleLabel}`,
        `Temporary Password: ${temporaryPassword}`,
        '',
        'When you sign in for the first time, BALE will ask you to replace this temporary password with your own personal password.',
        '',
        '— Asinta Architects Administration',
      ].join('\n');

      const html = `
        <div style="font-family: sans-serif; color: #0b1f3a; line-height: 1.5; max-width: 520px;">
          <h2 style="margin-bottom: 8px;">Asinta Architects — BALE Account Ready</h2>
          <p>Hello <strong>${name}</strong>,</p>
          <p>An account has been provisioned for you in the BALE portal:</p>
          <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 16px; margin: 16px 0;">
            <div><strong>Email:</strong> ${to}</div>
            <div><strong>Role:</strong> ${roleLabel}</div>
            <div style="margin-top: 8px;"><strong>Temporary Password:</strong> <code style="font-size: 14px; background: #fff; padding: 2px 6px; border: 1px solid #cbd5e1; border-radius: 4px;">${temporaryPassword}</code></div>
          </div>
          <p style="font-size: 13px; color: #475569;">
            When you sign in for the first time, you will be prompted to set your own personal password before accessing the workspace.
          </p>
        </div>
      `;

      return sendEmail({ to, subject, text, html });
    },
  });

  return NextResponse.json(outcome.body, {
    status: outcome.status,
    headers: { 'Cache-Control': 'private, no-store' },
  });
}

export async function PATCH(request: NextRequest) {
  const supabase = createServerSupabaseClient();
  const founder = await requireFounder(supabase);
  if (!founder.ok || !founder.userId) {
    return NextResponse.json(
      { ok: false, error: founder.error || 'This action is restricted to Founder accounts' },
      { status: founder.status, headers: { 'Cache-Control': 'private, no-store' } }
    );
  }

  if (!isServiceRoleConfigured()) {
    return NextResponse.json(
      {
        ok: false,
        error:
          'SUPABASE_SERVICE_ROLE_KEY is not configured on the server. Add it to your environment variables to manage team accounts.',
      },
      { status: 503, headers: { 'Cache-Control': 'private, no-store' } }
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

  const adminClient = createServiceRoleClient();
  const outcome = await updateTeamAccount({
    callerId: founder.userId,
    callerEmail: founder.userEmail,
    input: body,
    adminClient: adminClient as any,
  });

  return NextResponse.json(outcome.body, {
    status: outcome.status,
    headers: { 'Cache-Control': 'private, no-store' },
  });
}

export async function DELETE(request: NextRequest) {
  const supabase = createServerSupabaseClient();
  const founder = await requireFounder(supabase);
  if (!founder.ok || !founder.userId) {
    return NextResponse.json(
      { ok: false, error: founder.error || 'This action is restricted to Founder accounts' },
      { status: founder.status, headers: { 'Cache-Control': 'private, no-store' } }
    );
  }

  if (!isServiceRoleConfigured()) {
    return NextResponse.json(
      {
        ok: false,
        error:
          'SUPABASE_SERVICE_ROLE_KEY is not configured on the server. Add it to your environment variables to delete team accounts.',
      },
      { status: 503, headers: { 'Cache-Control': 'private, no-store' } }
    );
  }

  const targetUserId = request.nextUrl.searchParams.get('id') || '';
  const adminClient = createServiceRoleClient();
  const outcome = await deleteTeamAccount({
    callerId: founder.userId,
    callerEmail: founder.userEmail,
    targetUserId,
    adminClient: adminClient as any,
  });

  return NextResponse.json(outcome.body, {
    status: outcome.status,
    headers: { 'Cache-Control': 'private, no-store' },
  });
}
