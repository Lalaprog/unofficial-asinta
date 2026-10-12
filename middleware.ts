import { NextResponse, type NextRequest } from 'next/server';
import { createMiddlewareSupabaseClient } from '@/lib/supabase/middleware';
import { canRoleAccessPath, getSafeRedirectPath, isFounderOnlyPath, type AppRole } from '@/lib/auth/routes';
import { isMfaEnforcementEnabled } from '@/lib/auth/mfa';

/**
 * Route protection middleware.
 *
 * 1. "/" is the canonical authentication URL (unified role-aware login).
 *    Legacy /login portals permanently redirect there.
 * 2. Refreshes the Supabase auth session cookies on every request
 *    (via @supabase/ssr) so the authenticated user's JWT stays in sync.
 * 3. Validates the session server-side with `supabase.auth.getUser()`.
 * 4. Loads the user's database role from `public.users` and enforces the
 *    Founder-only route policy (PostgreSQL RLS remains the last line of
 *    defense for every data query).
 */

function redirectTo(request: NextRequest, pathname: string, params?: Record<string, string>) {
  const url = request.nextUrl.clone();
  url.pathname = pathname;
  url.search = '';
  url.hash = '';
  if (params) {
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  }
  return NextResponse.redirect(url);
}

/** Redirects to a sanitized same-site path (may carry its own query string). */
function redirectToSafePath(request: NextRequest, safePath: string) {
  const url = new URL(safePath, request.nextUrl.origin);
  const target = request.nextUrl.clone();
  target.pathname = url.pathname;
  target.search = url.search;
  target.hash = url.hash;
  return NextResponse.redirect(target);
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Legacy login portals (/login, /login/admin, /login/supervisor, …) are
  // permanently redirected to the canonical "/" login. Query parameters such
  // as redirect_to and error are preserved.
  if (pathname === '/login' || pathname.startsWith('/login/')) {
    const url = request.nextUrl.clone();
    url.pathname = '/';
    return NextResponse.redirect(url, 308);
  }

  // API routes and public static assets: only refresh session cookies.
  if (
    pathname.startsWith('/api') ||
    pathname.startsWith('/_next') ||
    pathname.startsWith('/brand/') ||
    pathname === '/favicon.ico' ||
    pathname === '/icon.svg' ||
    /\.(?:svg|png|jpg|jpeg|gif|webp|ico)$/i.test(pathname)
  ) {
    const { response } = createMiddlewareSupabaseClient(request);
    return response;
  }

  const { supabase, response } = createMiddlewareSupabaseClient(request);

  // Validate the session against the Supabase auth server (never trust the
  // cookie contents alone) and refresh tokens when needed.
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  // "/" — the unified login. Unauthenticated visitors see the form;
  // authenticated users are forwarded to their role-based workspace.
  if (pathname === '/') {
    if (userError || !user) {
      return response;
    }

    const { data: profile } = await supabase
      .from('users')
      .select('id, role')
      .eq('id', user.id)
      .maybeSingle();

    const role = profile?.role as string | undefined;
    if (role !== 'founder' && role !== 'supervisor') {
      // Authenticated but without a valid BALE profile — render the login
      // page (the client auth context surfaces the error and cleans up).
      return response;
    }

    const requestedPath = getSafeRedirectPath(request.nextUrl.searchParams.get('redirect_to'));
    const fallback = role === 'founder' ? '/dashboard' : '/attendance';
    const destination =
      requestedPath && canRoleAccessPath(role as AppRole, requestedPath) ? requestedPath : fallback;
    return redirectToSafePath(request, destination);
  }

  // Protected application routes.
  if (userError || !user) {
    const returnTo = getSafeRedirectPath(`${pathname}${request.nextUrl.search || ''}`);
    return redirectTo(request, '/', returnTo ? { redirect_to: returnTo } : undefined);
  }

  // Fast-path role resolution: if we recently verified this exact user.id's
  // role in public.users, reuse the short-lived httpOnly cookie so page
  // navigation doesn't pay a second sequential database round-trip.
  const cachedRoleCookie = request.cookies.get('bale-role-cache')?.value;
  let role: string | null = null;

  if (cachedRoleCookie === `${user.id}:founder`) {
    role = 'founder';
  } else if (cachedRoleCookie === `${user.id}:supervisor`) {
    role = 'supervisor';
  } else {
    const { data: profile, error: profileError } = await supabase
      .from('users')
      .select('id, role')
      .eq('id', user.id)
      .maybeSingle();

    if (profileError || !profile) {
      return redirectTo(request, '/', { error: 'no_profile' });
    }

    role = profile.role as string | null;

    if (role === 'founder' || role === 'supervisor') {
      response.cookies.set('bale-role-cache', `${user.id}:${role}`, {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        maxAge: 300,
      });
    }
  }

  if (role !== 'founder' && role !== 'supervisor') {
    return redirectTo(request, '/', { error: 'invalid_role' });
  }

  // Supervisors may only access the attendance terminal and project pages —
  // they are never redirected into Founder-only routes.
  if (role === 'supervisor' && isFounderOnlyPath(pathname)) {
    return redirectTo(request, '/attendance');
  }

  // Founder MFA. Opt-in via MFA_ENFORCE_FOUNDERS so the firm cannot be locked
  // out before both founders have enrolled; see lib/auth/mfa.ts. The decision is
  // made here (server-side) AND re-checked in requireFounder for API routes —
  // a browser cannot skip it by calling the API directly.
  if (role === 'founder' && isMfaEnforcementEnabled()) {
    try {
      const { data: assurance } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      const verified = assurance?.currentLevel === 'aal2';

      if (!verified && pathname !== '/mfa') {
        return redirectTo(request, '/mfa');
      }
      if (verified && pathname === '/mfa') {
        return redirectTo(request, '/dashboard');
      }
    } catch {
      // If the assurance level cannot be read, fail CLOSED for founder routes:
      // an unreadable MFA state must not silently downgrade to password-only.
      if (pathname !== '/mfa') return redirectTo(request, '/mfa');
    }
  }

  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
