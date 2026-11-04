'use client';

import React, { createContext, useContext, useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { requireSessionAssurance, type AssuranceResult } from '@/lib/auth/session-assurance';
import { User, UserRole } from '@/types';
import { createClient } from '@/lib/supabase/client';
import { DELIBERATE_LOGOUT_STORAGE_KEY } from '@/lib/auth/session';
import { clearRecoveryChoice } from '@/lib/auth/recovery';
import {
  GENERIC_LOGIN_ERROR,
  friendlyAuthError,
  type LoginOutcome,
} from '@/lib/auth/login';

export type SessionAssuranceStatus = 'checking' | 'ready' | 'required' | 'unavailable' | 'signed_out';

interface AuthContextType {
  user: User | null;
  role: UserRole | null;
  isLoading: boolean;
  assurance: SessionAssuranceStatus;
  refreshAssurance: () => Promise<AssuranceResult>;
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
  const [assurance, setAssurance] = useState<SessionAssuranceStatus>('checking');
  const assuranceSequence = useRef(0);
  const profileSequence = useRef(0);

  const refreshAssurance = useCallback(async (): Promise<AssuranceResult> => {
    const sequence = ++assuranceSequence.current;
    setAssurance('checking');
    const result = await requireSessionAssurance(supabase);
    if (sequence !== assuranceSequence.current) {
      return { ok: false, status: 503, error: 'Your session changed. Please try again.' };
    }
    setAssurance(result.ok ? 'ready' : result.status === 403 ? 'required' : 'unavailable');
    return result;
  }, [supabase]);

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
      const initialProfileSequence = profileSequence.current;
      const { data: { session }, error } = await supabase.auth.getSession();
      if (!mounted || initialProfileSequence !== profileSequence.current) return;

      if (error || !session?.user) {
        setUser(null);
        loadedProfileIdRef.current = null;
        ++assuranceSequence.current;
        setAssurance('signed_out');
        setIsLoading(false);
        return;
      }

      const profileSequenceAtStart = profileSequence.current;
      try {
        const { profile, error: profileError } = await fetchProfile(session.user.id);
        if (!mounted || profileSequenceAtStart !== profileSequence.current) return;

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
      const profileEvent = event === 'SIGNED_OUT' || !session?.user || event === 'SIGNED_IN' || event === 'INITIAL_SESSION'
        ? ++profileSequence.current : profileSequence.current;
      const assuranceEvent = ++assuranceSequence.current;
      if (event === 'SIGNED_OUT' || !session?.user) {
        loadedProfileIdRef.current = null;
        setUser(null);
        setAssurance('signed_out');
        setIsLoading(false);
        return;
      }

      // Do not call Supabase inside its auth callback: its session lock may
      // still be held. Invalidate prior results immediately, then check later.
      setAssurance('checking');
      window.setTimeout(() => {
        if (mounted && assuranceSequence.current === assuranceEvent) void refreshAssurance();
      }, 0);

      if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION') {
        // A different account must never see the previous account's cached
        // ledger while its own profile and assurance are resolving.
        if (loadedProfileIdRef.current && loadedProfileIdRef.current !== session.user.id) {
          loadedProfileIdRef.current = null;
          setUser(null);
          setIsLoading(true);
        }
        // Skip when this profile was already resolved by `login()` to avoid
        // duplicate requests.
        if (loadedProfileIdRef.current === session.user.id) return;

        supabase
          .from('users')
          .select('id, name, email, role, created_at')
          .eq('id', session.user.id)
          .maybeSingle()
          .then(async ({ data, error }) => {
            if (!mounted || profileSequence.current !== profileEvent) return;
            setIsLoading(false);
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

  // Covers initial hydration even when no auth event is emitted by a client.
  useEffect(() => {
    if (user) void refreshAssurance();
  }, [user?.id, refreshAssurance]); // eslint-disable-line react-hooks/exhaustive-deps

  const login = async (
    email: string,
    password: string,
    captchaToken?: string
  ): Promise<{ success: boolean; error?: string; role?: UserRole }> => {
    if (!email || !password) {
      return { success: false, error: 'Email and password are required.' };
    }

    ++assuranceSequence.current;
    setAssurance('checking');
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
      if (!payload.session?.access_token || !payload.session?.refresh_token) {
        return { success: false, error: 'Unable to establish your session. Please try again.' };
      }
      const { error: sessionError } = await supabase.auth.setSession({
        access_token: payload.session.access_token,
        refresh_token: payload.session.refresh_token,
      });
      if (sessionError) return { success: false, error: 'Unable to establish your session. Please try again.' };

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
    clearRecoveryChoice();
    ++profileSequence.current;
    ++assuranceSequence.current;
    setAssurance('signed_out');
    setUser(null);
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
        assurance,
        refreshAssurance,
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
