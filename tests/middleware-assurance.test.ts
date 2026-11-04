import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
const mock = vi.hoisted(() => ({ decision: true as unknown, error: null as unknown, user: true, role: 'founder' }));
vi.mock('@/lib/supabase/middleware', () => ({
  createMiddlewareSupabaseClient: () => ({
    response: NextResponse.next(),
    supabase: {
      auth: { getUser: async () => ({data:{user:mock.user ? {id:'user-1'} : null},error:mock.user ? null : new Error('missing')}) },
      rpc: async () => ({data:mock.decision,error:mock.error}),
      from: () => ({select: () => ({eq: () => ({maybeSingle: async () => ({data:{id:'user-1',role:mock.role},error:null})})})}),
    },
  }),
}));
import { middleware } from '@/middleware';
beforeEach(() => { mock.decision=true; mock.error=null; mock.user=true; mock.role='founder'; });
function request(path:string) { return new NextRequest(`https://example.test${path}`); }

describe('middleware assurance', () => {
  it('keeps partially authenticated users at the challenge page across refresh and direct navigation', async () => {
    mock.decision=false;
    const root=await middleware(request('/'));
    expect(root.status).toBe(200);
    const page=await middleware(request('/payroll?view=all'));
    expect(page.status).toBe(307);
    expect(new URL(page.headers.get('location')!).pathname).toBe('/');
    expect(new URL(page.headers.get('location')!).searchParams.get('redirect_to')).toBe('/payroll?view=all');
    mock.role='supervisor';
    expect((await middleware(request('/attendance'))).status).toBe(307);
  });
  it('fails closed when assurance is unavailable or malformed', async () => {
    for (const decision of [null, 'true', 1]) {
      mock.decision=decision;
      expect((await middleware(request('/dashboard'))).status).toBe(307);
      expect((await middleware(request('/'))).status).toBe(200);
    }
    mock.decision=true; mock.error=new Error('database offline');
    expect((await middleware(request('/dashboard'))).status).toBe(307);
  });
  it('permits fully verified or unenrolled sessions and preserves role navigation', async () => {
    expect((await middleware(request('/dashboard'))).status).toBe(200);
    expect(new URL((await middleware(request('/'))).headers.get('location')!).pathname).toBe('/dashboard');
    mock.role='supervisor';
    expect((await middleware(request('/attendance'))).status).toBe(200);
    expect(new URL((await middleware(request('/payroll'))).headers.get('location')!).pathname).toBe('/attendance');
  });
  it('keeps unauthenticated visitors on sign-in and outside protected pages', async () => {
    mock.user=false;
    expect((await middleware(request('/'))).status).toBe(200);
    expect((await middleware(request('/attendance'))).status).toBe(307);
  });
});
