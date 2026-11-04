import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { getLoginAssurance } from '@/lib/auth/login-assurance';

const mock = vi.hoisted(() => ({
  otp: vi.fn(), user: {id:'user-1', user_metadata:{}} as null | {id:string; user_metadata:Record<string,unknown>},
  assurance: true as unknown, assuranceError: null as unknown, updateUser: vi.fn(),
}));
vi.mock('@/lib/supabase/server', () => ({ createServerSupabaseClient: () => ({
  auth: {
    signInWithOtp: mock.otp,
    getUser: async () => ({data:{user:mock.user}, error:mock.user ? null : new Error('missing')}),
    updateUser: mock.updateUser,
  },
  rpc: async () => ({data:mock.assurance,error:mock.assuranceError}),
}) }));
vi.mock('@/lib/api/rateLimitGuard', () => ({enforceRateLimit: () => null}));
import { POST as requestCode } from '@/app/api/auth/email-code/route';
import { POST as updatePassword } from '@/app/api/auth/recovery-password/route';
function req(path:string, body:unknown) { return new NextRequest(`https://example.test${path}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}); }

beforeEach(() => {
  vi.clearAllMocks(); mock.user={id:'user-1',user_metadata:{}}; mock.assurance=true; mock.assuranceError=null;
  mock.otp.mockResolvedValue({data:{},error:null}); mock.updateUser.mockResolvedValue({error:null});
  delete process.env.EMAIL_CODE_SIGNIN_ENABLED;
});

describe('email-code recovery preparation', () => {
  it('is disabled until deliberately enabled and never creates accounts', async () => {
    expect((await requestCode(req('/api/auth/email-code',{email:'person@example.test'}))).status).toBe(503);
    expect(mock.otp).not.toHaveBeenCalled();
    process.env.EMAIL_CODE_SIGNIN_ENABLED='true';
    const response=await requestCode(req('/api/auth/email-code',{email:' Person@Example.Test '}));
    expect(response.status).toBe(200);
    expect(mock.otp).toHaveBeenCalledWith({email:'person@example.test',options:{shouldCreateUser:false}});
    expect(response.headers.get('cache-control')).toContain('no-store');
  });
  it('gives the same generic response for an existing, unknown or unavailable provider', async () => {
    process.env.EMAIL_CODE_SIGNIN_ENABLED='true';
    const first=await (await requestCode(req('/api/auth/email-code',{email:'existing@example.test'}))).json();
    mock.otp.mockResolvedValueOnce({data:null,error:{message:'Signups not allowed for otp'}});
    const second=await (await requestCode(req('/api/auth/email-code',{email:'unknown@example.test'}))).json();
    mock.otp.mockRejectedValueOnce(new Error('offline'));
    const third=await (await requestCode(req('/api/auth/email-code',{email:'other@example.test'}))).json();
    expect(first).toEqual(second); expect(second).toEqual(third);
  });
  it('fails closed when the enrolled factor cannot be established', async () => {
    const listFactors=vi.fn(async () => ({data:{totp:[{id:'f1',status:'verified'}]},error:null}));
    const client={rpc:vi.fn(async()=>({data:true as unknown,error:null as unknown})),auth:{mfa:{listFactors}}};
    expect(await getLoginAssurance(client)).toEqual({kind:'ready'});
    expect(listFactors).not.toHaveBeenCalled();
    client.rpc.mockResolvedValue({data:false,error:null});
    expect(await getLoginAssurance(client)).toEqual({kind:'challenge',factorId:'f1'});
    listFactors.mockResolvedValueOnce({data:{totp:[]},error:null});
    expect(await getLoginAssurance(client)).toEqual({kind:'unavailable'});
    client.rpc.mockResolvedValue({data:null,error:new Error('down')});
    expect(await getLoginAssurance(client)).toEqual({kind:'unavailable'});
  });
  it('requires authenticated assurance before changing a password', async () => {
    mock.user=null;
    expect((await updatePassword(req('/api/auth/recovery-password',{newPassword:'Secure12345'}))).status).toBe(401);
    mock.user={id:'user-1',user_metadata:{}}; mock.assurance=false;
    expect((await updatePassword(req('/api/auth/recovery-password',{newPassword:'Secure12345'}))).status).toBe(403);
    mock.assuranceError=new Error('offline');
    expect((await updatePassword(req('/api/auth/recovery-password',{newPassword:'Secure12345'}))).status).toBe(503);
    expect(mock.updateUser).not.toHaveBeenCalled();
    mock.assurance=true; mock.assuranceError=null;
    expect((await updatePassword(req('/api/auth/recovery-password',{newPassword:'x'}))).status).toBe(400);
    expect((await updatePassword(req('/api/auth/recovery-password',{newPassword:'Secure12345'}))).status).toBe(200);
    expect(mock.updateUser).toHaveBeenCalledWith({password:'Secure12345'});
  });
  it('completes mandatory temporary-password setup only when a password is actually changed', async () => {
    mock.user={id:'user-1',user_metadata:{must_change_password:true,keep:'value'}};
    expect((await updatePassword(req('/api/auth/recovery-password',{newPassword:'Secure12345'}))).status).toBe(200);
    expect(mock.updateUser).toHaveBeenCalledWith(expect.objectContaining({password:'Secure12345',data:expect.objectContaining({must_change_password:false,keep:'value'})}));
  });
});
