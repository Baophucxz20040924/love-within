import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { SESSION_EXPIRED_EVENT, apiRequest, assertCurrentSession } from '../../lib/apiClient';
import { spaceStore, type Space } from '../../lib/spaceStore';
import { tokenStore } from '../../lib/tokenStore';
import type { AuthTokens, JoinResult, Me } from '../../lib/types';
import { forgetThisDevice } from '../push/device';
import { advanceAccessEpoch } from '../../lib/apiClient';
import { appLockEpoch, appLockState, bindPasswordLogin, isAuthAttemptCurrent, refreshLockSettings, resetAppLock, subscribeAppLock } from '../appLock/store';

interface AuthState {
  me: Me | null;
  loading: boolean;
  bootstrapError: boolean;
  retryBootstrap: () => void;
  switchSpace: (target: Space) => void;
  isAuthenticated: boolean;
  /** Couple app, or the hidden friends space (chosen by which login page was used). */
  space: Space;
  /** Friends space: returns what joining did (incl. an invite link's result). */
  login: (email: string, password: string, space?: Space, opts?: SessionOptions) => Promise<JoinResult | null>;
  register: (email: string, password: string, displayName: string, space?: Space, opts?: SessionOptions) => Promise<JoinResult | null>;
  logout: () => void;
  refreshMe: () => Promise<void>;
  /** Discard access-sensitive /me data and invalidate older in-flight /me responses. */
  revokeMe: (maskCouple: boolean) => void;
  verifyMe: () => Promise<boolean>;
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
  const observedGeneration = useRef(tokenStore.generation());
  const loginAttempt = useRef(0);
  const meEpoch = useRef(0);
  const meFlight = useRef<{ generation: string; epoch: number; promise: Promise<void> } | null>(null);

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
    meEpoch.current += 1;
    setMe(null);
    setBootstrapFailed(false);
    void qc.cancelQueries();
    qc.clear();
  }, [qc]);

  const endSession = useCallback(() => {
    tokenStore.clear();
    observedGeneration.current = tokenStore.generation();
    setSpace('couple');
    clearView();
    resetAppLock();
  }, [clearView, setSpace]);

  const revokeMe = useCallback((maskCouple: boolean) => {
    meEpoch.current += 1;
    if (maskCouple) setMe((current) => current ? {
      ...current, couple: null, wallet: null, level: 0, exp: 0,
    } : null);
  }, []);

  const refreshMe = useCallback((): Promise<void> => {
    const generation = tokenStore.generation();
    const epoch = meEpoch.current;
    if (!tokenStore.get()) {
      setMe(null);
      setBootstrapFailed(false);
      return Promise.resolve();
    }
    if (meFlight.current?.generation === generation && meFlight.current.epoch === epoch) return meFlight.current.promise;
    const promise = (async () => {
      try {
        const data = await apiRequest<Me>('/me');
        if (tokenStore.isCurrent(generation) && meEpoch.current === epoch) {
          setMe(data);
          setBootstrapFailed(false);
        }
      } catch {
        if (tokenStore.isCurrent(generation) && meEpoch.current === epoch && tokenStore.get()) setBootstrapFailed(true);
      }
    })().finally(() => { if (meFlight.current?.promise === promise) meFlight.current = null; });
    meFlight.current = { generation, epoch, promise };
    return promise;
  }, []);

  const verifyMe = useCallback(async (): Promise<boolean> => {
    const generation = tokenStore.generation();
    const epoch = ++meEpoch.current;
    try {
      const data = await apiRequest<Me>('/me');
      if (!tokenStore.isCurrent(generation) || meEpoch.current !== epoch) return false;
      setMe(data);
      setBootstrapFailed(false);
      return true;
    } catch {
      return false;
    }
  }, []);

  useEffect(() => {
    void Promise.all([refreshMe(), refreshLockSettings(false)]).finally(() => setLoading(false));
  }, [refreshMe]);

  useEffect(() => {
    let previous = appLockState().discard;
    return subscribeAppLock(() => {
      const next = appLockState().discard;
      if (next && !previous) {
        meEpoch.current += 1;
        advanceAccessEpoch();
        void qc.cancelQueries();
        qc.clear();
      }
      previous = next;
    });
  }, [qc]);

  const switchSpace = useCallback((target: Space) => {
    meEpoch.current += 1;
    advanceAccessEpoch();
    void qc.cancelQueries();
    qc.clear();
    setSpace(target);
    void refreshMe();
  }, [qc, setSpace, refreshMe]);

  // Log out when the refresh token is rejected, or when another tab logs out; follow another tab's space.
  useEffect(() => {
    const onExpired = (e: Event) => {
      if ((e as CustomEvent<string>).detail === tokenStore.generation() && !tokenStore.get()) {
        clearView();
        setSpace('couple');
        resetAppLock();
      }
    };
    const onStorage = (e: StorageEvent) => {
      const currentGeneration = tokenStore.generation();
      if (e.key && tokenStore.isSessionKey(e.key) && observedGeneration.current === currentGeneration) return;
      observedGeneration.current = currentGeneration;
      if (e.key === null || (e.key && tokenStore.isSessionKey(e.key)) ||
          (e.key && tokenStore.isTokenKey(e.key) && e.newValue === null)) {
        // Follow shared storage, never write a clear back and invalidate another tab's newer login.
        clearView();
        setSpaceState(spaceStore.get());
        void refreshMe();
      } else if (e.key && tokenStore.isTokenKey(e.key) && e.newValue !== null) {
        // Follow legacy token writes without clearing an authenticated view.
        // Current sessions read their credentials atomically from the generation record.
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
    async (tokens: AuthTokens, target: Space, opts: SessionOptions | undefined, expectedEpoch: number, attempt: number): Promise<JoinResult | null> => {
      if (!isAuthAttemptCurrent(expectedEpoch)) throw new DOMException('Phiên nhập đã thay đổi.', 'AbortError');
      void qc.cancelQueries();
      qc.clear();
      setMe(null);
      tokenStore.set(tokens);
      observedGeneration.current = tokenStore.generation();
      setSpace(target);
      bindPasswordLogin(target, expectedEpoch);
      const generation = tokenStore.generation();
      const current = () => tokenStore.isCurrent(generation) && isAuthAttemptCurrent(expectedEpoch) && attempt === loginAttempt.current;
      const assertCurrent = () => { if (!current()) throw new DOMException('Phiên nhập đã thay đổi.', 'AbortError'); };
      let joined: JoinResult | null = null;
      if (target === 'friends') {
        try {
          joined = await apiRequest<JoinResult>('/friends/join', {
            method: 'POST',
            body: opts?.inviteCode ? { inviteCode: opts.inviteCode } : {},
          });
        } catch (err) {
          assertCurrent();
          endSession();
          throw err;
        }
        assertCurrent();
      }
      assertCurrent();
      await refreshMe();
      assertCurrent();
      await refreshLockSettings(false);
      assertCurrent();
      return joined;
    },
    [qc, refreshMe, setSpace, endSession],
  );

  const login = useCallback(
    async (email: string, password: string, target: Space = 'couple', opts?: SessionOptions) => {
      const attempt = ++loginAttempt.current;
      const expectedEpoch = appLockEpoch();
      const generation = tokenStore.generation();
      const tokens = await apiRequest<AuthTokens>('/auth/login', {
        method: 'POST',
        body: { email, password },
        auth: false,
      });
      assertCurrentSession(generation);
      if (attempt !== loginAttempt.current) throw new Error('Phiên đăng nhập đã thay đổi.');
      return startSession(tokens, target, opts, expectedEpoch, attempt);
    },
    [startSession],
  );

  const register = useCallback(
    async (email: string, password: string, displayName: string, target: Space = 'couple', opts?: SessionOptions) => {
      const attempt = ++loginAttempt.current;
      const expectedEpoch = appLockEpoch();
      const generation = tokenStore.generation();
      const tokens = await apiRequest<AuthTokens>('/auth/register', {
        method: 'POST',
        body: { email, password, displayName },
        auth: false,
      });
      assertCurrentSession(generation);
      if (attempt !== loginAttempt.current) throw new Error('Phiên đăng nhập đã thay đổi.');
      return startSession(tokens, target, opts, expectedEpoch, attempt);
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

  const bootstrapError = Boolean(!me && bootstrapFailed && tokenStore.get());
  const retryBootstrap = useCallback(() => {
    if (loading) return;
    setLoading(true);
    void refreshMe().finally(() => setLoading(false));
  }, [loading, refreshMe]);
  const value = useMemo<AuthState>(
    () => ({
      me,
      loading,
      bootstrapError,
      retryBootstrap,
      switchSpace,
      isAuthenticated: me !== null,
      space,
      login,
      register,
      logout,
      refreshMe,
      revokeMe,
      verifyMe,
    }),
    [me, loading, bootstrapError, retryBootstrap, switchSpace, space, login, register, logout, refreshMe, revokeMe, verifyMe],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
