import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { LoginOutcome } from '@/lib/auth/login';

const mocks = vi.hoisted(() => ({ commit: vi.fn(), guarded: vi.fn() }));
vi.mock('@/lib/supabase/login-buffer', () => ({
  createBufferedLoginClient: () => ({ client: {}, commit: mocks.commit }),
}));
vi.mock('@/lib/auth/login-cooldown', () => ({
  createLoginCooldownStore: vi.fn(),
  guardedLogin: mocks.guarded,
}));
import { POST } from '@/app/api/auth/login/route';

const request = () => new NextRequest('https://example.test/api/auth/login', {
  method:'POST', headers:{'content-type':'application/json','x-forwarded-for':'203.0.113.1'},
  body:JSON.stringify({email:'test@example.test',password:'password'}),
});
beforeEach(() => { mocks.commit.mockReset(); mocks.guarded.mockReset(); });
describe('login route session publication', () => {
  it('only publishes staged auth cookies after a confirmed successful login', async () => {
    const outcomes: LoginOutcome[] = [
      {status:503,body:{ok:false}}, {status:429,body:{ok:false}},
      {status:401,body:{ok:false}}, {status:200,body:{ok:true}},
    ];
    for (const outcome of outcomes) {
      mocks.guarded.mockResolvedValueOnce(outcome);
      const res = await POST(request());
      expect(res.status).toBe(outcome.status);
      expect(res.headers.get('cache-control')).toBe('private, no-store');
      expect(mocks.commit).toHaveBeenCalledTimes(outcome.status===200 ? 1 : 0);
    }
  });
});
