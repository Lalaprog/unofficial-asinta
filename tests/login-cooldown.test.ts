import { describe, expect, it, vi } from 'vitest';
import { guardedLogin, type LoginCooldownStore } from '@/lib/auth/login-cooldown';
import { authenticateLoginRequest, type LoginOutcome, type MinimalLoginSupabaseClient } from '@/lib/auth/login';

const headers = new Headers({ 'x-forwarded-for': '203.0.113.10' });
const payload = { email: ' Person@Example.com ', password: 'wrong' };
const denied: LoginOutcome = { status: 401, guardFailure: true, body: { ok: false, error: 'Invalid credentials' } };
const success: LoginOutcome = { status: 200, body: { ok: true, session: {access_token:'secret-a',refresh_token:'secret-r'} } };
const available = (): LoginCooldownStore => ({
  reserve: vi.fn(async () => ({ allowed: true, retryAfter: 0 })),
  finish: vi.fn(async () => ({ confirmed: true, retryAfter: 0 })),
});
const setup = (store: LoginCooldownStore, authenticate = vi.fn(async () => denied)) => ({
  headers, payload, secret: 'synthetic-secret', makeStore: () => store, authenticate,
  makeToken: () => '00000000-0000-4000-8000-000000000001',
});

describe('shared login cooldown', () => {
  it('hashes the normalized account and network, and classifies a confirmed failure', async () => {
    const store = available();
    const p = setup(store);
    expect((await guardedLogin(p)).status).toBe(401);
    const [bucket, token] = vi.mocked(store.reserve).mock.calls[0];
    expect(bucket).toMatch(/^[a-f0-9]{64}$/);
    expect(bucket).not.toContain('example');
    expect(vi.mocked(store.finish)).toHaveBeenCalledWith(bucket, token, 'failure');
    const other = available();
    await guardedLogin({ ...setup(other), payload: {...payload, email:'person@example.com'} });
    expect(vi.mocked(other.reserve).mock.calls[0][0]).toBe(bucket);
    const elsewhere = available();
    await guardedLogin({ ...setup(elsewhere), headers: new Headers({'x-forwarded-for':'203.0.113.11'}) });
    expect(vi.mocked(elsewhere.reserve).mock.calls[0][0]).not.toBe(bucket);
  });
  it('does not call Auth during a cooldown and sends a retry time', async () => {
    const store = available();
    vi.mocked(store.reserve).mockResolvedValue({ allowed:false, retryAfter: 299 });
    const p = setup(store);
    const result = await guardedLogin(p);
    expect(result.status).toBe(429);
    expect(result.headers?.['Retry-After']).toBe('299');
    expect(p.authenticate).not.toHaveBeenCalled();
  });
  it('fails closed when the database is unavailable or cannot confirm completion', async () => {
    for (const mode of ['reserve', 'finish', 'unconfirmed']) {
      const store = available();
      if (mode === 'reserve') vi.mocked(store.reserve).mockRejectedValue(new Error('down'));
      if (mode === 'finish') vi.mocked(store.finish).mockRejectedValue(new Error('down'));
      if (mode === 'unconfirmed') vi.mocked(store.finish).mockResolvedValue({ confirmed:false, retryAfter:0 });
      const authenticate = vi.fn(async () => success);
      const result = await guardedLogin(setup(store, authenticate));
      expect(result.status).toBe(503);
      expect(result.body.session).toBeUndefined();
      if (mode === 'reserve') expect(authenticate).not.toHaveBeenCalled();
    }
  });
  it('does not count invalid requests, provider failures, or successful logins as failed passwords', async () => {
    const store = available();
    const bad = setup(store);
    expect((await guardedLogin({...bad, payload: {email:'',password:''}})).status).toBe(400);
    expect(store.reserve).not.toHaveBeenCalled();
    expect((await guardedLogin({...bad, headers: new Headers()})).status).toBe(503);
    expect(store.reserve).not.toHaveBeenCalled();
    await guardedLogin(setup(store, vi.fn(async () => ({status:503, body:{ok:false}}))));
    expect(vi.mocked(store.finish).mock.lastCall?.[2]).toBe('unknown');
    await guardedLogin(setup(store, vi.fn(async () => success)));
    expect(vi.mocked(store.finish).mock.lastCall?.[2]).toBe('success');
  });
  it('distinguishes an invalid credential from a provider outage', async () => {
    const mock = (error: {message:string; status:number}): MinimalLoginSupabaseClient => ({
      auth: {signInWithPassword: async () => ({data:{user:null}, error}), signOut:async () => ({})},
      from: () => { throw new Error('not reached'); },
    });
    const common = {payload, headers};
    const rejected = await authenticateLoginRequest({...common, supabase:mock({message:'Invalid login credentials',status:400})});
    expect(rejected.guardFailure).toBe(true);
    const outage = await authenticateLoginRequest({...common, supabase:mock({message:'Internal error',status:500})});
    expect(outage.guardFailure).toBe(false);
  });
});
