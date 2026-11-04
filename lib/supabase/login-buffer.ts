import { createServerClient, type CookieOptions } from '@supabase/ssr';
import type { NextRequest, NextResponse } from 'next/server';

/**
 * Authentication may create cookies before the shared guard can confirm the
 * result. Buffer them and publish only after the guard has completed. This
 * prevents an unavailable guard from leaking a signed-in browser session.
 */
export function createBufferedLoginClient(request: NextRequest) {
  const staged = new Map<string, { name: string; value: string; options: CookieOptions }>();
  const client = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://localhost:54321',
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'placeholder-anon-key',
    {
      cookies: {
        getAll() {
          const all = new Map(request.cookies.getAll().map(({ name, value }) => [name, { name, value }]));
          for (const { name, value } of staged.values()) all.set(name, { name, value });
          return [...all.values()];
        },
        setAll(items: { name: string; value: string; options: CookieOptions }[]) {
          for (const item of items) staged.set(item.name, item);
        },
      },
    }
  );
  return {
    client,
    commit(response: NextResponse) {
      for (const { name, value, options } of staged.values()) response.cookies.set(name, value, options);
    },
  };
}
