import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { SESSION_EXPIRED_EVENT, apiRequest, assertCurrentSession } from '../../lib/apiClient';
import { spaceStore, type Space } from '../../lib/spaceStore';
import { tokenStore } from '../../lib/tokenStore';
import type { AuthTokens, JoinResult, Me } from '../../lib/types';
import { forgetThisDevice } from '../push/device';
import { ErrorState, Loading } from '../../components/StatusViews';

interface AuthState {
  me: Me | null;
  loading: boolean;
  isAuthenticated: boolean;
  /** Couple app, or the hidden friends space (chosen by which login page was used). */
  space: Space;
  /** Friends space: returns what joining did (incl. an invite link's result). */
  login: (email: string, password: string, space?: Space, opts?: SessionOptions) => Promise<JoinResult | null>;
  register: (email: string, password: string, displayName: string, space?: Space, opts?: SessionOptions) => Promise<JoinResult | null>;
  logout: () => void;
  refreshMe: () => Promise<void>;
}

interface SessionOptions {
  /** Invite link (/j/<code>): become friends with the inviter while joining the friends space. */
  inviteCode?: string;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [bootstrapFailed, setBootstrapFailed] = useState(false);
  const [space, setSpaceState] = useState<Space>(() => spaceStore.get());
  const loginAttempt = useRef(0);

  const setSpace = useCallback((s: Space) => {
    spaceStore.set(s);
    setSpaceState(s);
  }, []);

  /**
   * Forget the session: tokens, space and every cached query. Query keys are not per-user, so without
   * clearing the cache the next account on this device would briefly see the previous one's data.
   */
  const clearView = useCallback(() => {
    loginAttempt.current += 1;
    setMe(null);
    setBootstrapFailed(false);
    void qc.cancelQueries();
    qc.clear();
  }, [qc]);

  const endSession = useCallback(() => {
    tokenStore.clear();
    setSpace('couple');
    clearView();
  }, [clearView, setSpace]);

  const refreshMe = useCallback(async () => {
    const generation = tokenStore.generation();
    if (!tokenStore.get()) {
      setMe(null);
      setBootstrapFailed(false);
      return;
    }
    try {
      const data = await apiRequest<Me>('/me');
      if (tokenStore.isCurrent(generation)) {
        setMe(data);
        setBootstrapFailed(false);
      }
    } catch {
      // Keep valid credentials on transient bootstrap failure; offer retry instead
      // of redirecting to a login form while the previous session still exists.
      if (tokenStore.isCurrent(generation) && tokenStore.get()) setBootstrapFailed(true);
    }
  }, []);

  useEffect(() => {
    void refreshMe().finally(() => setLoading(false));
  }, [refreshMe]);

  // Log out when the refresh token is rejected, or when another tab logs out; follow another tab's space.
  useEffect(() => {
    const onExpired = (e: Event) => {
      if ((e as CustomEvent<string>).detail === tokenStore.generation() && !tokenStore.get()) {
        clearView();
        setSpace('couple');
      }
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || (e.key && tokenStore.isSessionKey(e.key)) ||
          (e.key && tokenStore.isTokenKey(e.key) && e.newValue === null)) {
        // Follow shared storage, never write a clear back and invalidate another tab's newer login.
        clearView();
        setSpaceState(spaceStore.get());
        void refreshMe();
      } else if (e.key && spaceStore.isSpaceKey(e.key)) setSpaceState(spaceStore.get());
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
      window.removeEventListener('storage', onStorage);
    };
  }, [clearView, refreshMe, setSpace]);

  /** Store the new session. The friends space is joined first, so its API works as soon as the user lands there. */
  const startSession = useCallback(
    async (tokens: AuthTokens, target: Space, opts?: SessionOptions): Promise<JoinResult | null> => {
      void qc.cancelQueries();
      qc.clear();
      setMe(null);
      tokenStore.set(tokens);
      const generation = tokenStore.generation();
      let joined: JoinResult | null = null;
      if (target === 'friends') {
        try {
          joined = await apiRequest<JoinResult>('/friends/join', {
            method: 'POST',
            body: opts?.inviteCode ? { inviteCode: opts.inviteCode } : {},
          });
        } catch (err) {
          if (tokenStore.isCurrent(generation)) endSession();
          throw err;
        }
      }
      assertCurrentSession(generation);
      setSpace(target);
      await refreshMe();
      assertCurrentSession(generation);
      return joined;
    },
    [qc, refreshMe, setSpace, endSession],
  );

  const login = useCallback(
    async (email: string, password: string, target: Space = 'couple', opts?: SessionOptions) => {
      const attempt = ++loginAttempt.current;
      const generation = tokenStore.generation();
      const tokens = await apiRequest<AuthTokens>('/auth/login', {
        method: 'POST',
        body: { email, password },
        auth: false,
      });
      assertCurrentSession(generation);
      if (attempt !== loginAttempt.current) throw new Error('Phiên đăng nhập đã thay đổi.');
      return startSession(tokens, target, opts);
    },
    [startSession],
  );

  const register = useCallback(
    async (email: string, password: string, displayName: string, target: Space = 'couple', opts?: SessionOptions) => {
      const attempt = ++loginAttempt.current;
      const generation = tokenStore.generation();
      const tokens = await apiRequest<AuthTokens>('/auth/register', {
        method: 'POST',
        body: { email, password, displayName },
        auth: false,
      });
      assertCurrentSession(generation);
      if (attempt !== loginAttempt.current) throw new Error('Phiên đăng nhập đã thay đổi.');
      return startSession(tokens, target, opts);
    },
    [startSession],
  );

  const logout = useCallback(() => {
    // Capture old credentials/record synchronously. Cleanup never refreshes or touches a newer login.
    try {
      void forgetThisDevice(tokenStore.get()?.accessToken ?? null).catch(() => undefined);
    } finally {
      endSession();
    }
  }, [endSession]);

  const value = useMemo<AuthState>(
    () => ({
      me,
      loading,
      isAuthenticated: me !== null,
      space,
      login,
      register,
      logout,
      refreshMe,
    }),
    [me, loading, space, login, register, logout, refreshMe],
  );

  const bootstrapError = !me && bootstrapFailed && tokenStore.get();
  return <AuthContext.Provider value={value}>{bootstrapError ? <main className="app-content"><ErrorState title="Chưa kiểm tra được phiên đăng nhập" message="Phiên của bạn vẫn được giữ. Thử tải lại thay vì đăng nhập lại." onRetry={() => { if (loading) return; setLoading(true); void refreshMe().finally(() => setLoading(false)); }} />{loading && <Loading />}</main> : children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
