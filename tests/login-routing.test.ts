import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from '@/middleware';
import { canRoleAccessPath, getSafeRedirectPath, isFounderOnlyPath } from '@/lib/auth/routes';

const BASE = 'http://localhost:3000';

describe('safe redirect_to handling', () => {
  it('accepts only relative paths beginning with exactly one slash', () => {
    expect(getSafeRedirectPath('/dashboard')).toBe('/dashboard');
    expect(getSafeRedirectPath('/attendance?tab=history')).toBe('/attendance?tab=history');
  });

  it('rejects absolute, protocol-relative, backslash, and malformed URLs', () => {
    expect(getSafeRedirectPath('https://evil.example.com')).toBeNull();
    expect(getSafeRedirectPath('http://evil.example.com/x')).toBeNull();
    expect(getSafeRedirectPath('//evil.example.com')).toBeNull();
    expect(getSafeRedirectPath('/\\evil.example.com')).toBeNull();
    expect(getSafeRedirectPath('\\evil')).toBeNull();
    expect(getSafeRedirectPath('javascript:alert(1)')).toBeNull();
    expect(getSafeRedirectPath('')).toBeNull();
    expect(getSafeRedirectPath(null)).toBeNull();
  });
});

describe('role-based path access', () => {
  it('keeps Founder-only pages restricted while allowing Supervisors into the role-scoped Bale requests page', () => {
    expect(isFounderOnlyPath('/dashboard')).toBe(true);
    expect(isFounderOnlyPath('/invoices')).toBe(true);
    expect(isFounderOnlyPath('/reminders')).toBe(true);
    expect(isFounderOnlyPath('/settings')).toBe(false);
    expect(isFounderOnlyPath('/advances')).toBe(true);
    expect(canRoleAccessPath('supervisor', '/dashboard')).toBe(false);
    expect(canRoleAccessPath('supervisor', '/invoices')).toBe(false);
    expect(canRoleAccessPath('supervisor', '/attendance')).toBe(true);
    expect(canRoleAccessPath('supervisor', '/settings')).toBe(true);
    expect(canRoleAccessPath('supervisor', '/advances')).toBe(true);
    expect(canRoleAccessPath('supervisor', '/advances?tab=requests')).toBe(true);
    expect(canRoleAccessPath('supervisor', '/advances?tab=issued')).toBe(false);
    expect(canRoleAccessPath('supervisor', '/advances?tab=other')).toBe(false);
    expect(canRoleAccessPath('founder', '/dashboard')).toBe(true);
    expect(canRoleAccessPath('founder', '/advances?tab=issued')).toBe(true);
    expect(canRoleAccessPath('founder', '/attendance')).toBe(true);
  });
});

describe('middleware: legacy login routes', () => {
  it('permanently (308) redirects /login to /', async () => {
    const res = await middleware(new NextRequest(`${BASE}/login`));
    expect(res.status).toBe(308);
    expect(new URL(res.headers.get('location') as string).pathname).toBe('/');
  });

  it('permanently redirects /login/admin and /login/supervisor to /', async () => {
    for (const path of ['/login/admin', '/login/supervisor']) {
      const res = await middleware(new NextRequest(`${BASE}${path}`));
      expect(res.status).toBe(308);
      expect(new URL(res.headers.get('location') as string).pathname).toBe('/');
    }
  });

  it('preserves query parameters through the permanent redirect', async () => {
    const res = await middleware(new NextRequest(`${BASE}/login?redirect_to=%2Finvoices`));
    expect(res.status).toBe(308);
    const location = new URL(res.headers.get('location') as string);
    expect(location.pathname).toBe('/');
    expect(location.searchParams.get('redirect_to')).toBe('/invoices');
  });
});

describe('middleware: unauthenticated access', () => {
  it('renders the unified login at / without redirecting', async () => {
    const res = await middleware(new NextRequest(`${BASE}/`));
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
  });

  it('redirects protected routes to /?redirect_to=<safe-relative-path>', async () => {
    const res = await middleware(new NextRequest(`${BASE}/dashboard`));
    expect([302, 307]).toContain(res.status);
    const location = new URL(res.headers.get('location') as string);
    expect(location.pathname).toBe('/');
    expect(location.searchParams.get('redirect_to')).toBe('/dashboard');
  });

  it('keeps the query string in redirect_to', async () => {
    const res = await middleware(new NextRequest(`${BASE}/attendance?tab=history`));
    const location = new URL(res.headers.get('location') as string);
    expect(location.searchParams.get('redirect_to')).toBe('/attendance?tab=history');
  });
});
