import { describe, expect, it, vi } from 'vitest';
import {
  createTeamAccount,
  deleteTeamAccount,
  generateTemporaryPassword,
  parseTeamPayRate,
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
  const workerUpsertSpy = vi.fn(async (_row: Record<string, unknown>, _options: unknown) => ({ error: null }));
  const workerDeactivateSpy = vi.fn(async () => ({ error: null }));
  const attendanceNullSpy = vi.fn(async () => ({ error: null }));
  const rpcSpy = vi.fn(async (name: string, args: Record<string, unknown>) => ({
    data: name === 'delete_team_profile_guarded' ? { id: args.p_target } : name === 'replace_supervisor_projects_guarded' ? { project_count: (args.p_projects as string[]).length } : { ...targetUser, id: args.p_target, name: args.p_name, role: args.p_role },
    error: null,
  }));
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
    rpc: rpcSpy,
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
    rpcSpy,
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

  it('requests atomic profile cleanup before deleting the Auth account', async () => {
    const { client, rpcSpy, deleteUserSpy } = makeMockAdminClient();
    const res = await deleteTeamAccount({ callerId: 'founder-1', targetUserId: 'sup-1', adminClient: client });
    expect(res.body.ok).toBe(true);
    expect(rpcSpy).toHaveBeenCalledWith('delete_team_profile_guarded', { p_actor: 'founder-1', p_target: 'sup-1' });
    expect(deleteUserSpy).toHaveBeenCalledWith('sup-1');
  });
});

describe('team administration partial outcomes', () => {
  it('uses the atomic assignment RPC when a supervisor is assigned several projects', async () => {
    const { client, rpcSpy, supervisorInsertSpy } = makeMockAdminClient();
    const res = await updateTeamAccount({ callerId:'founder-1', input:{userId:'sup-1',assignedProjectIds:['proj-1','proj-2']}, adminClient:client });
    expect(res.body.ok).toBe(true);
    expect(res.body.assignedProjectIds).toEqual(['proj-1','proj-2']);
    expect(rpcSpy).toHaveBeenCalledWith('replace_supervisor_projects_guarded', {p_actor:'founder-1',p_target:'sup-1',p_projects:['proj-1','proj-2']});
    expect(supervisorInsertSpy).not.toHaveBeenCalled();
  });
  it('warns when assignment outcome is unconfirmed without a fallback delete and insert', async () => {
    const { client, rpcSpy, supervisorInsertSpy } = makeMockAdminClient();
    rpcSpy.mockImplementationOnce(async (_name,args) => ({data:{id:args.p_target,name:'Supervisor',role:'supervisor'},error:null}) as never);
    rpcSpy.mockImplementationOnce(async () => { throw new Error('lost response'); });
    const res = await updateTeamAccount({ callerId:'founder-1', input:{userId:'sup-1',assignedProjectIds:['proj-1']}, adminClient:client });
    expect(res.body.warnings?.join(' ')).toMatch(/assignments were not confirmed/i);
    expect(res.body.assignedProjectIds).toBeUndefined();
    expect(supervisorInsertSpy).not.toHaveBeenCalled();
  });

  it('does not return or audit a password as reset when Auth rejects it', async () => {
    const { client, updateUserByIdSpy, auditInsertSpy } = makeMockAdminClient();
    updateUserByIdSpy.mockImplementationOnce(async () => ({ data: { user: null }, error: { message: 'auth failed' } }) as never);
    const res = await updateTeamAccount({ callerId: 'founder-1', input: { userId: 'sup-1', resetTemporaryPassword: 'SafePass123' }, adminClient: client });
    expect(res.body.ok).toBe(true);
    expect(res.body.temporaryPassword).toBeUndefined();
    expect(res.body.warnings?.join(' ')).toMatch(/password reset were not confirmed/i);
    expect(JSON.stringify(auditInsertSpy.mock.calls)).not.toContain('SafePass123');
    expect(JSON.stringify(auditInsertSpy.mock.calls)).not.toContain('password_reset_to_temporary');
  });

  it('reports failed or thrown assignment and roster writes while retaining provisioned credentials', async () => {
    const { client, supervisorInsertSpy, workerUpsertSpy } = makeMockAdminClient();
    supervisorInsertSpy.mockRejectedValueOnce(new Error('network'));
    workerUpsertSpy.mockImplementationOnce(async () => ({ error: { message: 'database error' } }) as never);
    const res = await createTeamAccount({ callerId: 'founder-1', input: {
      name: 'Test User', email: 'test@example.com', role: 'supervisor', temporaryPassword: 'SafePass123',
      assignedProjectIds: ['site-1'], includeInPayroll: true, payRate: 0, sendWelcomeEmail: false,
    }, adminClient: client });
    expect(res.body.ok).toBe(true);
    expect(res.body.temporaryPassword).toBe('SafePass123');
    expect(res.body.warnings?.join(' ')).toMatch(/assignments/i);
    expect(res.body.warnings?.join(' ')).toMatch(/roster/i);
    expect(workerUpsertSpy.mock.calls[0][0]).toMatchObject({ pay_rate: 0 });
  });

  it('rejects invalid pay rates before changing a profile', async () => {
    const { client, updateUserByIdSpy } = makeMockAdminClient();
    const res = await updateTeamAccount({ callerId: 'founder-1', input: { userId: 'sup-1', role: 'supervisor', includeInPayroll: true, payRate: -10 }, adminClient: client });
    expect(res.status).toBe(400);
    expect(updateUserByIdSpy).not.toHaveBeenCalled();
  });

  it('keeps credentials available if the welcome email outcome is unknown', async () => {
    const { client } = makeMockAdminClient();
    const res = await createTeamAccount({ callerId: 'founder-1', input: {
      name: 'Test User', email: 'test@example.com', role: 'founder', temporaryPassword: 'SafePass123',
    }, adminClient: client, sendWelcomeMail: async () => { throw new Error('timeout'); } });
    expect(res.body.ok).toBe(true);
    expect(res.body.temporaryPassword).toBe('SafePass123');
    expect(res.body.emailNote).toMatch(/unconfirmed/i);
  });

  it('does not report deletion success when Auth removal fails', async () => {
    const { client, deleteUserSpy } = makeMockAdminClient();
    deleteUserSpy.mockImplementationOnce(async () => ({ data: null, error: { message: 'auth error' } }) as never);
    const res = await deleteTeamAccount({ callerId: 'founder-1', targetUserId: 'sup-1', adminClient: client });
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/profile was removed.*Auth removal was not confirmed/i);
  });

  it('fails closed when the guarded cleanup RPC is missing or fails', async () => {
    const { client, deleteUserSpy, rpcSpy } = makeMockAdminClient();
    rpcSpy.mockImplementationOnce(async () => ({ data: null, error: { message: 'RPC missing' } }) as never);
    const res = await deleteTeamAccount({ callerId: 'founder-1', targetUserId: 'sup-1', adminClient: client });
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/Auth removal was not attempted/i);
    expect(deleteUserSpy).not.toHaveBeenCalled();
  });

  it('explains an unavailable deletion guard without removing the Auth account', async () => {
    const { client, deleteUserSpy, rpcSpy } = makeMockAdminClient();
    rpcSpy.mockImplementationOnce(async () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function in the schema cache' } }) as never);
    const res = await deleteTeamAccount({ callerId: 'founder-1', targetUserId: 'sup-1', adminClient: client });
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/temporarily unavailable.*account was not removed/i);
    expect(res.body.error).not.toMatch(/PGRST|schema|function/i);
    expect(deleteUserSpy).not.toHaveBeenCalled();
  });

  it('reports an unknown RPC outcome without attempting Auth deletion', async () => {
    const { client, deleteUserSpy, rpcSpy } = makeMockAdminClient();
    rpcSpy.mockImplementationOnce(async () => { throw new Error('lost response'); });
    const res = await deleteTeamAccount({ callerId: 'founder-1', targetUserId: 'sup-1', adminClient: client });
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/check the profile and audit/i);
    expect(deleteUserSpy).not.toHaveBeenCalled();
  });

  it('does not update Auth when the guarded profile update fails', async () => {
    const { client, rpcSpy, updateUserByIdSpy } = makeMockAdminClient();
    rpcSpy.mockImplementationOnce(async () => ({ data: null, error: { message: 'RPC missing' } }) as never);
    const res = await updateTeamAccount({ callerId: 'founder-1', input: { userId: 'sup-1', name: 'Test User' }, adminClient: client });
    expect(res.body.ok).toBe(false);
    expect(updateUserByIdSpy).not.toHaveBeenCalled();
  });
});


describe('team payroll rate validation', () => {
  it('accepts zero, fractional cents-safe rates and the historical absent default', () => {
    expect(parseTeamPayRate(0)).toBe(0);
    expect(parseTeamPayRate('1234.56')).toBe(1234.56);
    expect(parseTeamPayRate(undefined)).toBe(1200);
  });
  it.each(['', '  ', null, false, -1, '1.001', '1e4', 100000000])('rejects invalid rate %s', (value) => {
    expect(parseTeamPayRate(value)).toBeNull();
  });
});
