/**
 * Server-side team account provisioning, role/site assignment, and deletion.
 *
 * SECURITY INVARIANTS
 * -------------------
 * 1. Every route calling these helpers MUST verify `requireFounder()` first.
 * 2. Creating or deleting `auth.users` rows uses the Supabase service-role
 *    client (`lib/supabase/admin.ts`) on the server only — never in the browser.
 * 3. Temporary passwords are NEVER written to `public.audit_log` or application
 *    logs.
 * 4. New accounts provisioned with a temporary password have
 *    `user_metadata.must_change_password = true`, forcing the user to set their
 *    own personal password immediately upon first sign-in.
 * 5. Self-lockout protection: a Founder cannot delete their own active account,
 *    demote themselves to Supervisor, or delete the last Founder account.
 * 6. Referential integrity on delete: before removing a user from `public.users`,
 *    historical `attendance.recorded_by` and `expenses.created_by` references
 *    are nulled out so ledger history is never broken or cascade-deleted.
 */

import type { User, UserRole } from '@/types';

async function writeUserAuditEntry(
  adminClient: MinimalAdminSupabaseClient,
  entry: {
    actorId: string;
    actorEmail: string | null;
    action: 'insert' | 'update' | 'delete';
    recordId: string;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
  }
): Promise<{ ok: boolean; error?: string }> {
  try {
    const { error } = await adminClient.from('audit_log').insert({
      actor_id: entry.actorId,
      actor_email: entry.actorEmail,
      action: entry.action,
      table_name: 'users',
      record_id: entry.recordId,
      before_row: entry.before,
      after_row: entry.after,
    });
    if (error) {
      return { ok: false, error: error.message };
    }
    return { ok: true };
  } catch (caught) {
    return {
      ok: false,
      error: caught instanceof Error ? caught.message : 'Audit trail write failed',
    };
  }
}

// Follow-up calls happen after an account/profile change may have committed.
// Convert both API errors and transport exceptions into reviewable warnings.
async function mutationFailed(operation: () => PromiseLike<{ error: unknown }>): Promise<boolean> {
  try { return Boolean((await operation()).error); } catch { return true; }
}

export interface MinimalAdminSupabaseClient {
  auth: {
    admin: {
      createUser: (attributes: {
        email: string;
        password: string;
        email_confirm: boolean;
        user_metadata?: Record<string, unknown>;
      }) => Promise<{
        data: { user: { id: string; email?: string | null } | null };
        error: { message: string } | null;
      }>;
      updateUserById: (
        id: string,
        attributes: {
          password?: string;
          email?: string;
          user_metadata?: Record<string, unknown>;
        }
      ) => Promise<{
        data: { user: { id: string } | null };
        error: { message: string } | null;
      }>;
      deleteUser: (id: string) => Promise<{
        data: unknown;
        error: { message: string } | null;
      }>;
    };
  };
  from: (table: string) => any;
  rpc: (name: string, args: Record<string, unknown>) => PromiseLike<{ data: any; error: { message: string; code?: string } | null }>;
}

export interface CreateTeamAccountInput {
  name?: unknown;
  email?: unknown;
  role?: unknown;
  temporaryPassword?: unknown;
  assignedProjectIds?: unknown;
  sendWelcomeEmail?: unknown;
  includeInPayroll?: unknown;
  payRate?: unknown;
  payRateType?: unknown;
  contactNumber?: unknown;
}

export interface UpdateTeamAccountInput {
  userId?: unknown;
  name?: unknown;
  role?: unknown;
  assignedProjectIds?: unknown;
  resetTemporaryPassword?: unknown;
  includeInPayroll?: unknown;
  payRate?: unknown;
  payRateType?: unknown;
  contactNumber?: unknown;
}

export interface AdminActionOutcome<T = Record<string, unknown>> {
  status: number;
  body: {
    ok: boolean;
    error?: string;
  } & T;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Validates a user-chosen or temporary password:
 * - At least 8 characters
 * - At least one letter and one digit
 */
export function validatePasswordStrength(password: string): { valid: boolean; error?: string } {
  if (typeof password !== 'string' || password.length < 8) {
    return {
      valid: false,
      error: 'Password must be at least 8 characters long.',
    };
  }
  if (password.length > 128) {
    return {
      valid: false,
      error: 'Password must not exceed 128 characters.',
    };
  }
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    return {
      valid: false,
      error: 'Password must include at least one letter and one number.',
    };
  }
  return { valid: true };
}

/**
 * Generates an unambiguous temporary password suitable for sharing with a new
 * team member (avoids lookalike characters such as 0/O and 1/l/I).
 */
export function generateTemporaryPassword(): string {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnpqrstuvwxyz';
  const digits = '23456789';
  const all = upper + lower + digits;

  const pick = (charset: string): string => {
    if (typeof crypto === 'undefined' || typeof crypto.getRandomValues !== 'function') {
      throw new Error('Secure random password generation is unavailable. Use a secure browser or HTTPS.');
    }
    const buf = new Uint32Array(1);
    const limit = Math.floor(0x100000000 / charset.length) * charset.length;
    do { crypto.getRandomValues(buf); } while (buf[0] >= limit);
    return charset[buf[0] % charset.length];
  };

  const segment1 = [
    pick(upper),
    pick(lower),
    pick(lower),
    pick(digits),
  ].join('');
  const segment2 = [
    pick(upper),
    pick(lower),
    pick(digits),
    pick(all),
  ].join('');

  return `Asinta-${segment1}-${segment2}!`;
}

/** NUMERIC(10,2) payroll rate; zero is valid and invalid inputs are never defaulted. */
export function parseTeamPayRate(value: unknown): number | null {
  if (value === undefined) return 1200; // backward compatibility for older callers
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (typeof value === 'string' && !/^\d+(?:\.\d{1,2})?$/.test(value.trim())) return null;
  const rate = Number(value);
  return Number.isFinite(rate) && rate >= 0 && rate <= 99999999.99 &&
    Math.abs(rate * 100 - Math.round(rate * 100)) < 1e-5 ? rate : null;
}

function normalizeProjectIds(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  for (const item of input) {
    if (typeof item === 'string' && item.trim()) {
      seen.add(item.trim());
    }
  }
  return [...seen];
}

/**
 * Creates a new BALE account in both `auth.users` and `public.users`, assigns
 * supervisor project sites when applicable, and logs the action in `audit_log`.
 */
export async function createTeamAccount(params: {
  callerId: string;
  callerEmail?: string;
  input: CreateTeamAccountInput;
  adminClient: MinimalAdminSupabaseClient;
  sendWelcomeMail?: (mail: {
    to: string;
    name: string;
    role: UserRole;
    temporaryPassword: string;
  }) => Promise<{ accepted: boolean; error?: string }>;
}): Promise<
  AdminActionOutcome<{
    user?: User;
    assignedProjectIds?: string[];
    temporaryPassword?: string;
    emailSent?: boolean;
    emailNote?: string;
    auditWarning?: string;
    warnings?: string[];
  }>
> {
  const { callerId, callerEmail, input, adminClient, sendWelcomeMail } = params;

  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
  const role = input.role === 'founder' || input.role === 'supervisor' ? input.role : null;
  const rawTempPassword =
    typeof input.temporaryPassword === 'string' && input.temporaryPassword.trim()
      ? input.temporaryPassword.trim()
      : generateTemporaryPassword();
  const assignedProjectIds = role === 'supervisor' ? normalizeProjectIds(input.assignedProjectIds) : [];
  const shouldSendEmail = input.sendWelcomeEmail !== false;
  const warnings: string[] = [];
  const includeInPayroll = role === 'supervisor' && input.includeInPayroll !== false;
  const requestedRate = parseTeamPayRate(input.payRate);
  if (includeInPayroll && requestedRate === null) {
    return { status: 400, body: { ok: false, error: 'Enter a valid payroll rate from 0 to 99,999,999.99 with at most two decimal places.' } };
  }

  if (!name || name.length < 2) {
    return {
      status: 400,
      body: { ok: false, error: 'Full name is required (at least 2 characters).' },
    };
  }

  if (!email || !EMAIL_PATTERN.test(email)) {
    return {
      status: 400,
      body: { ok: false, error: 'A valid email address is required.' },
    };
  }

  if (!role) {
    return {
      status: 400,
      body: { ok: false, error: 'Role must be either "founder" or "supervisor".' },
    };
  }

  const passwordCheck = validatePasswordStrength(rawTempPassword);
  if (!passwordCheck.valid) {
    return {
      status: 400,
      body: { ok: false, error: passwordCheck.error || 'Temporary password is too weak.' },
    };
  }

  // 1. Check if email already exists in `public.users`.
  const { data: existingProfile } = await adminClient
    .from('users')
    .select('id, email')
    .eq('email', email)
    .maybeSingle();

  if (existingProfile) {
    return {
      status: 409,
      body: { ok: false, error: `An account with email ${email} already exists in BALE.` },
    };
  }

  // 2. Create user in Supabase Auth with `email_confirm: true` (avoids Supabase
  //    Free tier's 2–4/hr built-in email cap blocking onboarding) and
  //    `must_change_password: true` so the user is forced to set their own
  //    password on first login.
  const { data: createdAuth, error: authCreateError } = await adminClient.auth.admin.createUser({
    email,
    password: rawTempPassword,
    email_confirm: true,
    user_metadata: {
      name,
      role,
      must_change_password: true,
      provisioned_by: callerEmail || callerId,
    },
  });

  if (authCreateError || !createdAuth?.user?.id) {
    return {
      status: 400,
      body: {
        ok: false,
        error: authCreateError?.message || 'Could not create the account in Supabase Auth.',
      },
    };
  }

  const newUserId = createdAuth.user.id;

  // 3. Insert profile row into `public.users`.
  const { data: insertedUser, error: profileInsertError } = await adminClient
    .from('users')
    .insert({
      id: newUserId,
      name,
      email,
      role,
    })
    .select('id, name, email, role, created_at')
    .single();

  if (profileInsertError || !insertedUser) {
    // Roll back the orphaned auth.users row.
    const rollback = await adminClient.auth.admin.deleteUser(newUserId).catch(() => ({ data: null, error: { message: 'request failed' } }));
    return {
      status: 500,
      body: {
        ok: false,
        error: rollback.error
          ? 'The profile could not be created and Auth cleanup was not confirmed. Check Supabase Auth before retrying.'
          : 'Profile creation was not confirmed and the new Auth account was removed. Check for a remaining profile before retrying.',
      },
    };
  }

  // 4. Assign supervisor projects if applicable.
  if (role === 'supervisor' && assignedProjectIds.length > 0) {
    const supervisorRows = assignedProjectIds.map((projectId) => ({
      project_id: projectId,
      supervisor_id: newUserId,
    }));
    const failed = await mutationFailed(() => adminClient.from('project_supervisors').insert(supervisorRows));
    if (failed) warnings.push('Project assignments were not confirmed. Check the assigned sites before the user signs in.');
  }

  // 4b. Automatically provision a 1:1 linked `public.workers` row for every
  //     Supervisor (unless explicitly disabled via `includeInPayroll: false`)
  //     so they are automatically on the roster of the project sites they supervise.
  if (includeInPayroll) {
    const payRate = requestedRate ?? 1200;
    const payRateType = input.payRateType === 'hourly' ? 'hourly' : 'daily';
    const contactNumber =
      typeof input.contactNumber === 'string' && input.contactNumber.trim()
        ? input.contactNumber.trim()
        : '—';

    const workerFailed = await mutationFailed(() => adminClient.from('workers').upsert(
      {
        id: newUserId,
        name,
        contact_number: contactNumber,
        position: 'Site Supervisor',
        pay_rate: payRate,
        pay_rate_type: payRateType,
        active: true,
      },
      { onConflict: 'id' }
    ));
    if (workerFailed) warnings.push('Payroll roster entry was not confirmed. Check the worker record before running payroll.');
  }

  // 5. Write audit trail (never log the temporary password).
  const auditRes = await writeUserAuditEntry(adminClient, {
    actorId: callerId,
    actorEmail: callerEmail ?? null,
    action: 'insert',
    recordId: newUserId,
    before: null,
    after: {
      id: newUserId,
      name,
      email,
      role,
      assigned_project_ids_requested: assignedProjectIds,
      must_change_password: true,
    },
  });

  // 6. Optionally send welcome email with temporary password via firm SMTP.
  let emailSent = false;
  let emailNote: string | undefined;
  if (shouldSendEmail && sendWelcomeMail) {
    const mailOutcome = await sendWelcomeMail({
      to: email,
      name,
      role,
      temporaryPassword: rawTempPassword,
    }).catch(() => ({ accepted: false, error: 'Welcome email outcome is unconfirmed. Check your email provider before resending or sharing credentials.' }));
    emailSent = mailOutcome.accepted;
    emailNote = mailOutcome.accepted
      ? `Welcome email with temporary password accepted by SMTP for ${email}.`
      : mailOutcome.error || 'SMTP is not configured; share the temporary password directly with the team member.';
  } else {
    emailNote = 'Share the temporary password below with the team member. They will be prompted to set their own password on first sign-in.';
  }

  return {
    status: 201,
    body: {
      ok: true,
      user: insertedUser as User,
      assignedProjectIds,
      temporaryPassword: rawTempPassword,
      emailSent,
      emailNote,
      ...(auditRes.ok ? {} : { auditWarning: auditRes.error }),
      ...(warnings.length ? { warnings } : {}),
    },
  };
}

/**
 * Updates an existing team member's name, role, project assignments, or resets
 * their temporary password.
 */
export async function updateTeamAccount(params: {
  callerId: string;
  callerEmail?: string;
  input: UpdateTeamAccountInput;
  adminClient: MinimalAdminSupabaseClient;
}): Promise<
  AdminActionOutcome<{
    user?: User;
    assignedProjectIds?: string[];
    temporaryPassword?: string;
    warnings?: string[];
    auditWarning?: string;
  }>
> {
  const { callerId, callerEmail, input, adminClient } = params;

  const targetUserId = typeof input.userId === 'string' ? input.userId.trim() : '';
  if (!targetUserId) {
    return { status: 400, body: { ok: false, error: 'Target userId is required.' } };
  }

  const { data: beforeUser, error: fetchError } = await adminClient
    .from('users')
    .select('id, name, email, role, created_at')
    .eq('id', targetUserId)
    .maybeSingle();

  if (fetchError || !beforeUser) {
    return { status: 404, body: { ok: false, error: 'Team account not found.' } };
  }

  if (input.name !== undefined && (typeof input.name !== 'string' || input.name.trim().length < 2)) {
    return { status: 400, body: { ok: false, error: 'Full name is required (at least 2 characters).' } };
  }
  const nextName =
    typeof input.name === 'string' && input.name.trim().length >= 2
      ? input.name.trim()
      : beforeUser.name;
  const nextRole: UserRole =
    input.role === 'founder' || input.role === 'supervisor' ? input.role : beforeUser.role;

  // Prevent a Founder from demoting their own active session.
  if (callerId === targetUserId && nextRole !== 'founder') {
    return {
      status: 400,
      body: {
        ok: false,
        error: 'You cannot demote your own Founder account while signed in.',
      },
    };
  }

  // If demoting another Founder, ensure at least one Founder remains.
  if (beforeUser.role === 'founder' && nextRole !== 'founder') {
    const { data: founders } = await adminClient
      .from('users')
      .select('id')
      .eq('role', 'founder');
    if (!Array.isArray(founders) || founders.length <= 1) {
      return {
        status: 400,
        body: {
          ok: false,
          error: 'Cannot demote the last Founder account in BALE.',
        },
      };
    }
  }

  let resetPasswordValue: string | undefined;
  if (typeof input.resetTemporaryPassword === 'string' && input.resetTemporaryPassword.trim()) {
    const candidate = input.resetTemporaryPassword.trim();
    const check = validatePasswordStrength(candidate);
    if (!check.valid) {
      return {
        status: 400,
        body: { ok: false, error: check.error || 'Temporary password is too weak.' },
      };
    }
    resetPasswordValue = candidate;
  }

  const warnings: string[] = [];
  const requestedRate = parseTeamPayRate(input.payRate);
  if (nextRole === 'supervisor' && input.includeInPayroll !== false && requestedRate === null) {
    return { status: 400, body: { ok: false, error: 'Enter a valid payroll rate from 0 to 99,999,999.99 with at most two decimal places.' } };
  }

  // The database re-checks actor and last-Founder invariants under a
  // transaction lock. Missing migration or an unconfirmed result fails closed.
  let updateResult: Awaited<ReturnType<MinimalAdminSupabaseClient['rpc']>>;
  try {
    updateResult = await adminClient.rpc('update_team_profile_guarded', {
      p_actor: callerId, p_target: targetUserId, p_name: nextName, p_role: nextRole,
    });
  } catch {
    return { status: 500, body: { ok: false, error: 'Profile update not confirmed. Refresh and check the account before retrying; Auth was not updated.' } };
  }
  const { data: updatedUser, error: updateError } = updateResult;
  if (updateError || !updatedUser || updatedUser.id !== targetUserId) {
    return { status: 500, body: { ok: false, error: `Profile update not confirmed: ${updateError?.message || 'unexpected database response'}. Refresh and check the account before retrying.` } };
  }

  // Update `auth.users` metadata (and temporary password if requested).
  const authUpdate = await adminClient.auth.admin.updateUserById(targetUserId, {
    ...(resetPasswordValue ? { password: resetPasswordValue } : {}),
    user_metadata: {
      name: nextName,
      role: nextRole,
      ...(resetPasswordValue ? { must_change_password: true } : {}),
    },
  }).catch(() => ({ data: { user: null }, error: { message: 'request failed' } }));
  const authUpdateConfirmed = !authUpdate.error && Boolean(authUpdate.data?.user);
  if (!authUpdateConfirmed) warnings.push(resetPasswordValue
    ? 'Auth update and password reset were not confirmed. Do not share the proposed password; check Supabase Auth before retrying.'
    : 'Auth metadata update was not confirmed. Check Supabase Auth and the profile before retrying.');

  // Replace project assignments in a single database transaction. A failed or
  // lost response is unconfirmed; never attempt a separate delete/insert.
  let assignedProjectIds: string[] | undefined;
  if (Array.isArray(input.assignedProjectIds) || nextRole === 'founder') {
    const requested = nextRole === 'supervisor' ? normalizeProjectIds(input.assignedProjectIds) : [];
    if (nextRole === 'supervisor') {
      try {
        const result = await adminClient.rpc('replace_supervisor_projects_guarded', {
          p_actor: callerId, p_target: targetUserId, p_projects: requested,
        });
        if (result.error || !result.data || result.data.project_count !== requested.length) {
          warnings.push('Project assignments were not confirmed. Refresh and check assigned sites before retrying.');
        } else {
          assignedProjectIds = requested;
        }
      } catch {
        warnings.push('Project assignments were not confirmed. Refresh and check assigned sites before retrying.');
      }
    } else {
      // A Founder cannot retain Supervisor project access. Existing account
      // role-change behavior is unchanged; this separate cleanup is reported.
      const error = await mutationFailed(() => adminClient.from('project_supervisors').delete().eq('supervisor_id', targetUserId));
      if (error) warnings.push('Removing old project assignments was not confirmed. Check assigned sites.');
      else assignedProjectIds = [];
    }
  }

  // Sync 1:1 linked `public.workers` profile for Supervisor attendance & payroll.
  if (nextRole === 'supervisor' && input.includeInPayroll !== false) {
    const payRate = requestedRate ?? 1200;
    const payRateType = input.payRateType === 'hourly' ? 'hourly' : 'daily';
    const contactNumber =
      typeof input.contactNumber === 'string' && input.contactNumber.trim()
        ? input.contactNumber.trim()
        : '—';

    const workerFailed = await mutationFailed(() => adminClient.from('workers').upsert(
      {
        id: targetUserId,
        name: nextName,
        contact_number: contactNumber,
        position: 'Site Supervisor',
        pay_rate: payRate,
        pay_rate_type: payRateType,
        active: true,
      },
      { onConflict: 'id' }
    ));
    if (workerFailed) warnings.push('Payroll roster update was not confirmed. Check the worker record before running payroll.');
  } else if (nextRole === 'founder' || input.includeInPayroll === false) {
    const workerFailed = await mutationFailed(() => adminClient
      .from('workers')
      .update({ active: false })
      .eq('id', targetUserId));
    if (workerFailed) warnings.push('Payroll roster deactivation was not confirmed. Check the worker record before running payroll.');
  }

  const auditRes = await writeUserAuditEntry(adminClient, {
    actorId: callerId,
    actorEmail: callerEmail ?? null,
    action: 'update',
    recordId: targetUserId,
    before: beforeUser as Record<string, unknown>,
    after: {
      ...(updatedUser as Record<string, unknown>),
      ...(assignedProjectIds ? { assigned_project_ids_requested: assignedProjectIds } : {}),
      ...(resetPasswordValue && authUpdateConfirmed ? { password_reset_to_temporary: true } : {}),
    },
  });

  return {
    status: 200,
    body: {
      ok: true,
      user: updatedUser as User,
      ...(assignedProjectIds ? { assignedProjectIds } : {}),
      ...(resetPasswordValue && authUpdateConfirmed ? { temporaryPassword: resetPasswordValue } : {}),
      ...(warnings.length ? { warnings } : {}),
      ...(auditRes.ok ? {} : { auditWarning: auditRes.error }),
    },
  };
}

/**
 * Deletes a team account safely:
 * 1. Blocks self-deletion and deleting the last Founder.
 * 2. Detaches `attendance.recorded_by` and `expenses.created_by` foreign keys
 *    so historical ledger rows remain intact.
 * 3. Deletes `public.users` and `auth.users` rows and writes an `audit_log` entry.
 */
export async function deleteTeamAccount(params: {
  callerId: string;
  callerEmail?: string;
  targetUserId: string;
  adminClient: MinimalAdminSupabaseClient;
}): Promise<AdminActionOutcome<{ deletedUserId?: string; auditWarning?: string }>> {
  const { callerId, callerEmail, targetUserId, adminClient } = params;

  const cleanTargetId = typeof targetUserId === 'string' ? targetUserId.trim() : '';
  if (!cleanTargetId) {
    return { status: 400, body: { ok: false, error: 'Target userId is required.' } };
  }

  if (callerId === cleanTargetId) {
    return {
      status: 400,
      body: {
        ok: false,
        error: 'You cannot delete your own active Founder account.',
      },
    };
  }

  const { data: targetUser, error: findError } = await adminClient
    .from('users')
    .select('id, name, email, role, created_at')
    .eq('id', cleanTargetId)
    .maybeSingle();

  if (findError || !targetUser) {
    return {
      status: 404,
      body: { ok: false, error: 'Team account not found.' },
    };
  }

  if (targetUser.role === 'founder') {
    const { data: founders } = await adminClient
      .from('users')
      .select('id')
      .eq('role', 'founder');
    if (!Array.isArray(founders) || founders.length <= 1) {
      return {
        status: 400,
        body: {
          ok: false,
          error: 'Cannot delete the last Founder account in BALE.',
        },
      };
    }
  }

  // Cleanup, profile removal and audit are one database transaction. A
  // missing RPC or ambiguous response never falls back to the legacy writes.
  let profileResult: Awaited<ReturnType<MinimalAdminSupabaseClient['rpc']>>;
  try {
    profileResult = await adminClient.rpc('delete_team_profile_guarded', {
      p_actor: callerId, p_target: cleanTargetId,
    });
  } catch {
    return { status: 500, body: { ok: false, error: 'Profile removal not confirmed. Check the profile and audit before retrying; Auth removal was not attempted.' } };
  }
  const { data: deletedProfile, error: profileError } = profileResult;
  // PostgREST reports PGRST202 when it cannot find this RPC in its schema
  // cache; no profile operation was executed. Do not expose technical schema
  // errors or imply that removal succeeded on installations missing the guard.
  if (profileError?.code === 'PGRST202') {
    return { status: 503, body: { ok: false, error: 'Team account removal is temporarily unavailable. The account was not removed; please contact your administrator.' } };
  }
  if (profileError || !deletedProfile || deletedProfile.id !== cleanTargetId) {
    return { status: 500, body: { ok: false, error: 'Profile removal not confirmed. Check the profile and audit before retrying; Auth removal was not attempted.' } };
  }

  const authDelete = await adminClient.auth.admin.deleteUser(cleanTargetId)
    .catch(() => ({ data: null, error: { message: 'request failed' } }));
  if (authDelete.error) {
    return { status: 500, body: { ok: false, error: 'The BALE profile was removed but Auth removal was not confirmed. Administrator cleanup in Supabase Auth is required; do not assume login was revoked or blindly retry.' } };
  }

  return {
    status: 200,
    body: {
      ok: true,
      deletedUserId: cleanTargetId,
    },
  };
}
