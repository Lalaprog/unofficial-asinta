'use client';

import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { User, UserRole } from '@/types';
import { createClient } from '@/lib/supabase/client';
import { DELIBERATE_LOGOUT_STORAGE_KEY } from '@/lib/auth/session';
import {
  GENERIC_LOGIN_ERROR,
  friendlyAuthError,
  type LoginOutcome,
} from '@/lib/auth/login';

interface AuthContextType {
  user: User | null;
  role: UserRole | null;
  isLoading: boolean;
  login: (
    email: string,
    password: string,
    captchaToken?: string
  ) => Promise<{ success: boolean; error?: string; role?: UserRole }>;
  logout: () => Promise<void>;
  isFounder: boolean;
  isSupervisor: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export { friendlyAuthError };

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const supabase = useMemo(() => createClient(), []);
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const loadedProfileIdRef = useRef<string | null>(null);

  // Fetch the signed-in user's BALE profile (name + database role) from
  // public.users. RLS guarantees a user can only ever read their own row.
  const fetchProfile = async (authUserId: string): Promise<{ profile: User | null; error?: string }> => {
    const { data, error } = await supabase
      .from('users')
      .select('id, name, email, role, created_at')
      .eq('id', authUserId)
      .maybeSingle();

    if (error) {
      return { profile: null, error: error.message };
    }
    return { profile: (data as User) ?? null };
  };

  useEffect(() => {
    let mounted = true;

    const resolveSession = async () => {
      const { data: { session }, error } = await supabase.auth.getSession();
      if (!mounted) return;

      if (error || !session?.user) {
        setUser(null);
        loadedProfileIdRef.current = null;
        setIsLoading(false);
        return;
      }

      try {
        const { profile, error: profileError } = await fetchProfile(session.user.id);
        if (!mounted) return;

        if (profileError) {
          // Network / database failure while resolving the profile.
          console.error('Failed to load BALE profile from public.users:', profileError);
          setUser(null);
        } else if (profile) {
          loadedProfileIdRef.current = profile.id;
          setUser(profile);
        } else {
          // Auth account exists but has no BALE profile row — force sign out.
          await supabase.auth.signOut();
          setUser(null);
        }
      } finally {
        if (mounted) setIsLoading(false);
      }
    };

    resolveSession();

    // Keep the context in sync with Supabase session events (login, logout,
    // token refresh, tab sync).
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT' || !session?.user) {
        loadedProfileIdRef.current = null;
        setUser(null);
        setIsLoading(false);
        return;
      }

      if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION') {
        // Skip when this profile was already resolved by `login()` to avoid
        // duplicate requests.
        if (loadedProfileIdRef.current === session.user.id) return;

        supabase
          .from('users')
          .select('id, name, email, role, created_at')
          .eq('id', session.user.id)
          .maybeSingle()
          .then(async ({ data, error }) => {
            if (!mounted) return;
            if (error) {
              console.error('Failed to load BALE profile from public.users:', error.message);
              setUser(null);
              return;
            }
            if (data) {
              loadedProfileIdRef.current = (data as User).id;
              setUser(data as User);
            } else {
              await supabase.auth.signOut();
              setUser(null);
            }
          });
      }
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const login = async (
    email: string,
    password: string,
    captchaToken?: string
  ): Promise<{ success: boolean; error?: string; role?: UserRole }> => {
    if (!email || !password) {
      return { success: false, error: 'Email and password are required.' };
    }

    setIsLoading(true);
    try {
      // Route sign-in through `/api/auth/login` for the shared cooldown,
      // secondary per-instance IP limit and generic credential errors.
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email.trim().toLowerCase(),
          password,
          ...(captchaToken ? { captchaToken } : {}),
        }),
      });

      const payload = (await response.json().catch(() => ({}))) as LoginOutcome['body'];

      if (!response.ok || !payload.ok || !payload.user) {
        return {
          success: false,
          error: payload.error || GENERIC_LOGIN_ERROR,
        };
      }

      // Hydrate the browser Supabase client so subsequent MFA checks
      // (`getAuthenticatorAssuranceLevel` / `listFactors`) and RLS queries on
      // the client immediately share the server-established session.
      if (payload.session?.access_token && payload.session?.refresh_token) {
        await supabase.auth.setSession({
          access_token: payload.session.access_token,
          refresh_token: payload.session.refresh_token,
        });
      }

      loadedProfileIdRef.current = payload.user.id;
      setUser(payload.user);
      return { success: true, role: payload.user.role };
    } catch (err: any) {
      return { success: false, error: friendlyAuthError(err?.message || 'Authentication failed') };
    } finally {
      setIsLoading(false);
    }
  };

  const logout = async () => {
    // Tell the session watcher this was a choice, so the login page does not
    // claim "you were signed out after inactivity" after a deliberate logout.
    try {
      window.sessionStorage.setItem(DELIBERATE_LOGOUT_STORAGE_KEY, '1');
    } catch {
      // Non-fatal: the worst case is a slightly confusing notice.
    }
    await supabase.auth.signOut();
    loadedProfileIdRef.current = null;
    setUser(null);
  };

  const role = user?.role || null;
  const isFounder = role === 'founder';
  const isSupervisor = role === 'supervisor';

  return (
    <AuthContext.Provider
      value={{
        user,
        role,
        isLoading,
        login,
        logout,
        isFounder,
        isSupervisor,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
