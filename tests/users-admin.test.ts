import { describe, expect, it, vi } from 'vitest';
import {
  createTeamAccount,
  deleteTeamAccount,
  generateTemporaryPassword,
  updateTeamAccount,
  validatePasswordStrength,
  type MinimalAdminSupabaseClient,
} from '@/lib/users/admin';

function makeMockAdminClient(options?: {
  existingEmail?: boolean;
  targetUser?: { id: string; name: string; email: string; role: 'founder' | 'supervisor'; created_at: string } | null;
  foundersCount?: number;
  profileInsertError?: { message: string } | null;
}) {
  const createUserSpy = vi.fn(async (attrs: { email: string; password: string; email_confirm: boolean; user_metadata?: Record<string, unknown> }) => ({
    data: { user: { id: 'new-user-1', email: attrs.email } },
    error: null,
  }));
  const updateUserByIdSpy = vi.fn(async (id: string) => ({
    data: { user: { id } },
    error: null,
  }));
  const deleteUserSpy = vi.fn(async () => ({ data: {}, error: null }));
  const auditInsertSpy = vi.fn(async () => ({ error: null }));
  const supervisorInsertSpy = vi.fn(async () => ({ error: null }));
  const workerUpsertSpy = vi.fn(async () => ({ error: null }));
  const workerDeactivateSpy = vi.fn(async () => ({ error: null }));
  const attendanceNullSpy = vi.fn(async () => ({ error: null }));
  const expensesNullSpy = vi.fn(async () => ({ error: null }));

  const targetUser =
    options && 'targetUser' in options
      ? options.targetUser
      : {
          id: 'sup-1',
          name: 'Engr. Marco Reyes',
          email: 'marco@asinta.ph',
          role: 'supervisor' as const,
          created_at: '2026-10-11T00:00:00Z',
        };

  const foundersCount = options?.foundersCount ?? 2;

  const client: MinimalAdminSupabaseClient = {
    auth: {
      admin: {
        createUser: createUserSpy,
        updateUserById: updateUserByIdSpy,
        deleteUser: deleteUserSpy,
      },
    },
    from: (table: string) => {
      if (table === 'audit_log') {
        return { insert: auditInsertSpy };
      }
      if (table === 'project_supervisors') {
        return {
          insert: supervisorInsertSpy,
          delete: () => ({ eq: async () => ({ error: null }) }),
        };
      }
      if (table === 'workers') {
        return {
          upsert: workerUpsertSpy,
          update: () => ({ eq: workerDeactivateSpy }),
        };
      }
      if (table === 'attendance') {
        return {
          update: () => ({ eq: attendanceNullSpy }),
        };
      }
      if (table === 'expenses') {
        return {
          update: () => ({ eq: expensesNullSpy }),
        };
      }
      if (table === 'email_templates' || table === 'email_logs') {
        return {
          update: () => ({ eq: async () => ({ error: null }) }),
        };
      }
      if (table === 'users') {
        return {
          select: () => ({
            eq: (col: string, val: string) => {
              if (col === 'email') {
                return {
                  maybeSingle: async () => ({
                    data: options?.existingEmail ? { id: 'existing', email: val } : null,
                    error: null,
                  }),
                };
              }
              if (col === 'role' && val === 'founder') {
                return Promise.resolve({
                  data: Array.from({ length: foundersCount }, (_, idx) => ({ id: `founder-${idx + 1}` })),
                  error: null,
                });
              }
              return {
                maybeSingle: async () => ({ data: targetUser, error: null }),
              };
            },
          }),
          insert: (row: { id: string; name: string; email: string; role: 'founder' | 'supervisor' }) => ({
            select: () => ({
              single: async () => ({
                data: options?.profileInsertError
                  ? null
                  : { ...row, created_at: '2026-10-11T00:00:00Z' },
                error: options?.profileInsertError ?? null,
              }),
            }),
          }),
          update: (patch: { name?: string; role?: 'founder' | 'supervisor' }) => ({
            eq: () => ({
              select: () => ({
                single: async () => ({
                  data: targetUser ? { ...targetUser, ...patch } : null,
                  error: null,
                }),
              }),
            }),
          }),
          delete: () => ({
            eq: async () => ({ error: null }),
          }),
        };
      }
      return {};
    },
  };

  return {
    client,
    createUserSpy,
    updateUserByIdSpy,
    deleteUserSpy,
    auditInsertSpy,
    supervisorInsertSpy,
    workerUpsertSpy,
    workerDeactivateSpy,
    attendanceNullSpy,
    expensesNullSpy,
  };
}

describe('password generation and validation', () => {
  it('generates temporary passwords that pass strength validation', () => {
    for (let i = 0; i < 10; i += 1) {
      const pwd = generateTemporaryPassword();
      expect(pwd).toMatch(/^Asinta-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}!$/);
      expect(validatePasswordStrength(pwd).valid).toBe(true);
    }
  });

  it('rejects short or single-class passwords', () => {
    expect(validatePasswordStrength('short1').valid).toBe(false);
    expect(validatePasswordStrength('onlyletters').valid).toBe(false);
    expect(validatePasswordStrength('123456789').valid).toBe(false);
    expect(validatePasswordStrength('ValidPass9').valid).toBe(true);
  });
});

describe('createTeamAccount', () => {
  it('provisions an account with must_change_password=true, assigns supervisor projects, and never logs the temporary password to audit_log', async () => {
    const { client, createUserSpy, supervisorInsertSpy, auditInsertSpy } = makeMockAdminClient();
    const sendWelcomeMail = vi.fn(async () => ({ accepted: true }));

    const res = await createTeamAccount({
      callerId: 'founder-1',
      callerEmail: 'junel@asinta.ph',
      input: {
        name: 'Engr. Marco Reyes',
        email: 'Marco@Asinta.ph',
        role: 'supervisor',
        temporaryPassword: 'TempPassword2026!',
        assignedProjectIds: ['proj-1', 'proj-2'],
        sendWelcomeEmail: true,
      },
      adminClient: client,
      sendWelcomeMail,
    });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.user?.email).toBe('marco@asinta.ph');
    expect(res.body.emailSent).toBe(true);
    expect(createUserSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'marco@asinta.ph',
        password: 'TempPassword2026!',
        email_confirm: true,
        user_metadata: expect.objectContaining({
          must_change_password: true,
          role: 'supervisor',
        }),
      })
    );
    expect(supervisorInsertSpy).toHaveBeenCalledWith([
      { project_id: 'proj-1', supervisor_id: 'new-user-1' },
      { project_id: 'proj-2', supervisor_id: 'new-user-1' },
    ]);

    // Audit log must NEVER store the temporary password.
    expect(auditInsertSpy).toHaveBeenCalledTimes(1);
    const auditPayload = JSON.stringify(auditInsertSpy.mock.calls[0]);
    expect(auditPayload).not.toContain('TempPassword2026!');
  });

  it('rolls back the auth.users row if inserting into public.users fails', async () => {
    const { client, deleteUserSpy } = makeMockAdminClient({
      profileInsertError: { message: 'db constraint error' },
    });

    const res = await createTeamAccount({
      callerId: 'founder-1',
      callerEmail: 'junel@asinta.ph',
      input: {
        name: 'Test User',
        email: 'test@asinta.ph',
        role: 'supervisor',
        temporaryPassword: 'TempPassword2026!',
      },
      adminClient: client,
    });

    expect(res.status).toBe(500);
    expect(deleteUserSpy).toHaveBeenCalledWith('new-user-1');
  });

  it('rejects duplicate email addresses with 409', async () => {
    const { client, createUserSpy } = makeMockAdminClient({ existingEmail: true });

    const res = await createTeamAccount({
      callerId: 'founder-1',
      input: {
        name: 'Existing User',
        email: 'junel@asinta.ph',
        role: 'founder',
        temporaryPassword: 'TempPassword2026!',
      },
      adminClient: client,
    });

    expect(res.status).toBe(409);
    expect(createUserSpy).not.toHaveBeenCalled();
  });

  it('provisions a 1:1 linked Site Supervisor worker row when includeInPayroll is true', async () => {
    const { client, workerUpsertSpy } = makeMockAdminClient();

    const res = await createTeamAccount({
      callerId: 'founder-1',
      input: {
        name: 'Engr. Marco Reyes',
        email: 'marco@asinta.ph',
        role: 'supervisor',
        temporaryPassword: 'TempPassword2026!',
        includeInPayroll: true,
        payRate: 1250,
        payRateType: 'daily',
        contactNumber: '09171234567',
      },
      adminClient: client,
    });

    expect(res.status).toBe(201);
    expect(workerUpsertSpy).toHaveBeenCalledWith(
      {
        id: 'new-user-1',
        name: 'Engr. Marco Reyes',
        contact_number: '09171234567',
        position: 'Site Supervisor',
        pay_rate: 1250,
        pay_rate_type: 'daily',
        active: true,
      },
      { onConflict: 'id' }
    );
  });
});

describe('updateTeamAccount & deleteTeamAccount safety guards', () => {
  it('prevents a Founder from demoting or deleting their own active account', async () => {
    const { client } = makeMockAdminClient({
      targetUser: {
        id: 'founder-1',
        name: 'Ar. Junel Buyagon',
        email: 'junel@asinta.ph',
        role: 'founder',
        created_at: '2026-10-11T00:00:00Z',
      },
    });

    const demoteRes = await updateTeamAccount({
      callerId: 'founder-1',
      input: { userId: 'founder-1', role: 'supervisor' },
      adminClient: client,
    });
    expect(demoteRes.status).toBe(400);
    expect(demoteRes.body.error).toMatch(/cannot demote your own/i);

    const deleteRes = await deleteTeamAccount({
      callerId: 'founder-1',
      targetUserId: 'founder-1',
      adminClient: client,
    });
    expect(deleteRes.status).toBe(400);
    expect(deleteRes.body.error).toMatch(/cannot delete your own/i);
  });

  it('prevents deleting the last remaining Founder account', async () => {
    const { client } = makeMockAdminClient({
      targetUser: {
        id: 'founder-2',
        name: 'Ar. Rei Buyagon',
        email: 'rei@asinta.ph',
        role: 'founder',
        created_at: '2026-10-11T00:00:00Z',
      },
      foundersCount: 1,
    });

    const deleteRes = await deleteTeamAccount({
      callerId: 'founder-1',
      targetUserId: 'founder-2',
      adminClient: client,
    });
    expect(deleteRes.status).toBe(400);
    expect(deleteRes.body.error).toMatch(/last Founder/i);
  });

  it('detaches attendance.recorded_by and expenses.created_by before deleting a team account', async () => {
    const { client, attendanceNullSpy, expensesNullSpy, workerDeactivateSpy, deleteUserSpy, auditInsertSpy } =
      makeMockAdminClient();

    const res = await deleteTeamAccount({
      callerId: 'founder-1',
      callerEmail: 'junel@asinta.ph',
      targetUserId: 'sup-1',
      adminClient: client,
    });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(attendanceNullSpy).toHaveBeenCalledWith('recorded_by', 'sup-1');
    expect(expensesNullSpy).toHaveBeenCalledWith('created_by', 'sup-1');
    expect(workerDeactivateSpy).toHaveBeenCalledWith('id', 'sup-1');
    expect(deleteUserSpy).toHaveBeenCalledWith('sup-1');
    expect(auditInsertSpy).toHaveBeenCalledTimes(1);
  });
});
