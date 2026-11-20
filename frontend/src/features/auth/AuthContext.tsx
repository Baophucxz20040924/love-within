import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { SESSION_EXPIRED_EVENT, apiRequest, assertCurrentSession, currentAccessEpoch, waitForAbort } from '../../lib/apiClient';
import { spaceStore, type Space } from '../../lib/spaceStore';
import { tokenStore } from '../../lib/tokenStore';
import { commentDraftStore } from '../../lib/commentDraftStore';
import type { AuthTokens, JoinResult, Me } from '../../lib/types';
import { forgetThisDevice } from '../push/device';
import { advanceAccessEpoch } from '../../lib/apiClient';
import { activateAppLock, appLockEpoch, appLockState, bindPasswordLogin, isAuthAttemptCurrent, refreshLockSettings, resetAppLock, subscribeAppLock } from '../appLock/store';

interface PasswordChangeRequired {
  status: 'password_change_required';
  passwordChangeToken: string;
  expiresAt: string;
}
interface RecoveryAttempt extends PasswordChangeRequired {
  target: Space;
  opts?: SessionOptions;
  generation: string;
  epoch: number;
  attempt: number;
  completing: boolean;
}


interface CompletedAuth {
  generation: string;
  attempt: number;
  source: 'login' | 'register' | 'recovery';
}

interface AuthState {
  me: Me | null;
  /** Explicit authentication completed; never emitted by bootstrap or token refresh. */
  completedAuth: CompletedAuth | null;
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
  /** Metadata only; the limited credential is kept in a private ref, never storage/cache/history. */
  passwordChange: { expiresAt: string; target: Space } | null;
  completePasswordChange: (newPassword: string, confirmPassword: string) => Promise<JoinResult | null>;
  cancelPasswordChange: () => void;
  cancelLoginAttempt: () => void;
  logout: () => void;
  refreshMe: () => Promise<void>;
  /** Discard access-sensitive /me data and invalidate older in-flight /me responses. */
  revokeMe: (maskCouple: boolean) => void;
  verifyMe: (signal?: AbortSignal) => Promise<boolean>;
}

interface SessionOptions {
  /** Invite link (/j/<code>): become friends with the inviter while joining the friends space. */
  inviteCode?: string;
  /** Runs synchronously only after the final generation/attempt/PIN guards, including recovery. */
  onJoined?: (joined: JoinResult | null) => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [me, setMe] = useState<Me | null>(null);
  const [completedAuth, setCompletedAuth] = useState<CompletedAuth | null>(null);
  const [loading, setLoading] = useState(true);
  const [bootstrapFailed, setBootstrapFailed] = useState(false);
  const [space, setSpaceState] = useState<Space>(() => spaceStore.get());
  const observedGeneration = useRef(tokenStore.generation());
  const loginAttempt = useRef(0);
  const recovery = useRef<RecoveryAttempt | null>(null);
  const [passwordChange, setPasswordChange] = useState<AuthState['passwordChange']>(null);
  const cancelPasswordChange = useCallback(() => {
    recovery.current = null;
    setPasswordChange(null);
  }, []);
  const credentialsPending = useRef(false);
  // Do not cancel the deliberate hand-off to recovery or an already promoted app session.
  const cancelLoginAttempt = useCallback(() => {
    if (credentialsPending.current) { credentialsPending.current = false; loginAttempt.current += 1; }
  }, []);
  const meEpoch = useRef(0);
  const meFlight = useRef<{ generation: string; epoch: number; promise: Promise<void> } | null>(null);
  const verificationFlight = useRef<{ generation: string; epoch: number; access: number; signal?: AbortSignal; promise: Promise<boolean> } | null>(null);

  const confirmedCouple = useRef<{ generation: string; userId: string; coupleId: string } | null>(null);
  const acceptMe = useCallback((data: Me, generation: string) => {
    const previous = confirmedCouple.current;
    if (previous?.generation === generation && previous.userId === data.user.id && previous.coupleId !== data.couple?.id) {
      commentDraftStore.revokeCouple(generation, previous.userId, previous.coupleId);
    }
    confirmedCouple.current = data.couple ? { generation, userId: data.user.id, coupleId: data.couple.id } : null;
    setMe(data);
  }, []);

  const setSpace = useCallback((s: Space) => {
    spaceStore.set(s);
    setSpaceState(s);
  }, []);

  /**
   * Forget the session: tokens, space and every cached query. Query keys are not per-user, so without
   * clearing the cache the next account on this device would briefly see the previous one's data.
   */
  const clearView = useCallback(() => {
    commentDraftStore.sessionChanged();
    setCompletedAuth(null);
    loginAttempt.current += 1;
    credentialsPending.current = false;
    cancelPasswordChange();
    meEpoch.current += 1;
    setMe(null);
    setBootstrapFailed(false);
    void qc.cancelQueries();
    qc.clear();
  }, [qc, cancelPasswordChange]);

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
    const verification = verificationFlight.current;
    if (verification?.generation === generation && verification.epoch === epoch && verification.access === currentAccessEpoch() && !verification.signal?.aborted) return verification.promise.then(() => undefined);
    if (meFlight.current?.generation === generation && meFlight.current.epoch === epoch) return meFlight.current.promise;
    const promise = (async () => {
      try {
        const data = await apiRequest<Me>('/me', { timeoutMs: 15_000 });
        if (tokenStore.isCurrent(generation) && meEpoch.current === epoch) {
          acceptMe(data, generation);
          setBootstrapFailed(false);
        }
      } catch {
        if (tokenStore.isCurrent(generation) && meEpoch.current === epoch && tokenStore.get()) setBootstrapFailed(true);
      }
    })().finally(() => { if (meFlight.current?.promise === promise) meFlight.current = null; });
    meFlight.current = { generation, epoch, promise };
    return promise;
  }, [acceptMe]);

  const verifyMe = useCallback((signal?: AbortSignal): Promise<boolean> => {
    const generation = tokenStore.generation();
    const access = currentAccessEpoch();
    const existing = verificationFlight.current;
    if (existing?.generation === generation && existing.epoch === meEpoch.current && existing.access === access && !existing.signal?.aborted) {
      return waitForAbort(existing.promise, signal).catch(() => false);
    }
    const epoch = ++meEpoch.current;
    const promise = (async () => {
      try {
        const data = await apiRequest<Me>('/me', { timeoutMs: 15_000, signal });
        if (signal?.aborted || !tokenStore.isCurrent(generation) || meEpoch.current !== epoch || currentAccessEpoch() !== access) return false;
        acceptMe(data, generation);
        setBootstrapFailed(false);
        return true;
      } catch {
        return false;
      }
    })().finally(() => { if (verificationFlight.current?.promise === promise) verificationFlight.current = null; });
    verificationFlight.current = { generation, epoch, access, signal, promise };
    return promise;
  }, [acceptMe]);

  useLayoutEffect(() => {
    const deactivate = activateAppLock();
    let mounted = true;
    void Promise.all([refreshMe(), refreshLockSettings(false)]).finally(() => { if (mounted) setLoading(false); });
    return () => {
      mounted = false;
      setCompletedAuth(null);
      loginAttempt.current += 1;
      credentialsPending.current = false;
      recovery.current = null;
      meEpoch.current += 1;
      advanceAccessEpoch();
      void qc.cancelQueries();
      qc.clear();
      deactivate();
    };
  }, [qc, refreshMe]);

  useEffect(() => {
    if (!passwordChange) return;
    const clear = () => cancelPasswordChange();
    const visibility = () => { if (document.visibilityState !== 'visible') clear(); };
    const timer = window.setTimeout(clear, Math.max(0, Date.parse(passwordChange.expiresAt) - Date.now()));
    window.addEventListener('lw:app-lock', clear);
    window.addEventListener('pagehide', clear);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('lw:app-lock', clear);
      window.removeEventListener('pagehide', clear);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [passwordChange, cancelPasswordChange]);

  useEffect(() => {
    let previous = appLockState().discard;
    let previousEpoch = appLockEpoch();
    let previousPhase = appLockState().phase;
    return subscribeAppLock(() => {
      const next = appLockState().discard;
      const nextEpoch = appLockEpoch();
      if (nextEpoch !== previousEpoch || (next && !previous)) {
        meEpoch.current += 1;
        void qc.cancelQueries();
      }
      if (next && !previous) {
        advanceAccessEpoch();
        qc.clear();
      }
      const resumed = appLockState().phase === 'ready' && previousPhase !== 'ready';
      previous = next;
      previousEpoch = nextEpoch;
      previousPhase = appLockState().phase;
      if (resumed && tokenStore.get()) void refreshMe();
    });
  }, [qc, refreshMe]);

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
      // A queued unrelated storage event must not mark a newly observed session as handled;
      // only the session-generation event itself can acknowledge it.
      const sessionEvent = e.key === null || (e.key && tokenStore.isSessionKey(e.key));
      if (sessionEvent && observedGeneration.current === currentGeneration) return;
      if (sessionEvent) observedGeneration.current = currentGeneration;
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
    async (tokens: AuthTokens, target: Space, opts: SessionOptions | undefined, expectedEpoch: number, attempt: number, source: CompletedAuth['source']): Promise<JoinResult | null> => {
      if (!isAuthAttemptCurrent(expectedEpoch) || attempt !== loginAttempt.current) throw new DOMException('Phiên nhập đã thay đổi.', 'AbortError');
      void qc.cancelQueries();
      qc.clear();
      setMe(null);
      tokenStore.set(tokens);
      commentDraftStore.sessionChanged();
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
      opts?.onJoined?.(joined);
      assertCurrent();
      setCompletedAuth({ generation, attempt, source });
      return joined;
    },
    [qc, refreshMe, setSpace, endSession],
  );

  const login = useCallback(
    async (email: string, password: string, target: Space = 'couple', opts?: SessionOptions) => {
      cancelPasswordChange();
      setCompletedAuth(null);
      const attempt = ++loginAttempt.current;
      credentialsPending.current = true;
      const expectedEpoch = appLockEpoch();
      const generation = tokenStore.generation();
      try {
        const result = await apiRequest<AuthTokens | PasswordChangeRequired>('/auth/login', {
          method: 'POST', body: { email, password }, auth: false,
        });
        assertCurrentSession(generation);
        if (attempt !== loginAttempt.current || !isAuthAttemptCurrent(expectedEpoch)) throw new DOMException('Phiên đăng nhập đã thay đổi.', 'AbortError');
        credentialsPending.current = false;
        if ('status' in result && result.status === 'password_change_required') {
          if (!result.passwordChangeToken || !Number.isFinite(Date.parse(result.expiresAt)) || Date.parse(result.expiresAt) <= Date.now()) throw new Error('Quyền đổi mật khẩu đã hết hạn.');
          // Never pass a limited credential to tokenStore, /me, Friends join, PIN or push.
          recovery.current = { ...result, target, opts, generation, epoch: expectedEpoch, attempt, completing: false };
          setPasswordChange({ expiresAt: result.expiresAt, target });
          return null;
        }
        if (!('accessToken' in result) || !result.accessToken || !result.refreshToken) throw new Error('Phản hồi đăng nhập không hợp lệ.');
        return startSession(result, target, opts, expectedEpoch, attempt, 'login');
      } finally {
        if (attempt === loginAttempt.current) credentialsPending.current = false;
      }
    },
    [startSession, cancelPasswordChange],
  );

  const completePasswordChange = useCallback(async (newPassword: string, confirmPassword: string) => {
    const grant = recovery.current;
    const current = () => grant !== null && recovery.current === grant && grant.attempt === loginAttempt.current &&
      tokenStore.isCurrent(grant.generation) && isAuthAttemptCurrent(grant.epoch) && Date.parse(grant.expiresAt) > Date.now();
    if (!grant || !current() || grant.completing) throw new DOMException('Quyền đổi mật khẩu không còn hiệu lực.', 'AbortError');
    grant.completing = true;
    try {
      const tokens = await apiRequest<AuthTokens>('/auth/password-change', {
        method: 'POST', auth: false,
        body: { passwordChangeToken: grant.passwordChangeToken, newPassword, confirmPassword },
      });
      if (!current()) throw new DOMException('Phiên đăng nhập đã thay đổi.', 'AbortError');
      cancelPasswordChange();
      return await startSession(tokens, grant.target, grant.opts, grant.epoch, grant.attempt, 'recovery');
    } finally {
      grant.completing = false;
    }
  }, [startSession, cancelPasswordChange]);

  const register = useCallback(
    async (email: string, password: string, displayName: string, target: Space = 'couple', opts?: SessionOptions) => {
      cancelPasswordChange();
      setCompletedAuth(null);
      const attempt = ++loginAttempt.current;
      credentialsPending.current = true;
      const expectedEpoch = appLockEpoch();
      const generation = tokenStore.generation();
      try {
        const tokens = await apiRequest<AuthTokens>('/auth/register', {
          method: 'POST', body: { email, password, displayName }, auth: false,
        });
        assertCurrentSession(generation);
        if (attempt !== loginAttempt.current || !isAuthAttemptCurrent(expectedEpoch)) throw new DOMException('Phiên đăng nhập đã thay đổi.', 'AbortError');
        credentialsPending.current = false;
        return startSession(tokens, target, opts, expectedEpoch, attempt, 'register');
      } finally {
        if (attempt === loginAttempt.current) credentialsPending.current = false;
      }
    },
    [startSession, cancelPasswordChange],
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
      completedAuth,
      loading,
      bootstrapError,
      retryBootstrap,
      switchSpace,
      isAuthenticated: me !== null,
      space,
      login,
      register,
      passwordChange,
      completePasswordChange,
      cancelPasswordChange,
      cancelLoginAttempt,
      logout,
      refreshMe,
      revokeMe,
      verifyMe,
    }),
    [me, completedAuth, loading, bootstrapError, retryBootstrap, switchSpace, space, login, register, passwordChange, completePasswordChange, cancelPasswordChange, cancelLoginAttempt, logout, refreshMe, revokeMe, verifyMe],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
