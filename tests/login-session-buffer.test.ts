import { describe, it, expect, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import type { CookieOptions } from '@supabase/ssr';

const capture = vi.hoisted(() => ({ cookies: null as null | {
  getAll: () => {name:string;value:string}[];
  setAll: (values: {name:string;value:string;options:CookieOptions}[]) => void;
} }));
vi.mock('@supabase/ssr', () => ({
  createServerClient: (_url: string, _key: string, config: {cookies: typeof capture.cookies}) => {
    capture.cookies = config.cookies;
    return {};
  },
}));
import { createBufferedLoginClient } from '@/lib/supabase/login-buffer';

describe('login session buffering', () => {
  it('makes staged cookies visible to the login client without sending them until explicitly committed', () => {
    const request = new NextRequest('https://example.test/api/auth/login', {headers:{cookie:'old=existing'}});
    const buffered = createBufferedLoginClient(request);
    capture.cookies!.setAll([{name:'sb-auth-token', value:'secret-session', options:{httpOnly:true, path:'/'}}]);
    expect(capture.cookies!.getAll()).toContainEqual({name:'old',value:'existing'});
    expect(capture.cookies!.getAll()).toContainEqual({name:'sb-auth-token',value:'secret-session'});
    const rejected = NextResponse.json({ok:false}, {status:503});
    expect(rejected.headers.get('set-cookie')).toBeNull();
    const accepted = NextResponse.json({ok:true});
    buffered.commit(accepted);
    expect(accepted.cookies.get('sb-auth-token')?.value).toBe('secret-session');
    expect(accepted.headers.get('set-cookie')).toContain('HttpOnly');
  });
});
