import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { requireSessionAssurance } from '@/lib/auth/session-assurance';

const mock = vi.hoisted(() => ({
  assurance: true as unknown, assuranceError: null as unknown,
  role: 'supervisor', user: { id: 'user-1', email: 'synthetic@example.test', user_metadata: {} } as null | {id:string; email:string; user_metadata:object},
  rpc: vi.fn(), updateUser: vi.fn(), service: vi.fn(), workerWrite: vi.fn(),
}));
vi.mock('@/lib/supabase/server', () => ({ createServerSupabaseClient: () => ({
  auth: { getUser: async () => ({ data: { user: mock.user }, error: mock.user ? null : new Error('no session') }), updateUser: mock.updateUser },
  from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: {id:'user-1',role:mock.role,email:'synthetic@example.test'}, error:null }) }) }) }),
  rpc: mock.rpc,
}) }));
vi.mock('@/lib/supabase/admin', () => ({
  isServiceRoleConfigured: () => true,
  createServiceRoleClient: () => { mock.service(); return { from: () => ({ insert: mock.workerWrite }) }; },
}));

import { requireFounder } from '@/lib/auth/serverRole';
import { POST as registerWorker } from '@/app/api/workers/route';
import { POST as setupPassword } from '@/app/api/auth/setup-password/route';
import { createServerSupabaseClient } from '@/lib/supabase/server';

beforeEach(() => {
  vi.clearAllMocks(); mock.assurance = true; mock.assuranceError = null; mock.role = 'supervisor';
  mock.user = { id:'user-1', email:'synthetic@example.test', user_metadata:{} };
  mock.rpc.mockImplementation(async () => ({data:mock.assurance,error:mock.assuranceError}));
});

function request(path: string, body: unknown) {
  return new NextRequest(`http://localhost:3000${path}`, { method: 'POST', headers: {'Content-Type':'application/json'}, body:JSON.stringify(body) });
}

describe('server-side assurance gate', () => {
  it('allows only a definite true, blocks unverified sessions and fails closed for outages or malformed responses', async () => {
    const supabase = createServerSupabaseClient();
    expect(await requireSessionAssurance(supabase)).toEqual({ok:true});
    expect(mock.rpc).toHaveBeenCalledWith('session_assurance_satisfied');
    mock.assurance = false;
    expect(await requireSessionAssurance(supabase)).toMatchObject({ok:false,status:403});
    for (const invalid of [null, undefined, 'true', 1, {}]) {
      mock.assurance = invalid;
      expect(await requireSessionAssurance(supabase)).toMatchObject({ok:false,status:503});
    }
    mock.assurance = true; mock.assuranceError = new Error('DB unavailable');
    expect(await requireSessionAssurance(supabase)).toMatchObject({ok:false,status:503});
    mock.rpc.mockRejectedValueOnce(new Error('network failed'));
    expect(await requireSessionAssurance(supabase)).toMatchObject({ok:false,status:503});
  });

  it('checks Founder-only API authorization without weakening roles', async () => {
    const client = createServerSupabaseClient();
    expect(await requireFounder(client)).toMatchObject({ok:false,status:403});
    expect(mock.rpc).not.toHaveBeenCalled();
    mock.role = 'founder'; mock.assurance = false;
    expect(await requireFounder(client)).toMatchObject({ok:false,status:403});
    mock.assuranceError = new Error('offline');
    expect(await requireFounder(client)).toMatchObject({ok:false,status:503});
    mock.assurance = true; mock.assuranceError = null;
    expect(await requireFounder(client)).toMatchObject({ok:true,userId:'user-1'});
  });

  it('blocks the Supervisor worker-creation service role before it can write', async () => {
    mock.assurance = false;
    const response = await registerWorker(request('/api/workers',{name:'Synthetic Worker',position:'Mason',pay_rate:500}));
    expect(response.status).toBe(403);
    expect(mock.service).not.toHaveBeenCalled();
    expect(mock.workerWrite).not.toHaveBeenCalled();
    mock.assuranceError = new Error('offline');
    expect((await registerWorker(request('/api/workers',{name:'Synthetic Worker',position:'Mason',pay_rate:500}))).status).toBe(503);
    expect(mock.service).not.toHaveBeenCalled();
    mock.assurance = true; mock.assuranceError = null;
    mock.workerWrite.mockReturnValue({select: () => ({single: async () => ({data:{id:'synthetic-worker'},error:null})})});
    expect((await registerWorker(request('/api/workers',{name:'Synthetic Worker',position:'Mason',pay_rate:500}))).status).toBe(201);
    expect(mock.service).toHaveBeenCalledTimes(1);
    expect(mock.workerWrite).toHaveBeenCalledTimes(1);
  });

  it('never uses an upsert to overwrite an existing worker from Supervisor registration', async () => {
    mock.workerWrite.mockReturnValue({select: () => ({single: async () => ({data:null,error:{message:'duplicate'}})})});
    const response = await registerWorker(request('/api/workers',{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',name:'Existing',position:'Mason',pay_rate:1}));
    expect(response.status).toBe(400);
    expect(mock.workerWrite).toHaveBeenCalledWith(expect.objectContaining({id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}));
  });

  it('blocks password setup before invoking Auth when the factor is unverified', async () => {
    mock.assurance = false;
    expect((await setupPassword(request('/api/auth/setup-password',{newPassword:'Secure12345'}))).status).toBe(403);
    expect(mock.updateUser).not.toHaveBeenCalled();
    mock.assuranceError = new Error('offline');
    expect((await setupPassword(request('/api/auth/setup-password',{newPassword:'Secure12345'}))).status).toBe(503);
    expect(mock.updateUser).not.toHaveBeenCalled();
    mock.assurance = true; mock.assuranceError = null;
    mock.updateUser.mockResolvedValue({error:null});
    expect((await setupPassword(request('/api/auth/setup-password',{newPassword:'Secure12345'}))).status).toBe(200);
    expect(mock.updateUser).toHaveBeenCalledTimes(1);
  });
});
