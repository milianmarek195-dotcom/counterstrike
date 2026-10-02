'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { API_URL, api, setCsrfToken } from './api';

export interface Me {
  user: { id: string; steamId: string; displayName: string; avatarUrl: string | null } | null;
  roles: Array<{ key: string; name: string }>;
  permissions: string[];
  csrfToken: string | null;
}

interface AuthValue {
  me: Me;
  ready: boolean;
  can: (permission: string) => boolean;
  login: (returnTo?: string) => void;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const empty: Me = { user: null, roles: [], permissions: [], csrfToken: null };
const Ctx = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me>(empty);
  const [ready, setReady] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const next = await api<Me>('/auth/me');
      setCsrfToken(next.csrfToken);
      setMe(next);
    } catch {
      setMe(empty);
    } finally {
      setReady(true);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const value = useMemo<AuthValue>(
    () => ({
      me,
      ready,
      can: (p) => me.permissions.includes('*') || me.permissions.includes(p),
      login: (returnTo = '/') => {
        window.location.href = `${API_URL}/v1/auth/steam/login?returnTo=${encodeURIComponent(returnTo)}`;
      },
      logout: async () => {
        await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
        setCsrfToken(null);
        setMe(empty);
      },
      refresh,
    }),
    [me, ready, refresh],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}
