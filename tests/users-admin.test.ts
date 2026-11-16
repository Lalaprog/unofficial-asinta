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
  emailCheck?: 'error' | 'throws' | 'invalid';
  removedWorker?: boolean;
  workerReadError?: boolean;
  snapshotWorker?: {id:string;name:string;position:string;active:boolean;pay_rate:number;pay_rate_type:'daily'|'hourly';contact_number:string|null;removed_at:string|null} | null;
  snapshotProjects?: readonly string[];
  snapshotError?: boolean;
  targetUser?: { id: string; name: string; email: string; role: 'founder' | 'supervisor'; created_at: string } | null;
  foundersCount?: number;
  profileInsertError?: { message: string } | null;
  profileInsertThrows?: boolean;
  profileInsertMismatch?: boolean;
  projectLookup?: 'missing' | 'error' | 'incomplete' | 'throws';
  workerConditional?: 'stale' | 'error' | 'throws';
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
  const projectLookupSpy = vi.fn();
  const workerUpsertSpy = vi.fn(async (_row: Record<string, unknown>, _options: unknown) => ({ error: null }));
  const workerDeactivateSpy = vi.fn(async () => ({ error: null }));
  const conditionalWorkerWrite=vi.fn();
  const workerCondition=vi.fn();
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
      if (table === 'projects') {
        return { select: () => ({ in: (_column:string, ids:string[]) => ({limit: async () => {
          projectLookupSpy(ids);
          if (options?.projectLookup === 'throws') throw Error('offline');
          if (options?.projectLookup === 'error') return {data:null,count:null,error:{message:'offline'}};
          if (options?.projectLookup === 'incomplete') return {data:[],count:ids.length,error:null};
          const data=(options?.projectLookup === 'missing' ? ids.slice(1) : ids).map(id=>({id}));
          return {data,count:data.length,error:null};
        }}) }) };
      }
      if (table === 'project_supervisors') {
        return {
          insert: supervisorInsertSpy,
          select: () => ({eq: () => ({limit: async () => ({data:(options?.snapshotProjects??[]).map(project_id=>({project_id})),count:(options?.snapshotProjects??[]).length,error:options?.snapshotError?{message:'unavailable'}:null})})}),
          delete: () => ({ eq: async () => ({ error: null }) }),
        };
      }
      if (table === 'workers') {
        const conditional=(action:string,row:Record<string,unknown>)=>{
          conditionalWorkerWrite(action,row);
          const query={
            eq:(column:string,value:unknown)=>{workerCondition('eq',column,value);return query;},
            is:(column:string,value:unknown)=>{workerCondition('is',column,value);return query;},
            select:()=>({maybeSingle:async()=>{
              if(options?.workerConditional==='throws')throw Error('lost response');
              if(options?.workerConditional==='error')return {data:null,error:{message:'failed'}};
              return {data:options?.workerConditional==='stale'?null:{id:'sup-1'},error:null};
            }}),
          };
          return query;
        };
        return {
          upsert: workerUpsertSpy,
          insert: (row:Record<string,unknown>)=>conditional('insert',row),
          select: (columns:string) => ({ eq: () => ({ maybeSingle: async () => ({data: columns.includes('name') ? (options?.snapshotWorker??null) : options?.removedWorker ? {id:'sup-1',removed_at:'2026-11-07'} : null,error:options?.workerReadError ? {message:'read failed'} : null}) }) }),
          update: (row:Record<string,unknown>) => {
            const query=conditional('update',row);
            return Object.keys(row).length===1 ? {...query, eq:(column:string,value:unknown)=>{
              query.eq(column,value);
              return Object.assign(query,{then:(resolve:(value:unknown)=>void,reject:(reason:unknown)=>void)=>workerDeactivateSpy().then(resolve,reject)});
            }} : query;
          },
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
                  maybeSingle: async () => {
                    if (options?.emailCheck === 'throws') throw Error('offline');
                    return {
                      data: options?.emailCheck === 'invalid' ? undefined : options?.existingEmail ? { id: 'existing', email: val } : null,
                      error: options?.emailCheck === 'error' ? {message:'offline'} : null,
                    };
                  },
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
                single: async () => {
                  if (options?.profileInsertThrows) throw Error('lost response');
                  return {
                    data: options?.profileInsertError ? null : { ...row, ...(options?.profileInsertMismatch ? {role:'founder'} : {}), created_at: '2026-10-11T00:00:00Z' },
                    error: options?.profileInsertError ?? null,
                  };
                },
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
    projectLookupSpy,
    workerUpsertSpy,
    workerDeactivateSpy,
    conditionalWorkerWrite,
    workerCondition,
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
        assignedProjectIds: ['00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000102'],
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
      { project_id: '00000000-0000-4000-8000-000000000101', supervisor_id: 'new-user-1' },
      { project_id: '00000000-0000-4000-8000-000000000102', supervisor_id: 'new-user-1' },
    ]);

    // Audit log must NEVER store the temporary password.
    expect(auditInsertSpy).toHaveBeenCalledTimes(1);
    const auditPayload = JSON.stringify(auditInsertSpy.mock.calls[0]);
    expect(auditPayload).not.toContain('TempPassword2026!');
  });

  it.each([{profileInsertError:{message:'db error'}},{profileInsertThrows:true},{profileInsertMismatch:true}])('holds Auth cleanup when profile creation is unconfirmed', async options => {
    const { client, deleteUserSpy, supervisorInsertSpy, workerUpsertSpy } = makeMockAdminClient(options);
    const sendWelcomeMail=vi.fn();
    const res = await createTeamAccount({callerId:'founder-1', input:{
      name:'Test User', email:'test@asinta.ph', role:'supervisor', temporaryPassword:'TempPassword2026!', sendWelcomeEmail:true,
    }, adminClient:client, sendWelcomeMail});
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/not confirmed.*not automatically removed.*before retrying/i);
    expect(deleteUserSpy).not.toHaveBeenCalled();expect(supervisorInsertSpy).not.toHaveBeenCalled();expect(workerUpsertSpy).not.toHaveBeenCalled();expect(sendWelcomeMail).not.toHaveBeenCalled();
  });

  it('reports unknown Auth creation outcomes without creating the profile or sending credentials',async()=>{
    const {client,createUserSpy,deleteUserSpy}=makeMockAdminClient();
    createUserSpy.mockRejectedValueOnce(Error('lost response'));
    const sendWelcomeMail=vi.fn();
    const res=await createTeamAccount({callerId:'founder-1',input:{name:'Test User',email:'test@example.invalid',role:'founder',temporaryPassword:'SafePass123',sendWelcomeEmail:true},adminClient:client,sendWelcomeMail});
    expect(res.status).toBe(503);expect(res.body.error).toMatch(/not confirmed.*before retrying/i);
    expect(deleteUserSpy).not.toHaveBeenCalled();expect(sendWelcomeMail).not.toHaveBeenCalled();
  });

  it.each(['error','throws','invalid'] as const)('does not create Auth when duplicate-email lookup is %s',async emailCheck=>{
    const {client,createUserSpy}=makeMockAdminClient({emailCheck});
    const result=await createTeamAccount({callerId:'founder-1',input:{name:'Test User',email:'test@example.invalid',role:'founder',temporaryPassword:'SafePass123'},adminClient:client});
    expect(result.status).toBe(503);expect(result.body.error).toMatch(/No account was created/);expect(createUserSpy).not.toHaveBeenCalled();
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
  it('never silently overwrites or reactivates a worker for account-only edits', async () => {
    const {client,workerUpsertSpy,workerDeactivateSpy}=makeMockAdminClient({removedWorker:true});
    const result=await updateTeamAccount({callerId:'founder-1',input:{userId:'sup-1',name:'Updated Name'},adminClient:client});
    expect(result.body.ok).toBe(true);
    expect(result.body.warnings?.join(' ')).toMatch(/roster was not changed/i);
    expect(workerUpsertSpy).not.toHaveBeenCalled();
    expect(workerDeactivateSpy).not.toHaveBeenCalled();
  });
  it('requires explicit complete payroll details and rejects malformed site selections before any writes', async () => {
    for (const input of [
      {includeInPayroll:true},
      {includeInPayroll:true,payRate:600,payRateType:'daily'},
      {includeInPayroll:true,payRate:600,payRateType:'invalid',contactNumber:''},
      {payRate:600}, {includeInPayroll:'yes'}, {role:'invalid'},
      {assignedProjectIds:['00000000-0000-4000-8000-000000000103',null]}, {assignedProjectIds:['']}, {assignedProjectIds:['not-a-uuid']},
      {assignedProjectIds:Array(1001).fill('00000000-0000-4000-8000-000000000103')}, {assignedProjectIds:null},
    ]) {
      const {client,rpcSpy,updateUserByIdSpy,workerUpsertSpy,workerDeactivateSpy}=makeMockAdminClient();
      const result=await updateTeamAccount({callerId:'founder-1',input:{userId:'sup-1',...input},adminClient:client});
      expect(result.status,JSON.stringify(input)).toBe(400);
      expect(rpcSpy).not.toHaveBeenCalled();expect(updateUserByIdSpy).not.toHaveBeenCalled();
      expect(workerUpsertSpy).not.toHaveBeenCalled();expect(workerDeactivateSpy).not.toHaveBeenCalled();
    }
  });
  it('rejects malformed sites before account creation, while an explicit empty list is allowed', async () => {
    const {client,createUserSpy}=makeMockAdminClient();
    const base={name:'Test User',email:'test@example.invalid',role:'supervisor',temporaryPassword:'SafePass123',sendWelcomeEmail:false};
    expect((await createTeamAccount({callerId:'founder-1',input:{...base,assignedProjectIds:['00000000-0000-4000-8000-000000000103',null]},adminClient:client})).status).toBe(400);
    expect(createUserSpy).not.toHaveBeenCalled();
    expect((await createTeamAccount({callerId:'founder-1',input:{...base,assignedProjectIds:[]},adminClient:client})).body.ok).toBe(true);
  });
  it('does not send welcome credentials without an explicit true selection', async () => {
    const {client,createUserSpy}=makeMockAdminClient();
    const sendWelcomeMail=vi.fn(async()=>({accepted:true}));
    const base={name:'Test User',email:'test@example.invalid',role:'founder',temporaryPassword:'SafePass123'};
    const noChoice=await createTeamAccount({callerId:'founder-1',input:base,adminClient:client,sendWelcomeMail});
    expect(noChoice.body.ok).toBe(true);expect(sendWelcomeMail).not.toHaveBeenCalled();
    createUserSpy.mockClear();
    const invalid=await createTeamAccount({callerId:'founder-1',input:{...base,sendWelcomeEmail:'false'},adminClient:client,sendWelcomeMail});
    expect(invalid.status).toBe(400);expect(createUserSpy).not.toHaveBeenCalled();expect(sendWelcomeMail).not.toHaveBeenCalled();
  });
  it('writes explicitly reviewed payroll details, including a zero rate', async () => {
    const {client,workerUpsertSpy}=makeMockAdminClient();
    const result=await updateTeamAccount({callerId:'founder-1',input:{userId:'sup-1',includeInPayroll:true,payRate:0,payRateType:'hourly',contactNumber:''},adminClient:client});
    expect(result.body.ok).toBe(true);
    expect(workerUpsertSpy).toHaveBeenCalledWith(expect.objectContaining({id:'sup-1',pay_rate:0,pay_rate_type:'hourly',active:true}),{onConflict:'id'});
  });
  it.each(['missing','error','incomplete','throws'] as const)('does not change or create accounts when project verification is %s',async projectLookup=>{
    const selected=['00000000-0000-4000-8000-000000000101'];
    const {client,rpcSpy,createUserSpy,updateUserByIdSpy,workerUpsertSpy}=makeMockAdminClient({projectLookup});
    const update=await updateTeamAccount({callerId:'founder-1',input:{userId:'sup-1',assignedProjectIds:selected},adminClient:client});
    expect(update.status).toBe(projectLookup==='missing'?409:503);
    const create=await createTeamAccount({callerId:'founder-1',input:{name:'Test User',email:'test@example.invalid',role:'supervisor',temporaryPassword:'SafePass123',assignedProjectIds:selected},adminClient:client});
    expect(create.status).toBe(projectLookup==='missing'?409:503);
    expect(rpcSpy).not.toHaveBeenCalled();expect(createUserSpy).not.toHaveBeenCalled();expect(updateUserByIdSpy).not.toHaveBeenCalled();expect(workerUpsertSpy).not.toHaveBeenCalled();
  });
  it('checks a large project selection in bounded batches before saving',async()=>{
    const ids=Array.from({length:101},(_,n)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`);
    const {client,projectLookupSpy,rpcSpy}=makeMockAdminClient();
    const res=await updateTeamAccount({callerId:'founder-1',input:{userId:'sup-1',assignedProjectIds:ids},adminClient:client});
    expect(res.body.ok).toBe(true);expect(projectLookupSpy.mock.calls.map(call=>call[0].length)).toEqual([100,1]);
    expect(rpcSpy).toHaveBeenCalledWith('replace_supervisor_projects_guarded',expect.objectContaining({p_projects:ids}));
  });
  it('rejects stale, invalid or unreadable expected snapshots before any account write', async () => {
    const user={id:'sup-1',name:'Engr. Marco Reyes',email:'marco@asinta.ph',role:'supervisor',created_at:'2026-10-11T00:00:00Z'};
    const worker={id:'sup-1',name:'Workforce name',position:'Site Supervisor',active:true,pay_rate:600,pay_rate_type:'daily' as const,contact_number:'—',removed_at:null};
    const expected={user,worker,assignedProjectIds:['00000000-0000-4000-8000-000000000101']};
    for (const [options,snapshot,status] of [
      [{snapshotWorker:{...worker,name:'Changed elsewhere'},snapshotProjects:['00000000-0000-4000-8000-000000000101']},expected,409],
      [{snapshotWorker:{...worker,position:'Changed elsewhere'},snapshotProjects:['00000000-0000-4000-8000-000000000101']},expected,409],
      [{snapshotWorker:worker,snapshotProjects:['00000000-0000-4000-8000-000000000102']},expected,409],
      [{snapshotWorker:worker,snapshotProjects:['00000000-0000-4000-8000-000000000101'],snapshotError:true},expected,503],
      [{snapshotWorker:worker,snapshotProjects:['00000000-0000-4000-8000-000000000101']},{...expected,assignedProjectIds:['00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000101']},400],
    ] as const) {
      const {client,rpcSpy,updateUserByIdSpy,workerUpsertSpy}=makeMockAdminClient(options);
      const result=await updateTeamAccount({callerId:'founder-1',input:{userId:'sup-1',expectedSnapshot:snapshot},adminClient:client});
      expect(result.status).toBe(status);expect(rpcSpy).not.toHaveBeenCalled();expect(updateUserByIdSpy).not.toHaveBeenCalled();expect(workerUpsertSpy).not.toHaveBeenCalled();
    }
  });
  it('conditionally updates the reviewed worker without an unsafe upsert', async () => {
    const user={id:'sup-1',name:'Engr. Marco Reyes',email:'marco@asinta.ph',role:'supervisor' as const,created_at:'2026-10-11T00:00:00Z'};
    const worker={id:'sup-1',name:'Workforce name',position:'Site Supervisor',active:true,pay_rate:600,pay_rate_type:'daily' as const,contact_number:'—',removed_at:null};
    const {client,conditionalWorkerWrite,workerCondition,workerUpsertSpy}=makeMockAdminClient({snapshotWorker:worker});
    const res=await updateTeamAccount({callerId:'founder-1',input:{userId:'sup-1',expectedSnapshot:{user,worker,assignedProjectIds:[]},includeInPayroll:true,payRate:700,payRateType:'daily',contactNumber:''},adminClient:client});
    expect(res.body.ok).toBe(true);expect(res.body.warnings).toBeUndefined();expect(workerUpsertSpy).not.toHaveBeenCalled();
    expect(conditionalWorkerWrite).toHaveBeenCalledWith('update',expect.objectContaining({id:'sup-1',pay_rate:700}));
    expect(workerCondition.mock.calls).toEqual([['eq','id','sup-1'],['eq','name','Workforce name'],['eq','position','Site Supervisor'],['eq','active',true],['eq','pay_rate',600],['eq','pay_rate_type','daily'],['eq','contact_number','—'],['is','removed_at',null]]);
  });
  it.each(['stale','error','throws'] as const)('reports %s worker writes without overwriting the profile',async workerConditional=>{
    const user={id:'sup-1',name:'Engr. Marco Reyes',email:'marco@asinta.ph',role:'supervisor' as const,created_at:'2026-10-11T00:00:00Z'};
    const worker={id:'sup-1',name:'Workforce name',position:'Site Supervisor',active:true,pay_rate:600,pay_rate_type:'daily' as const,contact_number:'—',removed_at:null};
    const {client,workerUpsertSpy,conditionalWorkerWrite}=makeMockAdminClient({snapshotWorker:worker,workerConditional});
    const res=await updateTeamAccount({callerId:'founder-1',input:{userId:'sup-1',expectedSnapshot:{user,worker,assignedProjectIds:[]},includeInPayroll:true,payRate:700,payRateType:'daily',contactNumber:''},adminClient:client});
    expect(res.body.ok).toBe(true);expect(res.body.warnings?.join(' ')).toMatch(/roster update was not confirmed/i);
    expect(workerUpsertSpy).not.toHaveBeenCalled();expect(conditionalWorkerWrite).toHaveBeenCalledTimes(1);
  });
  it.each(['stale','error','throws'] as const)('does not deactivate a changed workforce profile (%s)',async workerConditional=>{
    const user={id:'sup-1',name:'Engr. Marco Reyes',email:'marco@asinta.ph',role:'supervisor' as const,created_at:'2026-10-11T00:00:00Z'};
    const worker={id:'sup-1',name:'Workforce name',position:'Site Supervisor',active:true,pay_rate:600,pay_rate_type:'daily' as const,contact_number:null,removed_at:null};
    const {client,conditionalWorkerWrite,workerCondition,workerDeactivateSpy}=makeMockAdminClient({snapshotWorker:worker,workerConditional});
    const res=await updateTeamAccount({callerId:'founder-1',input:{userId:'sup-1',expectedSnapshot:{user,worker,assignedProjectIds:[]},includeInPayroll:false},adminClient:client});
    expect(res.body.ok).toBe(true);expect(res.body.warnings?.join(' ')).toMatch(/deactivation was not confirmed/i);
    expect(conditionalWorkerWrite).toHaveBeenCalledWith('update',{active:false});
    expect(workerCondition).toHaveBeenCalledWith('is','contact_number',null);expect(workerDeactivateSpy).not.toHaveBeenCalled();
  });
  it('does not deactivate a workforce profile created after an absent snapshot',async()=>{
    const user={id:'sup-1',name:'Engr. Marco Reyes',email:'marco@asinta.ph',role:'supervisor' as const,created_at:'2026-10-11T00:00:00Z'};
    const {client,conditionalWorkerWrite}=makeMockAdminClient();
    const res=await updateTeamAccount({callerId:'founder-1',input:{userId:'sup-1',expectedSnapshot:{user,worker:null,assignedProjectIds:[]},includeInPayroll:false},adminClient:client});
    expect(res.body.warnings?.join(' ')).toMatch(/No payroll profile/);expect(conditionalWorkerWrite).not.toHaveBeenCalled();
  });
  it('inserts rather than overwriting a profile created after a missing-worker snapshot',async()=>{
    const user={id:'sup-1',name:'Engr. Marco Reyes',email:'marco@asinta.ph',role:'supervisor' as const,created_at:'2026-10-11T00:00:00Z'};
    const {client,conditionalWorkerWrite,workerUpsertSpy}=makeMockAdminClient({snapshotWorker:null,workerConditional:'error'});
    const res=await updateTeamAccount({callerId:'founder-1',input:{userId:'sup-1',expectedSnapshot:{user,worker:null,assignedProjectIds:[]},includeInPayroll:true,payRate:700,payRateType:'daily',contactNumber:''},adminClient:client});
    expect(conditionalWorkerWrite).toHaveBeenCalledWith('insert',expect.objectContaining({id:'sup-1'}));
    expect(workerUpsertSpy).not.toHaveBeenCalled();expect(res.body.warnings?.join(' ')).toMatch(/roster update was not confirmed/i);
  });
  it('allows an unchanged expected snapshot through to the existing guarded update', async () => {
    const user={id:'sup-1',name:'Engr. Marco Reyes',email:'marco@asinta.ph',role:'supervisor',created_at:'2026-10-11T00:00:00Z'};
    const worker={id:'sup-1',name:'Workforce name',position:'Site Supervisor',active:true,pay_rate:600,pay_rate_type:'daily' as const,contact_number:'—',removed_at:null};
    const {client,rpcSpy}=makeMockAdminClient({snapshotWorker:worker,snapshotProjects:['00000000-0000-4000-8000-000000000101']});
    const result=await updateTeamAccount({callerId:'founder-1',input:{userId:'sup-1',name:'Updated',expectedSnapshot:{user,worker,assignedProjectIds:['00000000-0000-4000-8000-000000000101']}},adminClient:client});
    expect(result.body.ok).toBe(true);expect(rpcSpy).toHaveBeenCalledWith('update_team_profile_guarded',expect.objectContaining({p_target:'sup-1',p_name:'Updated'}));
  });
  it('does not implicitly restore a removed worker during an account edit', async () => {
    const {client,rpcSpy,updateUserByIdSpy,workerUpsertSpy}=makeMockAdminClient({removedWorker:true});
    const result=await updateTeamAccount({callerId:'founder-1',input:{userId:'sup-1',includeInPayroll:true,payRate:600,payRateType:'daily',contactNumber:''},adminClient:client});
    expect(result.status).toBe(409);expect(result.body.error).toMatch(/restore.*Workforce/i);
    expect(rpcSpy).not.toHaveBeenCalled();expect(updateUserByIdSpy).not.toHaveBeenCalled();expect(workerUpsertSpy).not.toHaveBeenCalled();
    const accountOnly=await updateTeamAccount({callerId:'founder-1',input:{userId:'sup-1',includeInPayroll:false},adminClient:client});
    expect(accountOnly.body.ok).toBe(true);expect(workerUpsertSpy).not.toHaveBeenCalled();
  });
  it('does not change an account when its worker profile cannot be checked', async () => {
    const {client,rpcSpy}=makeMockAdminClient({workerReadError:true});
    const result=await updateTeamAccount({callerId:'founder-1',input:{userId:'sup-1',includeInPayroll:true,payRate:600,payRateType:'daily',contactNumber:''},adminClient:client});
    expect(result.status).toBe(503);expect(rpcSpy).not.toHaveBeenCalled();
  });
  it('uses the atomic assignment RPC when a supervisor is assigned several projects', async () => {
    const { client, rpcSpy, supervisorInsertSpy } = makeMockAdminClient();
    const res = await updateTeamAccount({ callerId:'founder-1', input:{userId:'sup-1',assignedProjectIds:['00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000102']}, adminClient:client });
    expect(res.body.ok).toBe(true);
    expect(res.body.assignedProjectIds).toEqual(['00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000102']);
    expect(rpcSpy).toHaveBeenCalledWith('replace_supervisor_projects_guarded', {p_actor:'founder-1',p_target:'sup-1',p_projects:['00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000102']});
    expect(supervisorInsertSpy).not.toHaveBeenCalled();
  });
  it('normalizes duplicate UUIDs before requesting an atomic assignment replacement', async () => {
    const {client,rpcSpy}=makeMockAdminClient();
    const id='abcdef12-3456-4abc-8abc-123456789abc';
    const res=await updateTeamAccount({callerId:'founder-1',input:{userId:'sup-1',assignedProjectIds:[id,id.toUpperCase()]},adminClient:client});
    expect(res.body.assignedProjectIds).toEqual([id]);
    expect(rpcSpy).toHaveBeenCalledWith('replace_supervisor_projects_guarded',{p_actor:'founder-1',p_target:'sup-1',p_projects:[id]});
  });
  it('warns when assignment outcome is unconfirmed without a fallback delete and insert', async () => {
    const { client, rpcSpy, supervisorInsertSpy } = makeMockAdminClient();
    rpcSpy.mockImplementationOnce(async (_name,args) => ({data:{id:args.p_target,name:'Supervisor',role:'supervisor'},error:null}) as never);
    rpcSpy.mockImplementationOnce(async () => { throw new Error('lost response'); });
    const res = await updateTeamAccount({ callerId:'founder-1', input:{userId:'sup-1',assignedProjectIds:['00000000-0000-4000-8000-000000000101']}, adminClient:client });
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

  it('does not confirm or disclose a reset when Auth responds with a different account', async () => {
    const {client,updateUserByIdSpy,auditInsertSpy}=makeMockAdminClient();
    updateUserByIdSpy.mockImplementationOnce(async()=>({data:{user:{id:'other-user'}},error:null}) as never);
    const res=await updateTeamAccount({callerId:'founder-1',input:{userId:'sup-1',resetTemporaryPassword:'SafePass123'},adminClient:client});
    expect(res.body.temporaryPassword).toBeUndefined();
    expect(res.body.warnings?.join(' ')).toMatch(/password reset were not confirmed/i);
    expect(JSON.stringify(auditInsertSpy.mock.calls)).not.toContain('password_reset_to_temporary');
  });
  it('reports failed or thrown assignment and roster writes while retaining provisioned credentials', async () => {
    const { client, supervisorInsertSpy, workerUpsertSpy } = makeMockAdminClient();
    supervisorInsertSpy.mockRejectedValueOnce(new Error('network'));
    workerUpsertSpy.mockImplementationOnce(async () => ({ error: { message: 'database error' } }) as never);
    const res = await createTeamAccount({ callerId: 'founder-1', input: {
      name: 'Test User', email: 'test@example.com', role: 'supervisor', temporaryPassword: 'SafePass123',
      assignedProjectIds: ['00000000-0000-4000-8000-000000000103'], includeInPayroll: true, payRate: 0, sendWelcomeEmail: false,
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
      name: 'Test User', email: 'test@example.com', role: 'founder', temporaryPassword: 'SafePass123', sendWelcomeEmail: true,
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

  it('explains linked-record protection without removing the Auth account', async () => {
    const { client, deleteUserSpy, rpcSpy } = makeMockAdminClient();
    rpcSpy.mockImplementationOnce(async () => ({ data: null, error: { code: 'P1001', message: 'TEAM_ACCOUNT_HAS_LINKED_RECORDS' } }) as never);
    const res = await deleteTeamAccount({ callerId: 'founder-1', targetUserId: 'sup-1', adminClient: client });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/linked to existing records.*account remains active/i);
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
